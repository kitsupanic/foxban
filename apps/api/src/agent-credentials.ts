import { Hono } from "hono";
import { z } from "zod";
import {
  BOARD_SELECT_COLS,
  createInviteToken,
  findAccessibleBoard,
  appOrigin,
  requireAuth,
  SESSION_USER_COLS,
  sha256Hex,
  toBoardRow,
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

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limit) return null;
  }
  if (request.body === null) return new Uint8Array();
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


function parseMetadata(row: CredentialRow): CredentialMetadata | null {
  try {
    const boardIds = PersistedStringArraySchema.max(100).parse(JSON.parse(row.boardIdsJson));
    const scopes = z.array(AgentScopeSchema).min(1).max(3).parse(JSON.parse(row.scopesJson));
    if (new Set(boardIds).size !== boardIds.length || new Set(scopes).size !== scopes.length) return null;
    return { id: row.id, name: row.name, boardIds, scopes, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  } catch {
    return null;
  }
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
  try {
    const boardIds = PersistedStringArraySchema.max(100).parse(JSON.parse(row.boardIdsJson));
    const scopes = z.array(AgentScopeSchema).min(1).max(3).parse(JSON.parse(row.scopesJson));
    if (new Set(boardIds).size !== boardIds.length || new Set(scopes).size !== scopes.length) return null;
    return {
      user: toSessionUser({ id: row.id, email: row.email, name: row.name, githubLogin: row.githubLogin, avatarVersion: row.avatarVersion, timezone: row.timezone, hasPassword: row.hasPassword }),
      credentialId: row.credentialId,
      boardIds: Object.freeze([...boardIds]),
      scopes: Object.freeze([...scopes]),
      expiresAt: row.expiresAt,
    };
  } catch {
    return null;
  }
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
    for (const boardId of parsed.data.boardIds) {
      if ((await findAccessibleBoard(c.env, user, boardId)) === null) {
        return c.json({ error: "forbidden" } as const, 403);
      }
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

export async function listAuthorizedBoards(env: Env, principal: AgentPrincipal): Promise<RawBoardRecord[]> {
  if (principal.boardIds.length === 0) return [];
  const placeholders = principal.boardIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT ${BOARD_SELECT_COLS} FROM boards WHERE boards.id IN (${placeholders}) ORDER BY boards.id`,
  ).bind(...principal.boardIds).all<RawBoardRecord>();
  const accessible: RawBoardRecord[] = [];
  for (const raw of results) {
    const board = toBoardRow(raw);
    if ((await findAccessibleBoard(env, principal.user, board.id)) !== null) accessible.push(raw);
  }
  return accessible;
}
