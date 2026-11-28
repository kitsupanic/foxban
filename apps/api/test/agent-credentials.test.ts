import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";
import { listAuthorizedBoards } from "../src/agent-credentials";
import { sha256Hex, type SessionUser } from "../src/auth";
import { queriesOf, workerWithPausedD1 } from "./paused-d1";

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("missing session cookie");
  return value.split(";")[0]!;
}

async function signup(email: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

async function createBoard(cookie: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Agent board", key: `A${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

describe("agent credentials", () => {
  it("issues once, lists metadata, stores only a digest, and revokes idempotently", async () => {
    const cookie = await signup(`credential-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Harness", boardIds: [boardId], scopes: ["boards:read"], expiresInDays: 1, currentPassword: PASSWORD }),
    });
    expect(issue.status).toBe(201);
    expect(issue.headers.get("cache-control")).toBe("no-store");
    const issued = await issue.json<{ credential: { id: string }; token: string }>();
    expect(issued.token).toMatch(/^foxban_mcp_[A-Za-z0-9_-]{43}$/);
    const stored = await env.DB.prepare("SELECT token_hash AS tokenHash FROM agent_credentials WHERE id = ?")
      .bind(issued.credential.id).first<{ tokenHash: string }>();
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toContain(issued.token);

    const list = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = await list.json<{ credentials: Array<Record<string, unknown>>; nextCursor: string | null }>();
    expect(listed.credentials).toHaveLength(1);
    expect(listed.credentials[0]).not.toHaveProperty("token");
    expect(listed.credentials[0]).not.toHaveProperty("tokenHash");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revoked = await SELF.fetch(`${ORIGIN}/me/agent-credentials/${issued.credential.id}`, {
        method: "DELETE", headers: { cookie },
      });
      expect(revoked.status).toBe(204);
    }
    const denied = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
  });

  it("refuses an expired token, as it does a revoked one", async () => {
    const cookie = await signup(`credential-expiry-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Short lived", boardIds: [boardId], scopes: ["boards:read"], expiresInDays: 1, currentPassword: PASSWORD }),
    });
    const issued = await issue.json<{ credential: { id: string }; token: string }>();
    const call = () => SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: "{}" });
    expect((await call()).status).not.toBe(401);

    await env.DB.prepare("UPDATE agent_credentials SET created_at = ?1 - 1000, expires_at = ?1 WHERE id = ?2").bind(Date.now() - 1000, issued.credential.id).run();
    expect((await call()).status).toBe(401);
  });

  it("issues and lists a credential for the full 100 boards", async () => {
    const cookie = await signup(`credential-many-${crypto.randomUUID()}@foxban.test`);
    const boardIds: string[] = [];
    for (let i = 0; i < 100; i += 1) boardIds.push(await createBoard(cookie));
    const issue = (ids: string[]) => SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Many", boardIds: ids, scopes: ["boards:read"], currentPassword: PASSWORD }),
    });
    expect((await issue(boardIds)).status).toBe(201);
    // The MCP board list reads the same 100 ids; D1 refuses a query with more than 100 bound parameters.
    const user = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<SessionUser>();
    expect(await listAuthorizedBoards(env, { user, boardIds })).toHaveLength(100);
    // One board the user cannot open still refuses the whole batch.
    expect((await issue([...boardIds.slice(1), crypto.randomUUID()])).status).toBe(403);
  });

  it("keeps bearer tokens exclusive to MCP and rejects inaccessible board batches", async () => {
    const anonymous = await SELF.fetch(`${ORIGIN}/me/agent-credentials`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const owner = await signup(`credential-owner-${crypto.randomUUID()}@foxban.test`);
    const other = await signup(`credential-other-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(owner);
    const mixed = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST", headers: { "content-type": "application/json", cookie: other },
      body: JSON.stringify({ name: "No access", boardIds: [boardId, crypto.randomUUID()], scopes: ["boards:read"], currentPassword: PASSWORD }),
    });
    expect(mixed.status).toBe(403);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent_credentials WHERE name = 'No access'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("refuses a cross-origin browser write with the app-wide origin check", async () => {
    const cookie = await signup(`credential-origin-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const hostile = await issue(cookie, { name: "Hostile", boardIds: [boardId], scopes: ["boards:read"], currentPassword: PASSWORD }, { origin: "https://evil.test" });
    expect(hostile.status).toBe(403);
    // The app's own origin, and a non-browser caller that states none, are not refused.
    expect((await issue(cookie, { name: "Own origin", boardIds: [boardId], scopes: ["boards:read"], currentPassword: PASSWORD }, { origin: ORIGIN })).status).toBe(201);
    expect(await countNamed(cookie, "Hostile")).toBe(0);
  });

  it("needs the current password to issue, and stores nothing without it", async () => {
    const cookie = await signup(`credential-password-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const body = { name: "Unproven", boardIds: [boardId], scopes: ["boards:read"] };
    for (const attempt of [body, { ...body, currentPassword: "wrong horse battery" }]) {
      const refused = await issue(cookie, attempt);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "invalid credentials" });
    }
    // A board the user cannot open is not even looked at before the password is proved.
    expect((await issue(cookie, { ...body, boardIds: [crypto.randomUUID()] })).status).toBe(401);
    expect(await countNamed(cookie, "Unproven")).toBe(0);
  });

  it("issues without a password for an account that has none", async () => {
    const cookie = await signup(`credential-no-password-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
    await env.DB.prepare("UPDATE users SET password_hash = '*' WHERE id = ?").bind(id).run();
    expect((await issue(cookie, { name: "GitHub only", boardIds: [boardId], scopes: ["boards:read"] })).status).toBe(201);
  });

  it("revokes every credential of the account when the password changes", async () => {
    const cookie = await signup(`credential-rotate-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const first = await issueToken(cookie, boardId);
    const second = await issueToken(cookie, boardId);
    expect((await callMcp(first)).status).not.toBe(401);

    const changed = await SELF.fetch(`${ORIGIN}/auth/password`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "new horse battery staple" }),
    });
    expect(changed.status).toBe(200);

    expect((await callMcp(first)).status).toBe(401);
    expect((await callMcp(second)).status).toBe(401);
    expect(await activeCount(cookie)).toBe(0);
    // The old password no longer issues one; the new one does.
    expect((await issue(cookie, { name: "After", boardIds: [boardId], scopes: ["boards:read"], currentPassword: PASSWORD })).status).toBe(401);
    expect((await issue(cookie, { name: "After", boardIds: [boardId], scopes: ["boards:read"], currentPassword: "new horse battery staple" })).status).toBe(201);
  });

  it("keeps the credentials when a password change is refused", async () => {
    const cookie = await signup(`credential-rotate-refused-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const token = await issueToken(cookie, boardId);
    const refused = await SELF.fetch(`${ORIGIN}/auth/password`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: "wrong horse battery", newPassword: "new horse battery staple" }),
    });
    expect(refused.status).toBe(401);
    expect((await callMcp(token)).status).not.toBe(401);
  });

  it("revokes every credential of the account when GitHub is disconnected", async () => {
    const cookie = await signup(`credential-disconnect-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const token = await issueToken(cookie, boardId);
    const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
    await env.DB.prepare("UPDATE users SET github_login = 'octo', github_user_id = ? WHERE id = ?").bind(Math.floor(Math.random() * 1e9), id).run();

    const disconnected = await SELF.fetch(`${ORIGIN}/me`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ githubLogin: null }),
    });
    expect(disconnected.status).toBe(200);
    expect((await callMcp(token)).status).toBe(401);
    expect(await activeCount(cookie)).toBe(0);
  });

  it("writes nothing for a session deleted after requireAuth checked it", async () => {
    const cookie = await signup(`credential-session-gone-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(cookie);
    const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
    const body = { name: "Counted", boardIds: [boardId], scopes: ["boards:read"], currentPassword: PASSWORD };
    const total = await queriesOf((worker) => worker.fetch("/me/agent-credentials", "POST", { cookie }, body));
    // The insert is the last query: the session row goes just before it, as another session's password change deletes it.
    const sessionHash = await sha256Hex(cookie.slice(cookie.indexOf("=") + 1));
    const late = await workerWithPausedD1(async (n) => {
      if (n === total - 1) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
    }).fetch("/me/agent-credentials", "POST", { cookie }, { ...body, name: "Late" });
    expect(late.status).toBe(401);
    expect(await env.DB.prepare("SELECT name FROM agent_credentials WHERE user_id = ? ORDER BY name").bind(id).all()).toMatchObject({ results: [{ name: "Counted" }] });
  });
});

async function issue(cookie: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
}

async function issueToken(cookie: string, boardId: string): Promise<string> {
  const response = await issue(cookie, { name: "Rotating", boardIds: [boardId], scopes: ["boards:read"], currentPassword: PASSWORD });
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

function callMcp(token: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
}

async function countNamed(cookie: string, name: string): Promise<number> {
  const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM agent_credentials WHERE user_id = ? AND name = ?").bind(id, name).first<{ count: number }>();
  return row?.count ?? -1;
}

async function activeCount(cookie: string): Promise<number> {
  const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM agent_credentials WHERE user_id = ? AND revoked_at IS NULL").bind(id).first<{ count: number }>();
  return row?.count ?? -1;
}
