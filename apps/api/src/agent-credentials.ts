import { Hono } from "hono";
import { z } from "zod";
import {
  BOARD_SELECT_COLS,
  createInviteToken,
  appOrigin,
  requireAuth,
  SESSION_USER_COLS,
  sha256Hex,
  boardOpenSql,
  isAdminEmail,
  toSessionUser,
  type AppEnv,
  type RawBoardRecord,
  type SessionUser,
  type SessionUserRow,
} from "./auth";
import { AgentScopeSchema, decodeCursor, encodeCursor, type AgentScope } from "./mcp-contract";

const TOKEN_PREFIX = "foxban_mcp_";
const TOKEN_RE = /^foxban_mcp_[A-Za-z0-9_-]{43}$/;
const BODY_LIMIT = 16_384;
const DAY_MS = 24 * 60 * 60 * 1000;

const IssueCredentialSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  boardIds: z.array(z.string().min(1).max(64)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  scopes: z.array(AgentScopeSchema).min(1).max(3).refine((scopes) => new Set(scopes).size === scopes.length),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
const CredentialListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});
const PersistedStringArraySchema = z.array(z.string()).min(1);

export type CredentialMetadata = {
  id: string;
  name: string;
  boardIds: string[];
  scopes: AgentScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};
export type AgentPrincipal = {
  user: SessionUser;
  credentialId: string;
  boardIds: readonly string[];
  scopes: readonly AgentScope[];
  expiresAt: number;
};

type CredentialRow = {
  id: string;
  name: string;
  boardIdsJson: string;
  scopesJson: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

/** The request body, or null when it is (or declares itself) larger than `limit` bytes; stops reading at the limit. */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limit) return null;
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}


/** The board ids and scopes a credential row holds, or null when the stored JSON is not a valid grant. */
function parseGrants(boardIdsJson: string, scopesJson: string): { boardIds: string[]; scopes: AgentScope[] } | null {
  try {
    const boardIds = PersistedStringArraySchema.max(100).parse(JSON.parse(boardIdsJson));
    const scopes = z.array(AgentScopeSchema).min(1).max(3).parse(JSON.parse(scopesJson));
    if (new Set(boardIds).size !== boardIds.length || new Set(scopes).size !== scopes.length) return null;
    return { boardIds, scopes };
  } catch {
    return null;
  }
}

function parseMetadata(row: CredentialRow): CredentialMetadata | null {
  const grants = parseGrants(row.boardIdsJson, row.scopesJson);
  return grants && { id: row.id, name: row.name, ...grants, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
}

export async function authenticateAgentCredential(env: Env, authorization: string | null): Promise<AgentPrincipal | null> {
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (!TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT agent_credentials.id AS credentialId,
            agent_credentials.board_ids_json AS boardIdsJson,
            agent_credentials.scopes_json AS scopesJson,
            agent_credentials.expires_at AS expiresAt,
            agent_credentials.revoked_at AS revokedAt,
            ${SESSION_USER_COLS}
       FROM agent_credentials
       JOIN users ON users.id = agent_credentials.user_id
      WHERE agent_credentials.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<SessionUserRow & {
    credentialId: string; boardIdsJson: string; scopesJson: string; expiresAt: number; revokedAt: number | null;
  }>();
  if (!row || row.revokedAt !== null || row.expiresAt <= Date.now()) return null;
  const grants = parseGrants(row.boardIdsJson, row.scopesJson);
  if (grants === null) return null;
  return {
    user: toSessionUser({ id: row.id, email: row.email, name: row.name, githubLogin: row.githubLogin, avatarVersion: row.avatarVersion, timezone: row.timezone, hasPassword: row.hasPassword }),
    credentialId: row.credentialId,
    boardIds: Object.freeze([...grants.boardIds]),
    scopes: Object.freeze([...grants.scopes]),
    expiresAt: row.expiresAt,
  };
}

export const agentCredentialsRouter = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    if (origin !== undefined && (origin === "null" || origin.includes(","))) {
      return c.json({ error: "forbidden" } as const, 403);
    }
    if (origin !== undefined) {
      try {
        if (new URL(origin).origin !== new URL(appOrigin(c.env, c.req.url)).origin || origin !== new URL(origin).origin) {
          return c.json({ error: "forbidden" } as const, 403);
        }
      } catch {
        return c.json({ error: "forbidden" } as const, 403);
      }
    }
    await next();
  })
  .use("*", requireAuth)
  .post("/", async (c) => {
    const bytes = await readBoundedBody(c.req.raw, BODY_LIMIT);
    if (bytes === null) return c.json({ error: "request too large" } as const, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: "invalid request" } as const, 400);
    }
    const parsed = IssueCredentialSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid request" } as const, 400);
    const user = c.get("user");
    // The ids are distinct (schema), so one row per id means every board opens.
    if ((await listAuthorizedBoards(c.env, { user, boardIds: parsed.data.boardIds })).length !== parsed.data.boardIds.length) {
      return c.json({ error: "forbidden" } as const, 403);
    }
    const token = TOKEN_PREFIX + createInviteToken();
    const now = Date.now();
    const credential: CredentialMetadata = {
      id: crypto.randomUUID(), name: parsed.data.name, boardIds: parsed.data.boardIds,
      scopes: parsed.data.scopes, createdAt: now,
      expiresAt: now + parsed.data.expiresInDays * DAY_MS, revokedAt: null,
    };
    await c.env.DB.prepare(
      `INSERT INTO agent_credentials(id, user_id, name, token_hash, board_ids_json, scopes_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      credential.id, user.id, credential.name, await sha256Hex(token),
      JSON.stringify(credential.boardIds), JSON.stringify(credential.scopes), credential.createdAt, credential.expiresAt,
    ).run();
    return c.json({ credential, token }, 201);
  })
  .get("/", async (c) => {
    const parsed = CredentialListQuerySchema.safeParse({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
    if (!parsed.success) return c.json({ error: "invalid request" } as const, 400);
    let after: { createdAt: number; id: string } | null = null;
    if (parsed.data.cursor !== undefined) {
      const cursor = decodeCursor(parsed.data.cursor);
      if (
        cursor?.kind !== "credentials" ||
        cursor.boardId !== undefined || cursor.taskId !== undefined || cursor.filters !== undefined ||
        typeof cursor.after !== "object" || cursor.after === null ||
        Object.keys(cursor.after).length !== 2 ||
        !("createdAt" in cursor.after) || !("id" in cursor.after) ||
        typeof cursor.after.createdAt !== "number" || typeof cursor.after.id !== "string"
      ) {
        return c.json({ error: "invalid cursor" } as const, 400);
      }
      after = { createdAt: cursor.after.createdAt, id: cursor.after.id };
    }
    const bindings: (string | number)[] = [c.get("user").id];
    let continuation = "";
    if (after !== null) {
      continuation = "AND (created_at < ? OR (created_at = ? AND id < ?))";
      bindings.push(after.createdAt, after.createdAt, after.id);
    }
    bindings.push(parsed.data.limit + 1);
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, board_ids_json AS boardIdsJson, scopes_json AS scopesJson,
              created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM agent_credentials WHERE user_id = ? ${continuation}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...bindings).all<CredentialRow>();
    const rows = results.map(parseMetadata);
    if (rows.some((row) => row === null)) return c.json({ error: "credential metadata unavailable" } as const, 500);
    const credentials = rows.slice(0, parsed.data.limit) as CredentialMetadata[];
    const last = credentials.at(-1);
    const nextCursor = results.length > parsed.data.limit && last
      ? encodeCursor({ v: 1, kind: "credentials", after: { createdAt: last.createdAt, id: last.id } })
      : null;
    return c.json({ credentials, nextCursor });
  })
  .delete("/:credentialId", async (c) => {
    await c.env.DB.prepare(
      "UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?",
    ).bind(Date.now(), c.req.param("credentialId"), c.get("user").id).run();
    return c.body(null, 204);
  });

export async function listAuthorizedBoards(env: Env, principal: Pick<AgentPrincipal, "user" | "boardIds">): Promise<RawBoardRecord[]> {
  if (principal.boardIds.length === 0) return [];
  const user = principal.user;
  // One query (ids as one JSON bind: D1 caps a query at 100 bound parameters): the same open rule (and operator term) `findAccessibleBoard` applies, for every granted board at once.
  const { results } = await env.DB.prepare(
    `SELECT ${BOARD_SELECT_COLS}
       FROM boards
       JOIN workspaces ON workspaces.id=boards.workspace_id
      WHERE boards.id IN (SELECT value FROM json_each(?))
        AND ${boardOpenSql("boards", "?", "?=1")}
      ORDER BY boards.id`,
  ).bind(JSON.stringify(principal.boardIds), isAdminEmail(env, user.email) ? 1 : 0, user.id, user.id, user.id).all<RawBoardRecord>();
  return results;
}
