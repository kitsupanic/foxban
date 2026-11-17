import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  APP_NAME,
  ATTACHMENT_POLICY,
  BoardColorSchema,
  BoardAccessModeSchema,
  BoardIconSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  attachmentMaxBytes,
  isPreviewableImageContentType,
  newPasswordProblem,
  REALTIME_PROTOCOL_VERSION,
  normalizeAttachmentContentType,
} from "@foxban/shared";
import {
  boardExists,
  createInviteToken,
  createUserWithInvite,
  endSession,
  fetchGitHubUser,
  GITHUB_LOGIN_RE,
  hashPassword,
  NO_PASSWORD_HASH,
  isAdminEmail,
  appOrigin,
  rateLimitAuth,
  requireAdmin,
  requireAuth,
  requireMember,
  findAccessibleBoard,
  findAccessibleBoardByKey,
  SESSION_COOKIE,
  SESSION_USER_COLS,
  signUpWithGitHub,
  startSession,
  toAuthUser,
  toSessionUser,
  verifyPassword,
  verifyUserPassword,
  BOARD_SELECT_COLS,
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
  GITHUB_ADMIN_PAGE_PATH,
  GITHUB_WEBHOOK_PATH,
  buildGitHubAppManifest,
  canCreateGitHubApp,
  createInstanceGitHubApp,
  getInstanceGitHubAppSummary,
  loadInstanceGitHubApp,
  removeInstanceGitHubApp,
} from "./github-app";
import { drainBackfill } from "./github-backfill";
import { readCardDevelopment, readPullRequest } from "./github-development";
import { findConnectedRepo, listConnectedRepos, refreshConnectedRepos } from "./github-repos";
import { handleGitHubWebhook } from "./github-webhook";
import {
  ATTACHMENT_ID,
  attachmentObjectKey,
  parseAttachmentObjectKey,
  userAvatarObjectKey,
  parseAvatarObjectKey,
} from "./attachment-lifecycle";
import { INTERNAL_TIMEZONE_HEADER, INTERNAL_USER_ID_HEADER } from "./internal-headers";
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
import { ACCESS_CHANGE_ABORT, ACCESS_CONFLICT, accessChangesRouter, recoverAccessChanges, resolveAccessChangeAttempt, runAccessChange, AccessChangeConflict } from "./access-changes";
import { workspacesRouter } from "./workspaces";
/**
 * Every string is bounded — an unbounded body reaches PBKDF2 and D1 otherwise.
 */
const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const PasswordSchema = z.string().max(PASSWORD_MAX_LENGTH);
const NewPasswordSchema = PasswordSchema.min(PASSWORD_MIN_LENGTH).refine(
  (password) => newPasswordProblem(password) === null,
  { message: "password is too predictable" },
);

const NameSchema = z.string().trim().min(1).max(200);

const SignupSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  name: NameSchema,
  // Bounded well above a 43-character base64url token; the value is only ever
  // compared against a stored one, never parsed.
  invite: z.string().max(256).optional(),
});
const LoginSchema = z.object({ email: EmailSchema, password: PasswordSchema.min(1) });
const EmailChangeSchema = z.object({
  email: EmailSchema,
  currentPassword: PasswordSchema.min(1),
});
const PasswordChangeSchema = z.object({
  // Absent only for an account with no password yet (ADR 0065); the route decides which accounts may omit it.
  currentPassword: PasswordSchema.min(1).optional(),
  newPassword: NewPasswordSchema,
});
const BoardKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "must be 2-10 uppercase alphanumeric characters starting with a letter");
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
  transferId: z.string().trim().min(1).max(64),
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

const GITHUB_STATE_COOKIE = "github_oauth_state";
const GITHUB_LOGIN_STATE_COOKIE = "github_login_state";
/** The signup invite the person holds, kept across the GitHub round trip next to the state. */
const GITHUB_LOGIN_INVITE_COOKIE = "github_login_invite";
/** The workspace invitation (`<workspaceId>.<token>`) the login page holds in its `#workspaceInvite=`, which a full-page GitHub round trip would lose. */
const GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE = "github_login_workspace_invite";
/** Both halves are ids or base64url tokens, so a match is safe to put in a redirect as it is. */
const WORKSPACE_CONTINUATION = /^([\w-]{1,64})\.([\w-]{1,128})$/;
const GITHUB_APP_MANIFEST_STATE_COOKIE = "github_app_manifest_state";


/**
 * Verified against when the email is unknown, so a login attempt costs the same
 * PBKDF2 work either way. Fixed bytes with the production iteration count — it
 * is not a hash of any password, and no input can match it.
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2:100000:WlpaWlpaWlpaWlpaWlpaWg==:paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU=";

/**
 * Every invite failure answers with this, so signup cannot be used to probe
 * whether a token exists, is spent, or was never minted.
 */
const INVITE_REQUIRED = { error: "a valid invite is required to sign up" } as const;

/** An account made with GitHub has no password until it sets one (ADR 0065); what needs a password to prove itself is refused until then. */
const passwordRequired = (error: string) => ({ error, code: "PASSWORD_REQUIRED" }) as const;

/** A fresh instance with no `ADMIN_EMAILS` can never admit its first user; say so. */
const ADMIN_NOT_CONFIGURED = { error: "no admin is configured", code: "ADMIN_NOT_CONFIGURED" } as const;

/**
 * Safety-net GC for historical objects and any future blob that exists without
 * an attachment row or a live provisional lease. Each board's DO makes the
 * keep/delete decision; the global Worker only enumerates R2 keys.
 */
export async function reconcileAttachmentObjects(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list(cursor === undefined ? undefined : { cursor });
    const attachmentItemsByBoard = new Map<string, { key: string; attachmentId: string }[]>();
    const avatarKeysToCheck: { key: string; userId: string; version: string }[] = [];

    for (const object of listed.objects) {
      if (object.key.startsWith("avatars/")) {
        const parsed = parseAvatarObjectKey(object.key);
        if (parsed !== null) {
          avatarKeysToCheck.push({
            key: object.key,
            userId: parsed.userId,
            version: parsed.avatarVersion,
          });
        }
        continue;
      }

      const parsed = parseAttachmentObjectKey(object.key);
      if (parsed === null) continue;
      const items = attachmentItemsByBoard.get(parsed.boardId);
      if (items) items.push({ key: object.key, attachmentId: parsed.attachmentId });
      else attachmentItemsByBoard.set(parsed.boardId, [{ key: object.key, attachmentId: parsed.attachmentId }]);
    }

    if (avatarKeysToCheck.length > 0) {
      const now = Date.now();
      const { results: activeUsers } = await env.DB.prepare(
        "SELECT id, avatar_version AS avatarVersion FROM users WHERE avatar_version IS NOT NULL",
      ).all<{ id: string; avatarVersion: string }>();
      const activeAvatarMap = new Map<string, string>();
      for (const row of activeUsers) {
        activeAvatarMap.set(row.id, row.avatarVersion);
      }

      const { results: activeLeases } = await env.DB.prepare(
        "SELECT user_id AS userId, version FROM avatar_leases WHERE expires_at > ?",
      )
        .bind(now)
        .all<{ userId: string; version: string }>();
      const activeLeaseSet = new Set(activeLeases.map((l) => `${l.userId}:${l.version}`));

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

      // Sweep expired avatar leases
      await env.DB.prepare("DELETE FROM avatar_leases WHERE expires_at <= ?").bind(now).run();
    }

    const failures: string[] = [];
    for (const [boardId, items] of attachmentItemsByBoard) {
      const queued = await boardClient(env, boardId).reconcileAttachments({
        keys: items.map((i) => i.key),
        ids: items.map((i) => i.attachmentId),
        objects: items,
      });
      if (!queued) failures.push(boardId);
    }
    if (failures.length > 0) {
      throw new Error(`attachment reconciliation failed for boards: ${failures.join(", ")}`);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
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
    c.header("Retry-After", "2");
    return c.json(
      { code: "access_change_pending", error: "Board access is changing. Please retry." } as const,
      503,
    );
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

/** A cookie that lives for the GitHub round trip. Lax, so it comes back on GitHub's redirect to the callback. */
function githubFlowCookie(c: Context<AppEnv>) {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 } as const;
}

/** Keeps `value` in a flow cookie for the round trip; with none, clears what an abandoned attempt left behind. */
function carryInFlowCookie(c: Context<AppEnv>, name: string, value: string | undefined) {
  if (value) setCookie(c, name, value, githubFlowCookie(c));
  else if (getCookie(c, name)) deleteCookie(c, name, { path: "/" });
}

/** Reads a flow cookie and clears it, so it is good for one callback. */
function takeFlowCookie(c: Context<AppEnv>, name: string): string | undefined {
  const value = getCookie(c, name);
  if (value !== undefined) deleteCookie(c, name, { path: "/" });
  return value;
}

/** Sends the browser to GitHub to approve the instance App, with a fresh `state` also kept in `stateCookie`: the pairing the callback checks. */
function redirectToGitHub(c: Context<AppEnv>, clientId: string, stateCookie: string, callbackPath: string) {
  const state = crypto.randomUUID();
  setCookie(c, stateCookie, state, githubFlowCookie(c));
  const url = new URL("/login/oauth/authorize", c.env.GITHUB_OAUTH_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appOrigin(c.env, c.req.url)}${callbackPath}`);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

const app = new Hono<AppEnv>()
  .get("/", (c) => c.json({ ok: true, app: APP_NAME }))
  .route("/workspaces", workspacesRouter)
  .route("/access-changes", accessChangesRouter)
  .route("/me/agent-credentials", agentCredentialsRouter)
  .all("/mcp", (c) => handleMcpRequest(c.req.raw, c.env))
  .all("/mcp/*", (c) => c.json({ error: "not found" } as const, 404, { "Cache-Control": "no-store" }))
  .post("/auth/signup", rateLimitAuth, zValidator("json", SignupSchema), async (c) => {
    const { email, password, name, invite } = c.req.valid("json");
    const user = toAuthUser(c.env, { id: crypto.randomUUID(), email, name, githubLogin: null, avatarVersion: null, timezone: null, hasPassword: true });
    const now = Date.now();
    const passwordHash = await hashPassword(password);
    try {
      if (user.isAdmin) {
        // ADMIN_EMAILS is the authorization; an invite passed anyway is ignored
        // and left unspent, so nobody has to mint one for the first account.
        await c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(user.id, email, name, passwordHash, now)
          .run();
      } else {
        if (!invite) {
          // Only for the no-invite case, so it reveals nothing about any token.
          const noAdmin = !c.env.ADMIN_EMAILS?.split(",").some((entry) => entry.trim());
          return c.json(noAdmin ? ADMIN_NOT_CONFIGURED : INVITE_REQUIRED, 403);
        }
        // A failing INSERT (duplicate email) rolls the invite claim back with the batch.
        if (!(await createUserWithInvite(c.env.DB, invite, { id: user.id, email, name, passwordHash }, now))) {
          return c.json(INVITE_REQUIRED, 403);
        }
      }
    } catch (error) {
      // D1 surfaces the users.email uniqueness index as a constraint error.
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "email already registered" }, 409);
      }
      throw error;
    }
    await startSession(c, user.id);
    return c.json(user);
  })
  .post("/auth/login", rateLimitAuth, zValidator("json", LoginSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    const row = await c.env.DB.prepare(
      `SELECT id, email, name, github_login AS githubLogin, avatar_version AS avatarVersion, timezone, password_hash AS passwordHash
         FROM users WHERE email = ?`,
    )
      .bind(email)
      .first<{
        id: string;
        email: string;
        name: string;
        githubLogin: string | null;
        avatarVersion: string | null;
        timezone: string | null;
        passwordHash: string;
      }>();
    // An unknown email still pays for one PBKDF2 derivation, so the response time
    // does not reveal which accounts exist. Both failures answer the same 401.
    const stored = row?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const ok = await verifyPassword(password, stored);
    if (!row || !ok) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    if (!(await startSession(c, row.id, stored))) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    return c.json(
      toAuthUser(c.env, {
        id: row.id,
        email: row.email,
        name: row.name,
        githubLogin: row.githubLogin,
        avatarVersion: row.avatarVersion,
        timezone: row.timezone,
        // Only a stored password verifies, so this account has one.
        hasPassword: true,
      }),
    );
  })
  .post("/auth/logout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  })
  .post(
    "/auth/email",
    requireAuth,
    rateLimitAuth,
    zValidator("json", EmailChangeSchema),
    async (c) => {
      const { email: nextEmail, currentPassword } = c.req.valid("json");
      const user = c.get("user");
      // No password to prove ownership with (ADR 0065): refused before any admin or duplicate inspection too.
      if (!user.hasPassword) return c.json(passwordRequired("set a password before changing your email"), 403);
      // Current password must be verified before any admin or duplicate inspection,
      // so an invalid password cannot be used to probe whether an address is taken
      // or configured as an admin.
      const verifiedHash = await verifyUserPassword(c.env, user.id, currentPassword);
      if (!verifiedHash) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      if (isAdminEmail(c.env, user.email) !== isAdminEmail(c.env, nextEmail)) {
        return c.json({ error: "email cannot change administrator access" }, 403);
      }

      try {
        const { meta } = await c.env.DB.prepare(
          "UPDATE users SET email = ? WHERE id = ? AND password_hash = ?",
        )
          .bind(nextEmail, user.id, verifiedHash)
          .run();
        if (meta.changes === 0) {
          return c.json({ error: "invalid credentials" }, 401);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          return c.json({ error: "email already registered" }, 409);
        }
        throw error;
      }

      const updatedUser: SessionUser = { ...user, email: nextEmail };
      return c.json(toAuthUser(c.env, updatedUser));
    },
  )
  .post(
    "/auth/password",
    requireAuth,
    rateLimitAuth,
    zValidator("json", PasswordChangeSchema),
    async (c) => {
      const { currentPassword, newPassword } = c.req.valid("json");
      const user = c.get("user");
      // An account with no password has nothing to prove: the session is enough, and the compare-and-set below
      // against the marker lets only one first password win. Anything else must present the current one.
      const verifiedHash = user.hasPassword
        ? currentPassword === undefined ? null : await verifyUserPassword(c.env, user.id, currentPassword)
        : NO_PASSWORD_HASH;
      if (!verifiedHash) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      const newHash = await hashPassword(newPassword);
      const sessionId = getCookie(c, SESSION_COOKIE) ?? "";

      const [updateResult] = await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?",
        ).bind(newHash, user.id, verifiedHash),
        c.env.DB.prepare(
          `DELETE FROM sessions
            WHERE user_id = ?
              AND id != ?
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
        ).bind(user.id, sessionId, user.id, newHash),
      ]);

      if (updateResult?.meta.changes !== 1) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      return c.json({ ok: true });
    },
  )
  // The instance GitHub App's user sign-in flow, and the only writer of `users.github_login`.
  // Both links are navigated to by the browser, never called through `hc`.
  .get("/auth/github/start", requireAuth, async (c) => {
    // No App yet (an Admin creates it, ADR 0064): the feature is off, not broken.
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.json({ error: "GitHub is not configured" }, 503);
    return redirectToGitHub(c, githubApp.clientId, GITHUB_STATE_COOKIE, "/auth/github/callback");
  })
  .get("/auth/github/callback", requireAuth, async (c) => {
    const fail = (reason: "error" | "taken" = "error") => c.redirect(`${appOrigin(c.env, c.req.url)}/profile?github=${reason}`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expected = getCookie(c, GITHUB_STATE_COOKIE);
    deleteCookie(c, GITHUB_STATE_COOKIE, { path: "/" });
    if (!state || !code || !expected || state !== expected) return fail();
    // A missing or unreadable App record is a misconfigured instance, not a server error to the person linking.
    const githubApp = await loadInstanceGitHubApp(c.env).catch(() => null);
    if (!githubApp) return fail();
    const account = await fetchGitHubUser(c.env, githubApp, code, `${appOrigin(c.env, c.req.url)}/auth/github/callback`);
    if (account === null) return fail();
    try {
      await c.env.DB.prepare("UPDATE users SET github_login = ?, github_user_id = ? WHERE id = ?")
        .bind(account.login, account.id, c.get("user").id)
        .run();
    } catch (error) {
      // The unique index on github_user_id: another foxban account already has this GitHub account.
      if (String(error).includes("UNIQUE constraint failed")) return fail("taken");
      throw error;
    }
    return c.redirect(`${appOrigin(c.env, c.req.url)}/profile`);
  })
  // Signing in with the instance GitHub App (ADR 0065): public, so both ends are rate limited like login.
  // Every outcome is a redirect to /login, where `?github=` carries the reason.
  // `?invite=` is the signup page's link: an unknown GitHub account may sign up with it (ADR 0065).
  // `?workspaceInvite=<workspaceId>.<token>` is the login or signup page's pending workspace invitation: the person lands on its join page once signed in.
  .get("/auth/github/login/start", rateLimitAuth, async (c) => {
    const queried = c.req.query("workspaceInvite");
    const workspaceInvite = queried !== undefined && WORKSPACE_CONTINUATION.test(queried) ? queried : undefined;
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.redirect(`${appOrigin(c.env, c.req.url)}/login?github=unavailable${workspaceInvite ? `#workspaceInvite=${workspaceInvite}` : ""}`);
    // Anything left behind by an abandoned attempt must not ride along with this one.
    carryInFlowCookie(c, GITHUB_LOGIN_INVITE_COOKIE, c.req.query("invite"));
    carryInFlowCookie(c, GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE, workspaceInvite);
    return redirectToGitHub(c, githubApp.clientId, GITHUB_LOGIN_STATE_COOKIE, "/auth/github/login/callback");
  })
  .get("/auth/github/login/callback", rateLimitAuth, async (c) => {
    const origin = appOrigin(c.env, c.req.url);
    const { state, code, error } = c.req.query();
    const expected = takeFlowCookie(c, GITHUB_LOGIN_STATE_COOKIE);
    const invite = takeFlowCookie(c, GITHUB_LOGIN_INVITE_COOKIE);
    const joining = WORKSPACE_CONTINUATION.exec(takeFlowCookie(c, GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE) ?? "");
    // A failed round trip goes back to the login page holding the invitation again, so a retry keeps it.
    const fail = (reason: "error" | "cancelled" | "unlinked" | "exists" = "error") =>
      c.redirect(`${origin}/login?github=${reason}${joining ? `#workspaceInvite=${joining[0]}` : ""}`);
    const signedIn = () => c.redirect(joining ? `${origin}/join-workspace/${joining[1]}#invite=${joining[2]}` : `${origin}/`);
    if (!state || !expected || state !== expected) return fail();
    // GitHub sends `error=access_denied` when the person presses Cancel on its approval page.
    if (error) return fail(error === "access_denied" ? "cancelled" : "error");
    if (!code) return fail();
    // A missing or unreadable App record is a misconfigured instance, not a server error to the person signing in.
    const githubApp = await loadInstanceGitHubApp(c.env).catch(() => null);
    if (!githubApp) return fail();
    const account = await fetchGitHubUser(c.env, githubApp, code, `${origin}/auth/github/login/callback`);
    if (account === null) return fail();
    // The numeric id is the key: a login name can be renamed away and handed to someone else.
    const row = await c.env.DB.prepare("SELECT id, github_login AS githubLogin FROM users WHERE github_user_id = ?")
      .bind(account.id)
      .first<{ id: string; githubLogin: string | null }>();
    if (!row) {
      // Not linked to any account: signing up, which the invite (and no GitHub-side e-mail match) allows.
      const created = await signUpWithGitHub(c.env, account, invite);
      if (!created.ok) return fail(created.problem);
      await startSession(c, created.userId);
      return signedIn();
    }
    // Follow a rename, so the avatar stays the account owner's.
    if (row.githubLogin !== account.login) {
      await c.env.DB.prepare("UPDATE users SET github_login = ? WHERE id = ?").bind(account.login, row.id).run();
    }
    await startSession(c, row.id);
    return signedIn();
  })
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

    if (updates.length > 0) {
      bindings.push(user.id);
      await c.env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
        .bind(...bindings)
        .run();
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
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 10 * 1024 * 1024) {
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
  // Invites are global signup grants, not board invitations (those live under
  // /boards/:id/members), and only an admin ever sees or mints one.
  .get("/invites", requireAuth, requireAdmin, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT token, created_at AS createdAt, used_by AS usedBy, used_at AS usedAt
         FROM invites
        ORDER BY created_at DESC, rowid DESC`,
    ).all<{ token: string; createdAt: number; usedBy: string | null; usedAt: number | null }>();
    return c.json({ invites: results });
  })
  .post("/invites", requireAuth, requireAdmin, async (c) => {
    const token = createInviteToken();
    await c.env.DB.prepare("INSERT INTO invites (token, created_by, created_at) VALUES (?, ?, ?)")
      .bind(token, c.get("user").id, Date.now())
      .run();
    return c.json({ token }, 201);
  })
  // GitHub's signed webhooks (ADR 0064): public, authenticated by the signature alone.
  .post(GITHUB_WEBHOOK_PATH, (c) => handleGitHubWebhook(c.env, c.req.raw, c.executionCtx))
  // The instance GitHub App (ADR 0064): created once by an Admin through GitHub's
  // app-manifest flow. Nothing here ever returns the App's secrets.
  .get("/github-app", requireAuth, requireAdmin, async (c) => {
    const app = await getInstanceGitHubAppSummary(c.env);
    // Opening the page re-reads the install's repos, so a missed webhook heals here.
    const refresh = app ? await refreshConnectedRepos(c.env) : null;
    return c.json({
      app: app && {
        ...app,
        installUrl: `${c.env.GITHUB_OAUTH_BASE}/apps/${app.slug}/installations/new`,
        repos: await listConnectedRepos(c.env),
        reposRefreshed: refresh !== null,
        // Who owns the App and which installs foxban skips for not being theirs (null when GitHub could not be asked).
        owner: refresh?.owner ?? null,
        ignoredAccounts: refresh?.ignoredAccounts ?? [],
        // The App's Advanced settings, where its owner can transfer it to another account.
        settingsUrl: refresh
          ? `${c.env.GITHUB_OAUTH_BASE}${refresh.ownerIsOrganization ? `/organizations/${refresh.owner}` : ""}/settings/apps/${app.slug}/advanced`
          : null,
      },
      canCreate: canCreateGitHubApp(c.env),
    });
  })
  // Forgets the App so a new one can be created; GitHub keeps it until its owner deletes it there.
  .delete("/github-app", requireAuth, requireAdmin, async (c) =>
    (await removeInstanceGitHubApp(c.env)) ? c.json({ ok: true }) : c.json({ error: "no GitHub App" }, 404),
  )
  // The browser posts the manifest to GitHub from a form, so the Admin page gets the
  // target URL (with the CSRF state) and the manifest, not a redirect.
  .post(
    "/github-app/manifest",
    requireAuth,
    requireAdmin,
    zValidator("json", z.object({ organization: z.string().regex(GITHUB_LOGIN_RE).optional() })),
    async (c) => {
      // No sealing key: the deploy script has not run since this feature shipped.
      if (!canCreateGitHubApp(c.env)) return c.json({ error: "GitHub App setup needs GITHUB_APP_ENCRYPTION_KEY; redeploy with pnpm run deploy" }, 503);
      if (await getInstanceGitHubAppSummary(c.env)) return c.json({ error: "this instance already has a GitHub App" }, 409);
      const state = crypto.randomUUID();
      setCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: new URL(c.req.url).protocol === "https:",
        maxAge: 3600, // GitHub gives the whole manifest flow an hour
      });
      const { organization } = c.req.valid("json");
      const target = new URL(
        organization ? `/organizations/${organization}/settings/apps/new` : "/settings/apps/new",
        c.env.GITHUB_OAUTH_BASE,
      );
      target.searchParams.set("state", state);
      return c.json({ url: target.toString(), manifest: buildGitHubAppManifest(appOrigin(c.env, c.req.url)) });
    },
  )
  // GitHub sends the Admin's browser here after "Create GitHub App" (the manifest's
  // redirect_url). Both the Admin session and the state cookie must match.
  .get("/auth/github-app/manifest/callback", requireAuth, requireAdmin, async (c) => {
    const adminPage = `${appOrigin(c.env, c.req.url)}${GITHUB_ADMIN_PAGE_PATH}`;
    const fail = () => c.redirect(`${adminPage}?githubApp=error`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expected = getCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE);
    deleteCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE, { path: "/" });
    if (!state || !code || !expected || state !== expected || !canCreateGitHubApp(c.env)) return fail();
    try {
      return (await createInstanceGitHubApp(c.env, code)) ? c.redirect(`${adminPage}?githubApp=created`) : fail();
    } catch {
      return fail();
    }
  })
  .delete("/invites/:token", requireAuth, requireAdmin, async (c) => {
    // A spent token stays as the audit trail of who used it, so revoking one is
    // as much a 404 as a token that never existed.
    const { meta } = await c.env.DB.prepare(
      "DELETE FROM invites WHERE token = ? AND used_at IS NULL",
    )
      .bind(c.req.param("token"))
      .run();
    if (meta.changes !== 1) return c.json({ error: "invite not found" }, 404);
    return c.json({ ok: true });
  })
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
      capabilities: { canManageBoard:true,canManageColumns:true,canManageMembers:true },
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
  // Any member may invite another: with two trusted users there are no roles.
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
        if(!board.capabilities.canManageMembers)return c.json({error:"forbidden"} as const,403);
        const invitee=await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first<{id:string}>();
        if(!invitee)return c.json({error:"user not found"} as const,404);
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
      if(resumed){if(resumed.state!=="completed")return c.json(resumed,202);return resumed.outcome==="aborted"?c.json({error:resumed.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":resumed.result===ACCESS_CHANGE_ABORT.boardOwnerProtected?"board owner cannot be removed":"forbidden"} as const,resumed.result===ACCESS_CHANGE_ABORT.forbidden?403:404):c.json({ok:true} as const);}
      if(!board.capabilities.canManageMembers)return c.json({error:"forbidden"} as const,403);
      if(targetUserId===board.ownerId)return c.json({error:"board owner cannot be removed"} as const,403);
      if(targetUserId===actor.id)return c.json({error:"cannot remove self from board"} as const,403);
      const result=await runAccessChange(c.env,actor,{operationId,kind:"board-member-remove",payload:{boardId:board.id,userId:targetUserId},workspaceIds:[board.workspaceId],boards:[{boardId:board.id,workspaceId:board.workspaceId}]});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return c.json({error:result.result===ACCESS_CHANGE_ABORT.boardNotFound?"board not found":result.result===ACCESS_CHANGE_ABORT.boardOwnerProtected?"board owner cannot be removed":"forbidden"} as const,result.result===ACCESS_CHANGE_ABORT.forbidden?403:404);
      return c.json({ok:true} as const);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  .get("/boards/:id/membership-candidates", requireAuth, requireMember, async (c) => {
    const board = c.get("board");
    const user = c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT b.pending_access_operation_id AS pendingAccessOperationId,
              users.id AS id, users.email AS email, users.name AS name,
              users.github_login AS githubLogin, users.avatar_version AS avatarVersion
         FROM boards b
         LEFT JOIN users ON users.id NOT IN (
          SELECT board_members.user_id
            FROM board_members
           WHERE board_members.board_id = b.id
        )
        WHERE b.id=? AND ${boardOpenSql("b", "?", "?=1")}
        ORDER BY users.name, users.email`,
    )
      .bind(board.id, isAdminEmail(c.env, user.email) ? 1 : 0, user.id, user.id, user.id)
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
    // At most 50 MB, so buffering is fine; `byteLength` is authoritative and a
    // lying content-length header cannot get around the declared-type limit.
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: "empty body" } as const, 400);
    if (body.byteLength > maxBytes) return c.json({ error: "too large" } as const, 413);
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
    let resolvedKey: string | null = null;
    try {
      resolvedKey = await boardClient(c.env, boardId).attachmentKey(key);
    } catch {
      // Fall back to default key if BoardDO lookup fails
    }
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
    const currentBoardId = c.get("board").id;

    const { results: destinationBoardsRaw } = await c.env.DB.prepare(
      `SELECT ${BOARD_SELECT_COLS}
         FROM boards
        WHERE boards.id != ?
          AND ${boardOpenSql("boards", "?")}
        ORDER BY boards.created_at`,
    )
      .bind(currentBoardId, user.id, user.id, user.id)
      .all<RawBoardRecord>();
    const destinationBoards = destinationBoardsRaw.map(toBoardRow);
    try {
      const boardsWithOptions = await Promise.all(
        destinationBoards.map(async (board) => {
          return {
            id: board.id,
            name: board.name,
            key: board.key,
            columns: await boardClient(c.env, board.id).transferOptions(),
          };
        }),
      );
      return c.json({ boards: boardsWithOptions });
    } catch {
      return c.json({ error: "could not load transfer options" } as const, 500);
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
  .get("/boards/:id/ws", requireAuth, requireMember, (c) => {
    if (c.req.query("realtimeVersion") !== REALTIME_PROTOCOL_VERSION) {
      return c.json({ error: "realtime client update required" }, 409);
    }
    const board = c.get("board");
    return boardClient(c.env, board.id).connect(c.req.raw, c.get("user").id, board.capabilities.canManageColumns);
  })
  .get("/presence/ws", requireAuth, (c) => {
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
    const headers = new Headers(c.req.raw.headers);
    headers.set(INTERNAL_USER_ID_HEADER, user.id);
    if (effectiveTz) {
      headers.set(INTERNAL_TIMEZONE_HEADER, effectiveTz);
    } else {
      headers.delete(INTERNAL_TIMEZONE_HEADER);
    }
    return stub.fetch(new Request(c.req.raw, { headers }));
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
