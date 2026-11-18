import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";

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
      body: JSON.stringify({ name: "Harness", boardIds: [boardId], scopes: ["boards:read"], expiresInDays: 1 }),
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
      body: JSON.stringify({ name: "Short lived", boardIds: [boardId], scopes: ["boards:read"], expiresInDays: 1 }),
    });
    const issued = await issue.json<{ credential: { id: string }; token: string }>();
    const call = () => SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: "{}" });
    expect((await call()).status).not.toBe(401);

    await env.DB.prepare("UPDATE agent_credentials SET created_at = ?1 - 1000, expires_at = ?1 WHERE id = ?2").bind(Date.now() - 1000, issued.credential.id).run();
    expect((await call()).status).toBe(401);
  });

  it("keeps bearer tokens exclusive to MCP and rejects inaccessible board batches", async () => {
    const anonymous = await SELF.fetch(`${ORIGIN}/me/agent-credentials`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const hostileOrigin = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      headers: { origin: "https://evil.test" },
    });
    expect(hostileOrigin.status).toBe(403);
    expect(hostileOrigin.headers.get("cache-control")).toBe("no-store");
    const owner = await signup(`credential-owner-${crypto.randomUUID()}@foxban.test`);
    const other = await signup(`credential-other-${crypto.randomUUID()}@foxban.test`);
    const boardId = await createBoard(owner);
    const mixed = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST", headers: { "content-type": "application/json", cookie: other },
      body: JSON.stringify({ name: "No access", boardIds: [boardId, crypto.randomUUID()], scopes: ["boards:read"] }),
    });
    expect(mixed.status).toBe(403);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent_credentials WHERE name = 'No access'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
