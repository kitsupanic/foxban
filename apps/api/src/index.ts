import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  APP_NAME,
  ATTACHMENT_POLICY,
  BoardColorSchema,
  BoardAccessModeSchema,
  BoardIconSchema,
  attachmentMaxBytes,
  isPreviewableImageContentType,
  REALTIME_PROTOCOL_VERSION,
  normalizeAttachmentContentType,
} from "@foxban/shared";
import {
  boardExists,
  isAdminEmail,
  appOrigin,
  rateLimitLookup,
  requireAuth,
  requireMember,
  findAccessibleBoard,
  findAccessibleBoardByKey,
  SESSION_USER_COLS,
  toAuthUser,
  toSessionUser,
  BOARD_SELECT_COLS,
  recheckSessionAfterUpgrade,
  requestSessionHash,
  revokeRealtimeSessions,
  boardManageSql,
  boardMemberIdsSql,
  boardOpenSql,
  toBoardRow,
  type AppEnv,
  type BoardRow,
  type RawBoardRecord,
  type SessionUser,
  type SessionUserRow,
} from "./auth";
import {
  GITHUB_WEBHOOK_PATH,
  loadInstanceGitHubApp,
} from "./github-app";
import { OPS_CEILING, drainBackfill } from "./github-backfill";
import { readCardDevelopment, readPullRequest } from "./github-development";
import { findConnectedRepo, listConnectedRepos } from "./github-repos";
import { handleGitHubWebhook } from "./github-webhook";
import {
  ATTACHMENT_ID,
  ATTACHMENT_TRANSFER_ID,
  attachmentObjectKey,
  parseAttachmentObjectKey,
  userAvatarObjectKey,
  parseAvatarObjectKey,
} from "./attachment-lifecycle";
import { INTERNAL_IS_ADMIN_HEADER, INTERNAL_SESSION_HASH_HEADER, INTERNAL_TIMEZONE_HEADER, INTERNAL_USER_ID_HEADER, upgradeHeaders } from "./internal-headers";
import { boardClient } from "./board-client";
import { boardDestination, boardSource, run as runCardTransfer } from "./card-transfer";
import type { WriteBackCard } from "./board-api";
import {
  createBranchRef,
  createInstallationToken,
  createPullRequest,
  getBranch,
  getPullRequestForBranch,
  getRepository,
  parsePullRequestReference,
  GitHubApiError,
  type GitHubPullRequestRef,
} from "./github";
import { agentCredentialsRouter, handleMcpRequest } from "./mcp";
import { BoardKeySchema } from "./mcp-contract";
import { readBoundedBody } from "./agent-credentials";
import { ACCESS_CHANGE_ABORT, ACCESS_CONFLICT, accessChangesRouter, recoverAccessChanges, resolveAccessChangeAttempt, runAccessChange, AccessChangeConflict } from "./access-changes";
import { workspacesRouter } from "./workspaces";
import { adminRouter } from "./admin-routes";
import { authRouter, NameSchema, passwordRequired } from "./auth-routes";
const BoardCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  key: BoardKeySchema,
  icon: BoardIconSchema.default("square-kanban"),
  color: BoardColorSchema.default("amber"),
  workspaceId: z.string().min(1).max(64),
  accessMode: BoardAccessModeSchema.optional(),
});
const BoardUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  key: BoardKeySchema,
  icon: BoardIconSchema.optional(),
  color: BoardColorSchema.optional(),
});
const BoardMoveSchema = z.strictObject({
  destinationWorkspaceId: z.string().min(1).max(64),
  expectedWorkspaceId: z.string().min(1).max(64),
  expectedAccessVersion: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
});
const MemberSchema = z.object({ userId: z.string().trim().min(1).max(128), operationId: z.string().uuid().optional() });
const TransferCardSchema = z.strictObject({
  transferId: z.string().trim().regex(ATTACHMENT_TRANSFER_ID),
  destinationBoardId: z.string().trim().min(1).max(64),
  destinationColumnId: z.string().trim().min(1).max(64),
});


export function isValidIanaTimezone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const TimezoneSchema = z
  .string()
  .trim()
  .max(100)
  .refine(isValidIanaTimezone, { message: "invalid IANA timezone" })
  .nullable();

/** PATCH /me updates display name, timezone, and/or disconnects GitHub; the GitHub login is set by OAuth alone. */
const ProfileSchema = z
  .object({
    name: NameSchema.optional(),
    githubLogin: z.null().optional(),
    timezone: TimezoneSchema.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.githubLogin !== undefined ||
      data.timezone !== undefined,
    {
      message: "at least one field is required",
    },
  );


/** Where the sweep resumes: the last R2 key it fully handled (`maintenance_state`), kept only while a run stopped short. */
const RECONCILE_RESUME_KEY = "attachment_reconcile_after";

/**
 * Safety-net GC for historical objects and any future blob that exists without
 * an attachment row or a live provisional lease. Each board's DO makes the
 * keep/delete decision; the global Worker only enumerates R2 keys.
 *
 * Subrequests are counted (rough worst case per object, like `drainBackfill`) and the run stops
 * before `ceiling`; it saves the last key it handled and the next run lists from after it (ADR 0088).
 * A run that reaches the end of the bucket clears the key.
 */
export async function reconcileAttachmentObjects(env: Env, ceiling = OPS_CEILING): Promise<void> {
  const failures = new Set<string>();
  const saved = await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = ?").bind(RECONCILE_RESUME_KEY).first<{ value: string }>();
  let ops = 1;
  let lastKey = saved?.value;
  let outOfBudget = false;
  // Read once per run, not per page: each candidate is rechecked against D1 before its delete anyway.
  let activeAvatars: { map: Map<string, string>; leases: Set<string> } | null = null;
  let avatarReadCounted = false;
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list(cursor !== undefined ? { cursor } : lastKey !== undefined ? { startAfter: lastKey } : undefined);
    ops += 1;
    const attachmentItemsByBoard = new Map<string, { key: string; attachmentId: string }[]>();
    const avatarKeysToCheck: { key: string; userId: string; version: string }[] = [];

    for (const object of listed.objects) {
      const avatar = object.key.startsWith("avatars/") ? parseAvatarObjectKey(object.key) : null;
      const attachment = object.key.startsWith("avatars/") ? null : parseAttachmentObjectKey(object.key);
      // Worst case per object: an avatar is three D1 calls and an R2 delete (and the first reads the user tables twice); an attachment costs its board's one call.
      const cost = avatar ? 4 + (avatarReadCounted ? 0 : 2) : attachment && !attachmentItemsByBoard.has(attachment.boardId) ? 1 : 0;
      if (ops + cost > ceiling) {
        outOfBudget = true;
        break;
      }
      ops += cost;
      if (avatar) avatarReadCounted = true;
      lastKey = object.key;

      if (avatar !== null) {
        avatarKeysToCheck.push({
          key: object.key,
          userId: avatar.userId,
          version: avatar.avatarVersion,
        });
        continue;
      }

      if (attachment === null) continue;
      const items = attachmentItemsByBoard.get(attachment.boardId);
      if (items) items.push({ key: object.key, attachmentId: attachment.attachmentId });
      else attachmentItemsByBoard.set(attachment.boardId, [{ key: object.key, attachmentId: attachment.attachmentId }]);
    }

    if (avatarKeysToCheck.length > 0) {
      if (activeAvatars === null) {
        const { results: activeUsers } = await env.DB.prepare(
          "SELECT id, avatar_version AS avatarVersion FROM users WHERE avatar_version IS NOT NULL",
        ).all<{ id: string; avatarVersion: string }>();
        const { results: activeLeases } = await env.DB.prepare(
          "SELECT user_id AS userId, version FROM avatar_leases WHERE expires_at > ?",
        )
          .bind(Date.now())
          .all<{ userId: string; version: string }>();
        activeAvatars = {
          map: new Map(activeUsers.map((row) => [row.id, row.avatarVersion])),
          leases: new Set(activeLeases.map((l) => `${l.userId}:${l.version}`)),
        };
      }
      const { map: activeAvatarMap, leases: activeLeaseSet } = activeAvatars;

      for (const { key, userId, version } of avatarKeysToCheck) {
        if (activeAvatarMap.get(userId) === version || activeLeaseSet.has(`${userId}:${version}`)) {
          continue;
        }
        const sweepNow = Date.now();
        // Atomically remove/claim the unowned/expired lease before R2 delete so delayed upload/renewal cannot commit.
        await env.DB.prepare(
          "DELETE FROM avatar_leases WHERE user_id = ? AND version = ? AND expires_at <= ?",
        )
          .bind(userId, version, sweepNow)
          .run();

        // Re-check current authoritative ownership before deleting an object classified earlier.
        // A user avatar upload or lease may have committed concurrently.
        const currentOwnership = await env.DB.prepare(
          `SELECT
             (SELECT 1 FROM users WHERE id = ? AND avatar_version = ?) AS isCurrent,
             (SELECT 1 FROM avatar_leases WHERE user_id = ? AND version = ? AND expires_at > ?) AS isLeased`,
        )
          .bind(userId, version, userId, version, Date.now())
          .first<{ isCurrent: number | null; isLeased: number | null }>();

        if (currentOwnership?.isCurrent || currentOwnership?.isLeased) {
          continue;
        }

        await env.ATTACHMENTS.delete(key);
      }

    }

    for (const [boardId, items] of attachmentItemsByBoard) {
      try {
        if (!(await boardClient(env, boardId).reconcileAttachments(items))) failures.add(boardId);
      } catch {
        failures.add(boardId);
      }
    }
    if (outOfBudget) break;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  if (outOfBudget) {
    await env.DB.prepare("INSERT INTO maintenance_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(RECONCILE_RESUME_KEY, lastKey)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM maintenance_state WHERE key = ?").bind(RECONCILE_RESUME_KEY).run();
  }
  // Sweep expired avatar leases
  await env.DB.prepare("DELETE FROM avatar_leases WHERE expires_at <= ?").bind(Date.now()).run();
  // Later pages still run when a board refused; the run fails once, at the end.
  if (failures.size > 0) {
    throw new Error(`attachment reconciliation failed for boards: ${[...failures].join(", ")}`);
  }
}

/** A connected repo as a write-back route uses it. */
type ConnectedRepository = {
  installationId: number;
  id: number;
  owner: string;
  name: string;
  url: string;
};

/** The connected repo a card writes to; the card picks it, since boards own no repo (ADR 0064). */
const RepositoryChoiceSchema = z.strictObject({ repositoryId: z.number().int().positive() });

/** A manual link names its pull request by URL, or by number plus the connected repo it is in. */
const ManualPullRequestLinkBodySchema = z.strictObject({
  pullRequest: z.string().trim().min(1).max(2048),
  repositoryId: z.number().int().positive().optional(),
});

type PullRequestFailureCode =
  | "pr_unavailable"
  | "github_access"
  | "github_rate_limited"
  | "github_error";

const PULL_REQUEST_FAILURE_STATUS = {
  pr_unavailable: 404,
  github_access: 409,
  github_rate_limited: 429,
  github_error: 502,
} as const;

/**
 * One classification for an upstream GitHub read failure. The same verdict feeds
 * the per-card status vocabulary and the link endpoint's HTTP error, so a 404
 * can never be read as absence in one place and failure in another.
 */
function classifyPullRequestFailure(err: unknown): {
  code: PullRequestFailureCode;
  message: string;
  retryAfterMs: number | null;
} {
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return {
        code: "pr_unavailable",
        message: "The pull request could not be read on GitHub.",
        retryAfterMs: null,
      };
    }
    if (err.status === 429 || err.isRateLimited) {
      return {
        code: "github_rate_limited",
        message: "GitHub rate limit reached. Try again later.",
        retryAfterMs: err.retryAfterMs,
      };
    }
    if (err.status === 401 || err.status === 403) {
      return {
        code: "github_access",
        message: "GitHub App no longer has access to this repository. Reconnect it from Boards.",
        retryAfterMs: null,
      };
    }
  }
  return { code: "github_error", message: "GitHub request failed. Try again.", retryAfterMs: null };
}

/**
 * The temporary-pending answer a protected metadata read gives while a reserved
 * access change holds the board: preparation or recovery is still running, so the
 * caller retries instead of reading a fresh timestamp as a released boundary — and
 * never as a denial, which would drop content and drafts the user still has.
 */
function accessPendingResponse() {
  return Response.json(
    { code: "access_change_pending", error: "Board access is changing. Please retry." },
    { status: 503, headers: { "Retry-After": "2" } },
  );
}

/**
 * Recheck after GitHub reads: their latency must not extend a revoked grant. The
 * board's access, the repo's installation and the card must all still be what the
 * write was prepared against.
 */
async function checkGitHubWrite(c: Context<AppEnv>, cardContext: WriteBackCard, repository: ConnectedRepository) {
  const board = c.get("board");
  const currentCard = await boardClient(c.env, board.id).writeBackCard(cardContext.id);
  const currentBoard = await findAccessibleBoard(c.env, c.get("user"), board.id);
  if (!currentBoard) return c.json({ error: "forbidden" } as const, 403);
  if (currentBoard.pendingAccessChange) {
    return accessPendingResponse();
  }
  if (
    currentBoard.accessVersion !== board.accessVersion ||
    currentBoard.key !== board.key ||
    (await findConnectedRepo(c.env, { id: repository.id }))?.installationId !== repository.installationId
  ) {
    return c.json({ error: "board or repository changed; please retry" } as const, 409);
  }
  if (currentCard === null) {
    return c.json({ error: "card not found or archived" } as const, 404);
  }
  if (currentCard === "unreadable") {
    return c.json({ error: "could not read card context" } as const, 500);
  }
  if (currentCard.taskNumber !== cardContext.taskNumber) {
    return c.json({ error: "card changed; please retry" } as const, 409);
  }
  return null;
}

/**
 * What both write-back routes settle before touching GitHub (ADR 0064): the
 * instance App, the picked repo (still connected) and the active card. A
 * `refusal` is the answer to send instead.
 */
async function prepareInstanceWrite(c: Context<AppEnv>, cardId: string, repositoryId: number) {
  const app = await loadInstanceGitHubApp(c.env).catch(() => null);
  if (!app) return { refusal: c.json({ error: "GitHub App integration is not configured" } as const, 503) };
  const connected = await findConnectedRepo(c.env, { id: repositoryId });
  if (!connected) return { refusal: c.json({ error: "that repository is not connected" } as const, 409) };
  const cardContext = await boardClient(c.env, c.get("board").id).writeBackCard(cardId);
  if (cardContext === null) return { refusal: c.json({ error: "card not found or archived" } as const, 404) };
  if (cardContext === "unreadable") return { refusal: c.json({ error: "could not read card context" } as const, 500) };
  const [owner = "", name = ""] = connected.fullName.split("/");
  const repository: ConnectedRepository = { installationId: connected.installationId, id: repositoryId, owner, name, url: `https://github.com/${connected.fullName}` };
  return { app, repository, cardContext };
}

/**
 * Opens the pull request. GitHub's 422 means either a concurrent request already
 * opened one (that one is returned) or the branch has nothing to propose. Quota
 * refusals and non-GitHub errors propagate for the caller's classification.
 */
async function openPullRequest(
  env: Env,
  token: string,
  repository: { owner: string; name: string },
  pull: { title: string; head: string; base: string; body: string },
): Promise<{ pr: GitHubPullRequestRef } | { status: 400 | 409; error: string }> {
  try {
    return { pr: await createPullRequest(env.GITHUB_API_BASE, token, repository.owner, repository.name, pull.title, pull.head, pull.base, pull.body) };
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.isRateLimited || err.status === 429) throw err;
    if (err.status === 422) {
      const winner = await getPullRequestForBranch(env.GITHUB_API_BASE, token, repository.owner, repository.name, pull.head);
      if (winner) return { pr: winner };
    }
    const details = z.object({ errors: z.array(z.unknown()).max(20) }).safeParse(err.data);
    const customMessages = details.success ? details.data.errors.flatMap((detail) => {
      const parsed = z.object({ code: z.literal("custom"), message: z.string().max(500) }).safeParse(detail);
      return parsed.success ? [parsed.data.message] : [];
    }) : [];
    const errMsg = [err.message, ...customMessages].join("\n").toLowerCase();
    if (
      err.status === 422 &&
      (errMsg.includes("no commits") ||
        errMsg.includes("identical") ||
        errMsg.includes("nothing to compare") ||
        errMsg.includes("commits were not found"))
    ) {
      return { status: 409, error: `Push at least one commit to ${pull.head} before creating a pull request.` };
    }
    return { status: 400, error: err.message.slice(0, 200) };
  }
}

/** One answer for a GitHub failure on a write-back route, classified as the per-board routes classify it. */
function githubWriteFailure(c: Context<AppEnv>, err: unknown) {
  const failure = classifyPullRequestFailure(err);
  if (failure.code === "github_rate_limited") {
    if (failure.retryAfterMs !== null) c.header("Retry-After", String(Math.ceil(failure.retryAfterMs / 1000)));
    return c.json({ code: failure.code, error: failure.message } as const, 429);
  }
  if (err instanceof GitHubApiError && (err.status === 404 || err.status === 401 || err.status === 403)) {
    return c.json({ error: "The GitHub App no longer has access to this repository. Ask an Admin to check its installation." } as const, 409);
  }
  return c.json({ error: "transient github error" } as const, 502);
}


// A board grant that is already as asked changes nothing, so it runs no access change: that would fence the board and
// close every socket on it for a no-op, which anyone who can open the board could repeat (ADR 0090). Only while no access
// change holds the board or its workspace: one in flight may still change that, so it goes through runAccessChange and its conflict.
async function isSettledBoardGrant(env: Env, boardId: string, userId: string, granted: boolean): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM boards b
      WHERE b.id = ? AND b.pending_access_operation_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM access_change_scopes s WHERE s.workspace_id = b.workspace_id)
        AND ${granted ? "" : "NOT "}EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?)`,
  ).bind(boardId, userId).first();
  return row !== null;
}

// A browser write or socket upgrade from another origin is refused (ADR 0083). Every browser states its origin
// on those (`Sec-Fetch-Site` or `Origin`); the webhook, MCP and other non-browser callers state neither, so they pass.
// Whatever the content type: a form, `text/plain` or an `<a ping>` POST all go out without a preflight.
function isCrossOriginBrowserRequest(c: Context<AppEnv>): boolean {
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  if (!site && !origin) return false;
  if (site === "same-origin") return false;
  return !(origin && (origin === new URL(c.req.url).origin || origin === appOrigin(c.env, c.req.url)));
}
const CROSS_ORIGIN_REFUSED = { error: "cross-origin request refused" } as const;
const app = new Hono<AppEnv>()
  .use((c, next) => (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS" && isCrossOriginBrowserRequest(c) ? Promise.resolve(c.json(CROSS_ORIGIN_REFUSED, 403)) : next()))
  .get("/", (c) => c.json({ ok: true, app: APP_NAME }))
  .route("/workspaces", workspacesRouter)
  .route("/access-changes", accessChangesRouter)
  .route("/me/agent-credentials", agentCredentialsRouter)
  .all("/mcp", (c) => handleMcpRequest(c.req.raw, c.env))
  .all("/mcp/*", (c) => c.json({ error: "not found" } as const, 404, { "Cache-Control": "no-store" }))
  .route("/", authRouter)
  .get("/me", requireAuth, (c) => c.json(toAuthUser(c.env, c.get("user"))))
  // Updates display name and/or disconnects GitHub. The response mirrors GET /me
  // so the client can write the `me` cache straight from it — that query never refetches.
  .patch("/me", requireAuth, zValidator("json", ProfileSchema), async (c) => {
    const { name, githubLogin, timezone } = c.req.valid("json");
    const user = c.get("user");
    // Disconnecting would leave no way to sign in (ADR 0065).
    if (githubLogin !== undefined && !user.hasPassword) return c.json(passwordRequired("set a password before disconnecting GitHub"), 403);
    const updates: string[] = [];
    const bindings: (string | null)[] = [];

    if (name !== undefined) {
      updates.push("name = ?");
      bindings.push(name);
    }
    // The schema only admits null, so this is the disconnect: drop the id with the login.
    if (githubLogin !== undefined) updates.push("github_login = NULL", "github_user_id = NULL");
    if (timezone !== undefined) {
      updates.push("timezone = ?");
      bindings.push(timezone);
    }

    const statements: D1PreparedStatement[] = [];
    if (updates.length > 0) {
      bindings.push(user.id);
      statements.push(c.env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...bindings));
    }
    // A linked GitHub id is a sign-in credential (ADR 0065): dropping it ends the other sessions and every agent
    // credential (ADR 0090), as a password change does, in the same batch so an unlinked account never keeps them.
    const sessionHash = await requestSessionHash(c);
    if (githubLogin !== undefined) {
      statements.push(
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, sessionHash),
        c.env.DB.prepare("UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(Date.now(), user.id),
      );
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    if (githubLogin !== undefined) {
      revokeRealtimeSessions(c.env, c.executionCtx, user.id, { exceptSessionHash: sessionHash });
    }

    const updatedUser: SessionUser = {
      ...user,
      ...(name !== undefined ? { name } : {}),
      ...(githubLogin !== undefined ? { githubLogin } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
    return c.json(toAuthUser(c.env, updatedUser));
  })
  .post("/me/avatar", requireAuth, async (c) => {
    const contentType = normalizeAttachmentContentType(c.req.header("content-type"));
    if (!isPreviewableImageContentType(contentType)) {
      return c.json({ error: "unsupported image type" } as const, 415);
    }
    const body = await readBoundedBody(c.req.raw, 10 * 1024 * 1024);
    if (body === null) {
      return c.json({ error: "file exceeds maximum size of 10 MB" } as const, 413);
    }
    if (body.byteLength === 0) {
      return c.json({ error: "file cannot be empty" } as const, 400);
    }

    const user = c.get("user");
    const newVersion = crypto.randomUUID();
    const newKey = userAvatarObjectKey(user.id, newVersion);
    const leaseExpiresAt = Date.now() + 5 * 60 * 1000;
    await c.env.DB.prepare(
      "INSERT INTO avatar_leases(user_id, version, expires_at) VALUES (?, ?, ?)",
    )
      .bind(user.id, newVersion, leaseExpiresAt)
      .run();

    const priorVersion = user.avatarVersion;
    try {
      await c.env.ATTACHMENTS.put(newKey, body, {
        httpMetadata: { contentType },
        customMetadata: { contentType },
      });
      const now = Date.now();
      const renewedLeaseExpiresAt = now + 5 * 60 * 1000;
      const renewResult = await c.env.DB.prepare(
        "UPDATE avatar_leases SET expires_at = ? WHERE user_id = ? AND version = ? AND expires_at > ?",
      )
        .bind(renewedLeaseExpiresAt, user.id, newVersion, now)
        .run();

      if (renewResult.meta.changes !== 1) {
        await c.env.ATTACHMENTS.delete(newKey).catch(() => {});
        return c.json({ error: "avatar upload expired before commit" } as const, 409);
      }

      const commitNow = Date.now();
      const casCondition =
        priorVersion === null ? "avatar_version IS NULL" : "avatar_version = ?";
      const casBindings =
        priorVersion === null
          ? [newVersion, user.id, user.id, newVersion, commitNow]
          : [newVersion, user.id, priorVersion, user.id, newVersion, commitNow];

      const updateStmt = c.env.DB.prepare(
        `UPDATE users
            SET avatar_version = ?
          WHERE id = ?
            AND ${casCondition}
            AND EXISTS (
              SELECT 1 FROM avatar_leases
               WHERE user_id = ? AND version = ? AND expires_at > ?
            )`,
      ).bind(...casBindings);

      const deleteLeaseStmt = c.env.DB.prepare(
        "DELETE FROM avatar_leases WHERE user_id = ? AND version = ?",
      ).bind(user.id, newVersion);

      const verifyStmt = c.env.DB.prepare(
        `SELECT CASE
           WHEN (SELECT avatar_version FROM users WHERE id = ?) = ? THEN 1
           ELSE json('error: cas conflict')
         END`,
      ).bind(user.id, newVersion);

      try {
        await c.env.DB.batch([updateStmt, deleteLeaseStmt, verifyStmt]);
      } catch {
        await c.env.ATTACHMENTS.delete(newKey).catch(() => {});
        await c.env.DB.prepare(
          "DELETE FROM avatar_leases WHERE user_id = ? AND version = ?",
        )
          .bind(user.id, newVersion)
          .run()
          .catch(() => {});
        return c.json({ error: "conflict updating avatar" } as const, 409);
      }
    } catch (err) {
      await c.env.ATTACHMENTS.delete(newKey).catch(() => {});
      await c.env.DB.prepare(
        "DELETE FROM avatar_leases WHERE user_id = ? AND version = ?",
      )
        .bind(user.id, newVersion)
        .run()
        .catch(() => {});
      throw err;
    }

    if (priorVersion !== null) {
      try {
        await c.env.ATTACHMENTS.delete(userAvatarObjectKey(user.id, priorVersion));
      } catch {
        // Deletion of the prior R2 object is best-effort here; scheduled sweep cleans it up.
      }
    }

    const updatedUser: SessionUser = {
      ...user,
      avatarVersion: newVersion,
    };
    return c.json(toAuthUser(c.env, updatedUser));
  })
  .delete("/me/avatar", requireAuth, async (c) => {
    const user = c.get("user");
    const priorVersion = user.avatarVersion;

    if (priorVersion === null) {
      // Caller session had null; query authoritative user in case a concurrent upload occurred.
      const currentUser = await c.env.DB.prepare(`SELECT ${SESSION_USER_COLS} FROM users WHERE id = ?`)
        .bind(user.id)
        .first<SessionUserRow>();

      return c.json(toAuthUser(c.env, currentUser ? toSessionUser(currentUser) : user));
    }

    // Compare-and-set: clear avatar_version only if it still matches priorVersion.
    const result = await c.env.DB.prepare(
      "UPDATE users SET avatar_version = NULL WHERE id = ? AND avatar_version = ?",
    )
      .bind(user.id, priorVersion)
      .run();

    if (result.meta.changes === 1) {
      try {
        await c.env.ATTACHMENTS.delete(userAvatarObjectKey(user.id, priorVersion));
      } catch {
        // Best-effort; sweep cleans up unreferenced avatar objects.
      }
      const updatedUser: SessionUser = {
        ...user,
        avatarVersion: null,
      };
      return c.json(toAuthUser(c.env, updatedUser));
    }

    // CAS changed 0 rows because avatar_version changed concurrently (e.g. upload replaced it).
    // Fetch and return the authoritative current user row with its active version.
    const currentUser = await c.env.DB.prepare(`SELECT ${SESSION_USER_COLS} FROM users WHERE id = ?`)
      .bind(user.id)
      .first<SessionUserRow>();

    return c.json(toAuthUser(c.env, currentUser ? toSessionUser(currentUser) : { ...user, avatarVersion: null }));
  })
  .get("/users/:userId/avatar/:version", requireAuth, async (c) => {
    const userId = c.req.param("userId");
    const version = c.req.param("version");

    const row = await c.env.DB.prepare(
      "SELECT avatar_version AS avatarVersion FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ avatarVersion: string | null }>();

    if (!row || row.avatarVersion !== version) {
      return c.json({ error: "not found" } as const, 404);
    }

    const object = await c.env.ATTACHMENTS.get(userAvatarObjectKey(userId, version));
    if (!object || !object.body) {
      return c.json({ error: "not found" } as const, 404);
    }

    const contentType =
      object.httpMetadata?.contentType ??
      object.customMetadata?.contentType ??
      "application/octet-stream";

    if (!isPreviewableImageContentType(contentType)) {
      return c.json({ error: "not found" } as const, 404);
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (object.httpEtag) {
      headers.set("ETag", object.httpEtag);
    }

    return new Response(object.body, { headers });
  })
  .route("/", adminRouter)
  // GitHub's signed webhooks (ADR 0064): public, authenticated by the signature alone.
  .post(GITHUB_WEBHOOK_PATH, (c) => handleGitHubWebhook(c.env, c.req.raw, c.executionCtx))
  .get("/boards", requireAuth, async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.query("workspaceId");
    const operator = isAdminEmail(c.env, user.email) ? 1 : 0;
    // Operator scope is the workspace page of an Admin outside that workspace. Without
    // a workspace filter, or inside a workspace they belong to, an Admin lists what a
    // member or Guest would: the instance's boards come from an explicit workspace.
    const scoped = operator === 1 && workspaceId !== undefined ? 1 : 0;
    const { results } = await c.env.DB.prepare(
      `SELECT ${BOARD_SELECT_COLS},bm.role AS explicitRole,
              wm.role AS workspaceRole,
              CASE WHEN boards.owner_id=? THEN 1 ELSE 0 END AS ownerAccess,
              ? AS operatorAccess
         FROM boards
         LEFT JOIN board_members bm ON bm.board_id=boards.id AND bm.user_id=?
         LEFT JOIN workspace_members wm ON wm.workspace_id=boards.workspace_id AND wm.user_id=?
        WHERE (? IS NULL OR boards.workspace_id=?)
          AND ${boardOpenSql("boards", "?", "(?=1 AND wm.user_id IS NULL)")}
        ORDER BY boards.created_at,boards.id`,
    ).bind(user.id,operator,user.id,user.id,workspaceId??null,workspaceId??null,scoped,user.id,user.id,user.id).all<RawBoardRecord>();
    return c.json(results.map(toBoardRow));
  })
  .post("/boards", requireAuth, zValidator("json", BoardCreateSchema), async (c) => {
    const { name, key, icon, color, workspaceId, accessMode: requestedAccess } = c.req.valid("json");
    const user = c.get("user");
    const destination = await c.env.DB.prepare(`SELECT w.id,w.name,w.default_board_access AS defaultAccess FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=? WHERE w.id=?`).bind(user.id,workspaceId).first<{id:string;name:string;defaultAccess:"workspace"|"restricted"}>();
    if (!destination) return c.json({ error: "forbidden" } as const, 403);
    const accessMode = requestedAccess ?? destination.defaultAccess;
    const board: BoardRow = {
      id: crypto.randomUUID(), name, key, ownerId: user.id, icon, color,
      workspaceId: destination.id, workspaceName: destination.name,
      accessMode, accessVersion: 0,
      capabilities: { canManageBoard:true },
      viaWorkspaceAdmin: false,
    };
    try {
      const [created] = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO boards(id,name,board_key,owner_id,icon,color,workspace_id,access_mode,created_at)
           SELECT ?,?,?,?,?,?,?,?,?
            WHERE NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=?)
              AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=? AND wm.user_id=?)`,
        ).bind(board.id,board.name,board.key,board.ownerId,board.icon,board.color,board.workspaceId,board.accessMode,Date.now(),board.workspaceId,board.workspaceId,user.id),
        c.env.DB.prepare(`INSERT INTO board_members(board_id,user_id,role) SELECT ?,?,'member' WHERE EXISTS(SELECT 1 FROM boards WHERE id=?)`).bind(board.id,board.ownerId,board.id),
      ]);
      // The destination membership read above happened before this insert could run.
      // The write re-asserts it, so a creation paused across a membership removal
      // lands nothing, and the answer distinguishes the two reasons it can fail.
      if ((created?.meta.changes ?? 0) !== 1) {
        const member = await c.env.DB.prepare(
          `SELECT 1 AS present FROM workspace_members WHERE workspace_id=? AND user_id=?`,
        ).bind(board.workspaceId,user.id).first();
        if (!member) return c.json({ error: "forbidden" } as const, 403);
        return c.json(ACCESS_CONFLICT,409);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("unique") && message.includes("board")) return c.json({ error: "board key already exists" } as const, 409);
      throw error;
    }
    return c.json(board);
  })
  .patch("/boards/:id", requireAuth, zValidator("json", BoardUpdateSchema), async (c) => {
    const user = c.get("user");
    const boardId = c.req.param("id");
    const { name, key, icon, color } = c.req.valid("json");
    const existing = await findAccessibleBoard(c.env,user,boardId);
    if (!existing) {
      if (!(await boardExists(c.env,boardId))) return c.json({ error: "board not found" } as const, 404);
      return c.json({ error: "forbidden" } as const, 403);
    }
    if (!existing.capabilities.canManageBoard) return c.json({ error: "forbidden" } as const, 403);

    const nextIcon = icon ?? existing.icon;
    const nextColor = color ?? existing.color;
    const operator = isAdminEmail(c.env,user.email) ? 1 : 0;
    try {
      // The capability is part of the write. The route's read happened before this
      // request could be paused, so only a predicate evaluated with the write can
      // stop a demoted or moved actor from committing metadata it no longer owns.
      const { meta } = await c.env.DB.prepare(
        `UPDATE boards SET name = ?, board_key = ?, icon = ?, color = ?
          WHERE id = ? AND pending_access_operation_id IS NULL
            AND ${boardManageSql("boards", "?", `${operator}=1`)}`,
      )
        .bind(name, key, nextIcon, nextColor, boardId, user.id, user.id, user.id)
        .run();
      if (meta.changes !== 1) {
        const current = await findAccessibleBoard(c.env, user, boardId);
        if (!current) {
          if (!(await boardExists(c.env, boardId))) return c.json({ error: "board not found" } as const, 404);
          return c.json({ error: "forbidden" } as const, 403);
        }
        if (!current.capabilities.canManageBoard) return c.json({ error: "forbidden" } as const, 403);
        return c.json(ACCESS_CONFLICT, 409);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isUniqueConstraint =
        message.includes("UNIQUE constraint failed") ||
        message.includes("constraint failed") ||
        message.toLowerCase().includes("unique");
      if (
        isUniqueConstraint &&
        (message.includes("boards.board_key") || message.includes("boards_board_key"))
      ) {
        return c.json({ error: "board key already exists" } as const, 409);
      }
      throw error;
    }

    const updated: BoardRow = {
      id: existing.id,
      name,
      key,
      ownerId: existing.ownerId,
      icon: nextIcon,
      color: nextColor,
      workspaceId: existing.workspaceId,
      workspaceName: existing.workspaceName,
      accessMode: existing.accessMode,
      accessVersion: existing.accessVersion,
      capabilities: existing.capabilities,
      viaWorkspaceAdmin: existing.viaWorkspaceAdmin,
    };
    return c.json(updated);
  })
  .delete("/boards/:id", requireAuth, async (c) => {
    const user = c.get("user");
    const boardId = c.req.param("id");

    // New clients send an attempt id; a legacy request without one still gets a
    // journaled, recoverable deletion rather than the old unguarded path.
    const requested = c.req.query("operationId");
    const operationId = requested && z.string().uuid().safeParse(requested).success
      ? requested
      : crypto.randomUUID();
    try {
      // A committed deletion takes the board row with it, so its retry can no
      // longer find the board: the attempt is resolved before any lookup, and a
      // lost response replays the recorded success instead of "board not found".
      const resumed = await resolveAccessChangeAttempt(c.env, user, operationId, "board-delete", {
        boardId,
      });
      if (resumed) {
        if (resumed.state !== "completed") return c.json(resumed, 202);
        if (resumed.outcome === "aborted") {
          const missing = resumed.result === ACCESS_CHANGE_ABORT.boardNotFound;
          return c.json({ error: missing ? "board not found" : "forbidden" } as const, missing ? 404 : 403);
        }
        return c.json({ ok: true as const });
      }
      const board = await findAccessibleBoard(c.env,user,boardId);
      if (!board) {
        if (!(await boardExists(c.env,boardId))) return c.json({ error: "board not found" } as const, 404);
        return c.json({ error: "forbidden" } as const, 403);
      }
      if (!board.capabilities.canManageBoard) return c.json({ error: "forbidden" } as const, 403);

      const result = await runAccessChange(c.env, user, {
        operationId,
        kind: "board-delete",
        payload: { boardId: board.id, workspaceId: board.workspaceId, ownerId: board.ownerId },
        workspaceIds: [board.workspaceId],
        boards: [{ boardId: board.id, workspaceId: board.workspaceId }],
      });
      if (result.state !== "completed") return c.json(result, 202);
      if (result.outcome === "aborted") {
        const missing = result.result === ACCESS_CHANGE_ABORT.boardNotFound;
        return c.json({ error: missing ? "board not found" : "forbidden" } as const, missing ? 404 : 403);
      }
      return c.json({ ok: true as const });
    } catch (error) {
      if (error instanceof AccessChangeConflict)
        return c.json(ACCESS_CONFLICT, 409);
      return c.json({ error: "could not delete board" } as const, 500);
    }
  })
  .post("/boards/:id/move-workspace", requireAuth, zValidator("json", BoardMoveSchema), async (c) => {
    const input=c.req.valid("json"),actor=c.get("user"),boardId=c.req.param("id");
    try{
      // The resolved grantManager flips to `false` once the first attempt has
      // granted it, so a retry must be answered from the journal rather than from a
      // recomputed payload: an inherited mover's exact replay stays exact.
      const resumed=await resolveAccessChangeAttempt(c.env,actor,input.operationId,"board-move",{boardId,destinationWorkspaceId:input.destinationWorkspaceId,expectedWorkspaceId:input.expectedWorkspaceId,expectedAccessVersion:input.expectedAccessVersion});
      if(resumed)return resumed.state!=="completed"?c.json(resumed,202):(resumed.outcome==="aborted"?c.json({error:resumed.result===ACCESS_CHANGE_ABORT.forbidden?"forbidden":"stale board context"} as const,resumed.result===ACCESS_CHANGE_ABORT.forbidden?403:409):c.json(resumed));
      const board=await findAccessibleBoard(c.env,actor,boardId);
      if(!board||!board.capabilities.canManageBoard)return c.json({error:"forbidden"} as const,403);
      // Placing a board where it already is would only collide with its own scope lock (a retryable 409).
      if(board.workspaceId===input.destinationWorkspaceId)return c.json({error:"board is already in that workspace"} as const,400);
      const destination=await c.env.DB.prepare(`SELECT w.id,w.name FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=? WHERE w.id=?`).bind(actor.id,input.destinationWorkspaceId).first<{id:string;name:string}>();
      if(!destination)return c.json({error:"forbidden"} as const,403);
      const explicit=await c.env.DB.prepare(`SELECT role FROM board_members WHERE board_id=? AND user_id=?`).bind(board.id,actor.id).first<{role:"member"|"manager"}>();
      const result=await runAccessChange(c.env,actor,{operationId:input.operationId,kind:"board-move",payload:{boardId:board.id,destinationWorkspaceId:input.destinationWorkspaceId,expectedWorkspaceId:input.expectedWorkspaceId,expectedAccessVersion:input.expectedAccessVersion,ownerId:board.ownerId,grantManager:!isAdminEmail(c.env,actor.email)&&board.ownerId!==actor.id&&explicit?.role!=="manager"},workspaceIds:[board.workspaceId,input.destinationWorkspaceId],boards:[{boardId:board.id,workspaceId:board.workspaceId}]});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return c.json({error:result.result===ACCESS_CHANGE_ABORT.forbidden?"forbidden":"stale board context"} as const,result.result===ACCESS_CHANGE_ABORT.forbidden?403:409);
      return c.json(result);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  .get(
    "/boards/by-key/:key",
    requireAuth,
    zValidator("param", z.object({ key: BoardKeySchema })),
    async (c) => {
      const { key } = c.req.valid("param");
      const board = await findAccessibleBoardByKey(c.env, c.get("user"), key);
      if (!board) return c.json({ error: "forbidden" } as const, 403);
      // Metadata is the reconnect planner's boundary reading: while a change is
      // reserved it answers "retry" instead of a fresh timestamp, which would be
      // taken for a released policy the content surface is not yet under.
      const { pendingAccessChange, ...metadata } = board;
      if (pendingAccessChange) return accessPendingResponse();
      return c.json(metadata);
    },
  )
  .get("/boards/:id", requireAuth, requireMember, (c) => {
    const { pendingAccessChange, ...metadata } = c.get("board");
    if (pendingAccessChange) return accessPendingResponse();
    return c.json(metadata);
  })
  // Anyone who can open the board may add another user to it; removing a board manager takes manage rights (below).
  .post(
    "/boards/:id/members",
    requireAuth,
    requireMember,
    zValidator("json", MemberSchema),
    async (c) => {
      const { userId,operationId } = c.req.valid("json"),board=c.get("board"),actor=c.get("user");
      const attemptId=operationId??crypto.randomUUID();
      try{
        const resumed=await resolveAccessChangeAttempt(c.env,actor,attemptId,"board-member-add",{boardId:board.id,userId});
        if(resumed){if(resumed.state!=="completed")return c.json(resumed,202);return resumed.outcome==="aborted"?c.json({error:resumed.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":"forbidden"} as const,resumed.result===ACCESS_CHANGE_ABORT.boardNotFound?404:403):c.json({ok:true} as const);}
        const invitee=await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first<{id:string}>();
        if(!invitee)return c.json({error:"user not found"} as const,404);
        // Only an explicit row settles an add: a Workspace board's member without one gets a row (it outlives a switch to Private).
        if(await isSettledBoardGrant(c.env,board.id,userId,true))return c.json({ok:true} as const);
        const result=await runAccessChange(c.env,actor,{operationId:attemptId,kind:"board-member-add",payload:{boardId:board.id,userId},workspaceIds:[board.workspaceId],boards:[{boardId:board.id,workspaceId:board.workspaceId}]});
        if(result.state!=="completed")return c.json(result,202);
        if(result.outcome==="aborted")return c.json({error:result.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":"forbidden"} as const,result.result===ACCESS_CHANGE_ABORT.boardNotFound?404:403);
        return c.json({ok:true} as const);
      }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
    },
  )
  .delete("/boards/:id/members/:userId", requireAuth, requireMember, async (c) => {
    const board=c.get("board"),actor=c.get("user"),targetUserId=c.req.param("userId");
    const body = await c.req
      .json<{ operationId?: unknown }>()
      .catch((): { operationId?: unknown } => ({}));
    const operationId=typeof body.operationId==="string"&&z.string().uuid().safeParse(body.operationId).success?body.operationId:crypto.randomUUID();
    try{
      const resumed=await resolveAccessChangeAttempt(c.env,actor,operationId,"board-member-remove",{boardId:board.id,userId:targetUserId});
      if(resumed){if(resumed.state!=="completed")return c.json(resumed,202);return resumed.outcome==="aborted"?c.json({error:resumed.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":"forbidden"} as const,resumed.result===ACCESS_CHANGE_ABORT.boardNotFound?404:403):c.json({ok:true} as const);}
      // The owner's row goes only once they are out of the board's workspace (ADR 0087); the reservation and the commit assert it again.
      if(targetUserId===board.ownerId&&await c.env.DB.prepare("SELECT 1 AS present FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(board.workspaceId,targetUserId).first())return c.json({error:"board owner cannot be removed"} as const,403);
      if(targetUserId===actor.id)return c.json({error:"cannot remove self from board"} as const,403);
      // A board manager is removed only by someone who manages the board (the reservation and the commit assert it again).
      if(!board.capabilities.canManageBoard&&await c.env.DB.prepare("SELECT 1 AS present FROM board_members WHERE board_id=? AND user_id=? AND role='manager'").bind(board.id,targetUserId).first())return c.json({error:"forbidden"} as const,403);
      if(await isSettledBoardGrant(c.env,board.id,targetUserId,false))return c.json({ok:true} as const);
      const result=await runAccessChange(c.env,actor,{operationId,kind:"board-member-remove",payload:{boardId:board.id,userId:targetUserId},workspaceIds:[board.workspaceId],boards:[{boardId:board.id,workspaceId:board.workspaceId}]});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return c.json({error:result.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":"forbidden"} as const,result.result===ACCESS_CHANGE_ABORT.boardNotFound?404:403);
      return c.json({ok:true} as const);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  // Who may be added (ADR 0072): the members of the board's workspace who hold no board grant. A person
  // outside the workspace is offered only for their exact address (`?email=`), so this is no user directory.
  .get("/boards/:id/membership-candidates", requireAuth, requireMember, rateLimitLookup, zValidator("query", z.object({ email: z.string().max(254).transform((value) => value.trim().toLowerCase()).optional() })), async (c) => {
    const board = c.get("board");
    const user = c.get("user");
    const { email } = c.req.valid("query");
    const { results } = await c.env.DB.prepare(
      `SELECT b.pending_access_operation_id AS pendingAccessOperationId,
              users.id AS id, users.email AS email, users.name AS name,
              users.github_login AS githubLogin, users.avatar_version AS avatarVersion
         FROM boards b
         LEFT JOIN users ON users.id NOT IN (
          SELECT board_members.user_id
            FROM board_members
           WHERE board_members.board_id = b.id
        ) AND ${email === undefined ? "users.id IN (SELECT workspace_members.user_id FROM workspace_members WHERE workspace_members.workspace_id = b.workspace_id) AND EXISTS (SELECT 1 FROM workspace_members v WHERE v.workspace_id = b.workspace_id AND v.user_id = ?)" : "users.email = ?"}
        WHERE b.id=? AND ${boardOpenSql("b", "?", "?=1")}
        ORDER BY users.name, users.email`,
    )
      .bind(email === undefined ? user.id : email, board.id, isAdminEmail(c.env, user.email) ? 1 : 0, user.id, user.id, user.id)
      .all<{
        pendingAccessOperationId: string | null;
        id: string | null;
        email: string;
        name: string;
        githubLogin: string | null;
        avatarVersion: string | null;
      }>();
    if (!results.length) return c.json({ error: "forbidden" } as const, 403);
    if (results[0]!.pendingAccessOperationId) {
      c.header("Retry-After", "2");
      return c.json({ code: "access_change_pending", error: "Board access is changing. Please retry." } as const, 503);
    }
    return c.json({ candidates: results.flatMap(({ pendingAccessOperationId: _, ...candidate }) => candidate.id === null ? [] : [{ ...candidate, id: candidate.id }]) });
  })
  .get("/boards/:id/members", requireAuth, requireMember, async (c) => {
    const board=c.get("board");
    const user=c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT b.pending_access_operation_id AS pendingAccessOperationId,
              u.id,u.email,u.name,u.github_login AS githubLogin,u.avatar_version AS avatarVersion,
              bm.role AS explicitRole,
              CASE WHEN b.access_mode='workspace' THEN wm.role ELSE NULL END AS workspaceRole
         FROM boards b
         LEFT JOIN users u ON u.id IN (${boardMemberIdsSql("b")})
         LEFT JOIN board_members bm ON bm.board_id=b.id AND bm.user_id=u.id
         LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=u.id
        WHERE b.id=? AND ${boardOpenSql("b", "?", "?=1")}
        ORDER BY u.name,u.email,u.id`,
    ).bind(board.id,isAdminEmail(c.env,user.email)?1:0,user.id,user.id,user.id).all<{pendingAccessOperationId:string|null;id:string|null;email:string;name:string;githubLogin:string|null;avatarVersion:string|null;explicitRole:"member"|"manager"|null;workspaceRole:"admin"|"member"|null}>();
    if (!results.length) return c.json({error:"forbidden"} as const,403);
    if (results[0]!.pendingAccessOperationId) {
      c.header("Retry-After","2");
      return c.json({code:"access_change_pending",error:"Board access is changing. Please retry."} as const,503);
    }
    return c.json({ members: results.flatMap(({pendingAccessOperationId:_,...member})=>member.id===null?[]:[{...member,id:member.id,isAdmin:isAdminEmail(c.env,member.email)}]) });
  })
  // Raw attachment bytes, not JSON: no zValidator here. The file name travels in
  // the `attachment.create` WS message instead, so R2 never stores or needs it.
  .post("/boards/:id/attachments", requireAuth, requireMember, async (c) => {
    const contentType = normalizeAttachmentContentType(c.req.header("content-type"));
    const maxBytes = attachmentMaxBytes(contentType);
    const body = await readBoundedBody(c.req.raw, maxBytes);
    if (body === null) return c.json({ error: "too large" } as const, 413);
    if (body.byteLength === 0) return c.json({ error: "empty body" } as const, 400);
    const id = crypto.randomUUID();
    const boardId = c.get("board").id;
    const objectKey = attachmentObjectKey(boardId, id);
    const user = c.get("user");
    // The DO records a provisional lease before R2 receives bytes. A tab that
    // closes before `attachment.create` therefore leaves a collectable object,
    // never an untracked one. The caller's identity travels with the staging call:
    // this request may have been buffering for a while, so the DO re-resolves the
    // uploader's current access instead of trusting the middleware's earlier read.
    const staged = await boardClient(c.env, boardId).stageAttachment(user.id, { id });
    if (!staged) return c.json({ error: "could not prepare attachment" } as const, 500);

    // The `boardId/` prefix binds the object to this board: the serve route
    // rebuilds the key from its own validated board, so a member of board A can
    // never read board B's objects even with a leaked uuid.
    await c.env.ATTACHMENTS.put(objectKey, body, {
      httpMetadata: { contentType },
    });
    return c.json({ id, contentType, size: body.byteLength }, 201);
  })
  .get("/boards/:id/attachments/:key", requireAuth, requireMember, async (c) => {
    const key = c.req.param("key");
    if (!ATTACHMENT_ID.test(key)) return c.json({ error: "not found" } as const, 404);
    const boardId = c.get("board").id;
    let resolvedKey: string | null;
    try {
      resolvedKey = await boardClient(c.env, boardId).attachmentKey(key);
    } catch {
      // Guessing `boardId/id` would miss a transferred object and answer a false 404.
      c.header("Retry-After", "2");
      return c.json({ error: "could not read the attachment; please retry" } as const, 503);
    }
    // No row: the pre-lookup key an older upload still lives under.
    const targetKey = resolvedKey ?? attachmentObjectKey(boardId, key);
    const object = await c.env.ATTACHMENTS.get(targetKey);
    if (object === null) return c.json({ error: "not found" } as const, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const storedContentType = object.httpMetadata?.contentType;
    if (storedContentType && isPreviewableImageContentType(storedContentType)) {
      headers.set("Content-Type", storedContentType);
      headers.delete("Content-Disposition");
    } else {
      headers.set("Content-Type", ATTACHMENT_POLICY.fallbackContentType);
      headers.set("Content-Disposition", "attachment");
    }
    // Keys are immutable uuids, so the bytes behind one never change. `private`
    // keeps shared caches out of a membership-checked response.
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  })
  .get("/boards/:id/transfer-options", requireAuth, requireMember, async (c) => {
    const user = c.get("user");
    // A board mid access change would refuse a transfer, so it is not offered.
    const { results } = await c.env.DB.prepare(
      `SELECT boards.id AS id, boards.name AS name, boards.board_key AS key
         FROM boards
        WHERE boards.id != ?
          AND boards.pending_access_operation_id IS NULL
          AND ${boardOpenSql("boards", "?")}
        ORDER BY boards.created_at`,
    )
      .bind(c.get("board").id, user.id, user.id, user.id)
      .all<{ id: string; name: string; key: string }>();
    return c.json({ boards: results });
  })
  // Columns are read per destination, when the dialog selects one, so listing never wakes every board's DO.
  .get("/boards/:id/transfer-options/:destinationBoardId", requireAuth, requireMember, async (c) => {
    const user = c.get("user");
    const destinationBoardId = c.req.param("destinationBoardId");
    const destination = await c.env.DB.prepare(
      `SELECT boards.id AS id
         FROM boards
        WHERE boards.id = ? AND boards.id != ?
          AND ${boardOpenSql("boards", "?")}`,
    )
      .bind(destinationBoardId, c.get("board").id, user.id, user.id, user.id)
      .first<{ id: string }>();
    if (!destination) return c.json({ error: "forbidden" } as const, 403);
    try {
      return c.json({ columns: await boardClient(c.env, destination.id).transferOptions() });
    } catch {
      c.header("Retry-After", "2");
      return c.json({ error: "could not read the destination board; please retry" } as const, 503);
    }
  })

  .post(
    "/boards/:id/cards/:cardId/transfer",
    requireAuth,
    requireMember,
    zValidator("json", TransferCardSchema),
    async (c) => {
      const sourceBoard = c.get("board");
      const user = c.get("user");
      const sourceCardId = c.req.param("cardId");
      const { transferId, destinationBoardId, destinationColumnId } = c.req.valid("json");

      if (destinationBoardId === sourceBoard.id) {
        return c.json({ error: "destination must be another board" } as const, 400);
      }
      const destinationBoard = await findAccessibleBoard(c.env, user, destinationBoardId);
      if (!destinationBoard) {
        return c.json({ error: "forbidden" } as const, 403);
      }

      // Assignee preservation follows the same effective membership the rest of the
      // board reads use: an explicit grant, or a workspace membership while the
      // destination is workspace-access. Explicit-only would drop an assignee the
      // destination board really does admit.
      const { results: destMembers } = await c.env.DB.prepare(
        `SELECT u.id AS userId FROM boards b JOIN users u ON u.id IN (${boardMemberIdsSql("b")}) WHERE b.id = ?`,
      )
        .bind(destinationBoardId)
        .all<{ userId: string }>();
      const destMemberSet = new Set(destMembers.map((m) => m.userId));

      const ids = { transferId, sourceBoardId: sourceBoard.id, cardId: sourceCardId, destinationBoardId };
      const outcome = await runCardTransfer(
        ids,
        boardSource(c.env, ids, user.id),
        boardDestination(c.env, ids, user.id),
        destinationColumnId,
        destMemberSet,
      );
      if (outcome.kind === "refused") {
        const { status, error, code } = outcome;
        return c.json({ error, ...(code ? { code } : {}) }, status, status === 503 ? { "Retry-After": "2" } : {});
      }
      return c.json({
        boardId: destinationBoard.id,
        boardKey: destinationBoard.key,
        cardId: outcome.receipt.cardId,
        taskNumber: outcome.receipt.taskNumber,
      });
    },
  )
  // Auth and membership run before the upgrade check inside the DO, so an
  // unauthorized plain request gets 401/403 rather than 426.
  // Realtime protocol version is verified after auth and membership but before DO
  // stub access to prevent stale/incompatible clients from scanning DO SQLite rows.
  .get("/boards/:id/ws", requireAuth, requireMember, async (c) => {
    if (isCrossOriginBrowserRequest(c)) return c.json(CROSS_ORIGIN_REFUSED, 403);
    if (c.req.query("realtimeVersion") !== REALTIME_PROTOCOL_VERSION) {
      return c.json({ error: "realtime client update required" }, 409);
    }
    const board = c.get("board");
    const response = await boardClient(c.env, board.id).connect(c.req.raw, c.get("user").id, board.capabilities.canManageBoard, await requestSessionHash(c));
    return recheckSessionAfterUpgrade(c, response, board.id);
  })
  .get("/presence/ws", requireAuth, async (c) => {
    if (isCrossOriginBrowserRequest(c)) return c.json(CROSS_ORIGIN_REFUSED, 403);
    if (c.req.query("realtimeVersion") !== REALTIME_PROTOCOL_VERSION) {
      return c.json({ error: "realtime client update required" }, 409);
    }
    const user = c.get("user");
    const queryTz = c.req.query("timezone")?.trim();
    let effectiveTz: string | null = null;

    if (user.timezone) {
      effectiveTz = user.timezone;
    } else if (queryTz && isValidIanaTimezone(queryTz)) {
      effectiveTz = queryTz;
    }

    const stub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName("global"));
    // The client's `x-foxban-*` headers and its cookie are dropped before the trusted ones are set.
    const headers = upgradeHeaders(c.req.raw);
    headers.set(INTERNAL_USER_ID_HEADER, user.id);
    headers.set(INTERNAL_SESSION_HASH_HEADER, await requestSessionHash(c));
    headers.set(INTERNAL_IS_ADMIN_HEADER, isAdminEmail(c.env, user.email) ? "true" : "false");
    if (effectiveTz) headers.set(INTERNAL_TIMEZONE_HEADER, effectiveTz);
    return recheckSessionAfterUpgrade(c, await stub.fetch(new Request(c.req.raw, { headers })), null);
  })
  // Development info (ADR 0064) for the card fronts: every card's pull requests in one read, with no GitHub call and no polling.
  .get("/boards/:id/development", requireAuth, requireMember, async (c) => c.json(await boardClient(c.env, c.get("board").id).boardDevelopment()))
  // Development info (ADR 0064): the pull requests webhooks linked to this card. Readable with no GitHub call.
  .get("/boards/:id/cards/:cardId/development", requireAuth, requireMember, async (c) => {
    const development = await readCardDevelopment(c.env, c.get("board").id, c.req.param("cardId"));
    if (development === null) {
      return c.json({ code: "card_unavailable", error: "card not found or archived" } as const, 404);
    }
    return c.json(development);
  })
  // One card's history (ADR 0073): the board snapshot carries none, so the card modal reads it here.
  .get("/boards/:id/cards/:cardId/activity", requireAuth, requireMember, async (c) =>
    c.json({ activities: await boardClient(c.env, c.get("board").id).cardActivity(c.req.param("cardId")) }),
  )
  // One card's comments (ADR 0078): the snapshot carries only per-card counts, so the card modal reads them here.
  .get("/boards/:id/cards/:cardId/comments", requireAuth, requireMember, async (c) =>
    c.json({ comments: await boardClient(c.env, c.get("board").id).cardComments(c.req.param("cardId")) }),
  )
  // The repos a card may create its branch or pull request in (ADR 0064): the instance's, read from D1 with no GitHub call.
  .get("/boards/:id/connected-repos", requireAuth, requireMember, async (c) => c.json({ repos: await listConnectedRepos(c.env) }))
  // Manual link (ADR 0064): a PR that names no task key, by number plus a connected repo, or by URL.
  .post(
    "/boards/:id/cards/:cardId/development/pull-requests",
    requireAuth,
    requireMember,
    zValidator("json", ManualPullRequestLinkBodySchema, (result, c) => {
      if (!result.success) return c.json({ code: "invalid_pr_reference", error: "Enter a pull request URL or number." } as const, 400);
    }),
    async (c) => {
      const { pullRequest: text, repositoryId } = c.req.valid("json");
      const reference = parsePullRequestReference(text);
      if (!reference) return c.json({ code: "invalid_pr_reference", error: "Enter a pull request URL or number." } as const, 400);
      if (reference.owner === null && repositoryId === undefined) {
        return c.json({ code: "repository_required", error: "Pick the repository this pull request is in." } as const, 400);
      }
      const repository = await findConnectedRepo(
        c.env,
        reference.owner !== null ? { fullName: `${reference.owner}/${reference.repo}` } : { id: repositoryId! },
      );
      if (!repository) {
        return c.json({ code: "repo_not_connected", error: "That repository is not connected to foxban." } as const, 409);
      }
      if (repositoryId !== undefined && repositoryId !== repository.id) {
        return c.json({ code: "wrong_repository", error: "The pull request is in a different repository." } as const, 409);
      }

      let read: Awaited<ReturnType<typeof readPullRequest>>;
      try {
        read = await readPullRequest(c.env, repository, reference.number);
      } catch (err) {
        const failure = classifyPullRequestFailure(err);
        if (failure.retryAfterMs !== null) c.header("Retry-After", String(Math.ceil(failure.retryAfterMs / 1000)));
        return c.json({ code: failure.code, error: failure.message }, PULL_REQUEST_FAILURE_STATUS[failure.code]);
      }
      if (read === null) return c.json({ code: "github_unconfigured", error: "GitHub App integration is not configured" } as const, 503);
      if (read.baseRepositoryId !== repository.id) {
        return c.json({ code: "wrong_repository", error: `#${reference.number} targets another repository.` } as const, 409);
      }

      const result = await boardClient(c.env, c.get("board").id).changeCardLink(c.get("user").id, c.req.param("cardId"), { link: read.pullRequest });
      return result.ok
        ? c.json(result.development)
        : c.json({ code: result.code, error: result.error }, result.status as 400 | 403 | 404 | 409 | 410 | 502);
    },
  )
  // Unlink: removes the link and records a tombstone so key matching skips this PR for this card.
  .delete("/boards/:id/cards/:cardId/development/pull-requests/:repositoryId/:number", requireAuth, requireMember, async (c) => {
    const repositoryId = Number(c.req.param("repositoryId"));
    const number = Number(c.req.param("number"));
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !Number.isSafeInteger(number) || number <= 0) {
      return c.json({ code: "invalid_pr_reference", error: "Enter a pull request URL or number." } as const, 400);
    }
    const result = await boardClient(c.env, c.get("board").id).changeCardLink(c.get("user").id, c.req.param("cardId"), { unlink: { repositoryId, number } });
    return result.ok
      ? c.json(result.development)
      : c.json({ code: result.code, error: result.error }, result.status as 400 | 403 | 404 | 409 | 410 | 502);
  })
  // Unlink a branch the same way: the card drops it and a tombstone keeps key matching from linking it again. The name is URL-encoded (it may hold slashes).
  .delete("/boards/:id/cards/:cardId/development/branches/:repositoryId/:name", requireAuth, requireMember, async (c) => {
    const repositoryId = Number(c.req.param("repositoryId"));
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return c.json({ code: "invalid_branch_reference", error: "invalid branch" } as const, 400);
    }
    const result = await boardClient(c.env, c.get("board").id).changeCardLink(c.get("user").id, c.req.param("cardId"), { unlinkBranch: { repositoryId, name: c.req.param("name") } });
    return result.ok
      ? c.json(result.development)
      : c.json({ code: result.code, error: result.error }, result.status as 400 | 403 | 404 | 409 | 410 | 502);
  })
  // Write-back (ADR 0064): the task-key branch in a connected repo the card picks. The branch reaches the card through GitHub's `create` webhook, like any other.
  .post("/boards/:id/cards/:cardId/development/create-branch", requireAuth, requireMember, zValidator("json", RepositoryChoiceSchema), async (c) => {
    const board = c.get("board");
    const prepared = await prepareInstanceWrite(c, c.req.param("cardId"), c.req.valid("json").repositoryId);
    if ("refusal" in prepared) return prepared.refusal;
    const { app, repository, cardContext } = prepared;
    const branchName = `${board.key.toLowerCase()}-${cardContext.taskNumber}`;

    try {
      const token = await createInstallationToken(c.env.GITHUB_API_BASE, app.appId, app.privateKey, repository.installationId, [repository.id]);
      const repo = await getRepository(c.env.GITHUB_API_BASE, token, repository.owner, repository.name);
      const defaultBranch = await getBranch(c.env.GITHUB_API_BASE, token, repository.owner, repository.name, repo.defaultBranch);
      if (!defaultBranch) return c.json({ error: "default branch head not found" } as const, 502);

      const refusal = await checkGitHubWrite(c, cardContext, repository);
      if (refusal) return refusal;

      const branch = await createBranchRef(c.env.GITHUB_API_BASE, token, repository.owner, repository.name, branchName, defaultBranch.sha);
      return c.json({ name: branch.name, url: branch.url });
    } catch (err) {
      return githubWriteFailure(c, err);
    }
  })
  // Write-back (ADR 0064): the pull request from the task branch, against the live default branch. The installation token makes foxban[bot] the author; the body names the member.
  .post("/boards/:id/cards/:cardId/development/create-pull-request", requireAuth, requireMember, zValidator("json", RepositoryChoiceSchema), async (c) => {
    const board = c.get("board");
    const prepared = await prepareInstanceWrite(c, c.req.param("cardId"), c.req.valid("json").repositoryId);
    if ("refusal" in prepared) return prepared.refusal;
    const { app, repository, cardContext } = prepared;
    const branchName = `${board.key.toLowerCase()}-${cardContext.taskNumber}`;
    const taskKey = `${board.key}-${cardContext.taskNumber}`;

    try {
      const token = await createInstallationToken(c.env.GITHUB_API_BASE, app.appId, app.privateKey, repository.installationId, [repository.id]);
      const existing = await getPullRequestForBranch(c.env.GITHUB_API_BASE, token, repository.owner, repository.name, branchName);
      if (existing) return c.json({ number: existing.number, url: existing.url, state: existing.state });
      if (!(await getBranch(c.env.GITHUB_API_BASE, token, repository.owner, repository.name, branchName))) {
        return c.json({ error: `branch ${branchName} does not exist` } as const, 409);
      }
      const repo = await getRepository(c.env.GITHUB_API_BASE, token, repository.owner, repository.name);

      // One line, with `@` broken, so a display name can neither add lines to the body nor mention people on GitHub.
      const opener = c.get("user").name.replace(/\s+/g, " ").trim().replaceAll("@", "@​");
      const body = `Foxban: ${appOrigin(c.env, c.req.url)}/board/${board.key}?card=${taskKey}\n\nOpened by ${opener}`;

      const refusal = await checkGitHubWrite(c, cardContext, repository);
      if (refusal) return refusal;

      const opened = await openPullRequest(c.env, token, repository, { title: `${taskKey}: ${cardContext.title}`, head: branchName, base: repo.defaultBranch, body });
      if ("error" in opened) return c.json({ error: opened.error } as const, opened.status);
      return c.json({ number: opened.pr.number, url: opened.pr.url, state: opened.pr.state });
    } catch (err) {
      return githubWriteFailure(c, err);
    }
  })

export { BoardDO } from "./board-do";
export { PresenceDO } from "./presence-do";
export type AppType = typeof app;

const worker: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(recoverAccessChanges(env));
      ctx.waitUntil(drainBackfill(env));
    } else if (controller.cron === "17 3 * * *") {
      ctx.waitUntil(reconcileAttachmentObjects(env));
    }
  },
};

export default worker;
