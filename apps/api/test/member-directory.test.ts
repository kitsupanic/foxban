import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://foxban.test";
const request = (path: string, cookie: string, body?: unknown) => SELF.fetch(`${ORIGIN}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { cookie, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function fixture(inherited: boolean) {
  async function signup(email: string, invite?: string) {
    const response = await request("/auth/signup", "", { email, name: email, password: "correct horse battery", invite });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const { id } = await (await request("/me", cookie)).json<{ id: string }>();
    return { cookie, id };
  }
  const owner = await signup(`directory-${crypto.randomUUID()}@foxban.test`);
  const { token: invite } = await (await request("/invites", owner.cookie, {})).json<{ token: string }>();
  const member = await signup(`directory-${crypto.randomUUID()}@example.test`, invite);
  const response = await request("/boards", owner.cookie, {
    name: "Member directory", key: `D${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: await firstWorkspaceId(owner.cookie),
  });
  expect(response.status).toBe(200);
  const board = await response.json<{ id: string; workspaceId: string }>();
  if (inherited) {
    await env.DB.prepare("UPDATE boards SET access_mode='workspace' WHERE id=?").bind(board.id).run();
    await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'member',0,0)").bind(board.workspaceId, member.id).run();
  } else {
    await env.DB.prepare("INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'member')").bind(board.id, member.id).run();
  }
  const issued = await request("/me/agent-credentials", member.cookie, {
    name: "Directory reader", boardIds: [board.id], scopes: ["boards:read"],
  });
  expect(issued.status).toBe(201);
  const { token } = await issued.json<{ token: string }>();
  return { board, member, token, owner };
}

// Pause the real final read, after REST middleware or the MCP BoardDO read accepted access.
function beforeDirectoryRead(change: () => Promise<unknown>) {
  const original = env.DB.prepare.bind(env.DB);
  let armed = true;
  env.DB.prepare = (query: string) => {
    const statement = original(query);
    if (!query.includes("ORDER BY u.name,u.email,u.id") && !query.includes("ORDER BY users.id LIMIT ?") && !query.includes("ORDER BY users.name, users.email")) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const all = bound.all.bind(bound);
      bound.all = async <T>() => {
        if (armed) { armed = false; await change(); }
        return all<T>();
      };
      return bound;
    };
    return statement;
  };
  return () => { env.DB.prepare = original; expect(armed).toBe(false); };
}

describe("member directory current access", () => {
  for (const endpoint of ["REST", "REST candidates", "MCP"] as const) {
    for (const inherited of [false, true]) {
      it(`${endpoint} denies a final directory read after ${inherited ? "workspace" : "explicit"} access is removed`, async () => {
        const { board, member, token } = await fixture(inherited);
        const client = new Client({ name: "directory-race", version: "1.0.0" });
        if (endpoint === "MCP") await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: (input, init) => SELF.fetch(new Request(input, init)),
        }));
        const restore = beforeDirectoryRead(() => inherited
          ? env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(board.workspaceId, member.id).run()
          : env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?").bind(board.id, member.id).run());
        try {
          if (endpoint !== "MCP") {
            const response = await request(`/boards/${board.id}/${endpoint === "REST" ? "members" : "membership-candidates"}`, member.cookie);
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({ error: "forbidden" });
          } else {
            const response = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
            expect(response.isError).toBe(true);
            expect(response.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
            expect(response.structuredContent).not.toHaveProperty("data");
          }
        } finally { restore(); if (endpoint === "MCP") await client.close(); }
      });
    }
  }
  for (const endpoint of ["REST", "REST candidates", "MCP"] as const) {
    it(`${endpoint} retries when an access change starts before the final directory read`, async () => {
      const { board, member, token } = await fixture(false);
      const client = new Client({ name: "directory-pending", version: "1.0.0" });
      if (endpoint === "MCP") await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      }));
      const restore = beforeDirectoryRead(() => env.DB.prepare("UPDATE boards SET pending_access_operation_id=? WHERE id=?")
        .bind(crypto.randomUUID(), board.id).run());
      try {
        if (endpoint !== "MCP") {
          const response = await request(`/boards/${board.id}/${endpoint === "REST" ? "members" : "membership-candidates"}`, member.cookie);
          expect(response.status).toBe(503);
          expect(response.headers.get("Retry-After")).toBe("2");
          expect(await response.json()).toEqual({ code: "access_change_pending", error: "Board access is changing. Please retry." });
        } else {
          const response = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
          expect(response.isError).toBe(true);
          expect(response.structuredContent).toMatchObject({ ok: false, error: { code: "internal_error", retryable: true } });
          expect(response.structuredContent).not.toHaveProperty("data");
        }
      } finally { restore(); if (endpoint === "MCP") await client.close(); }
    });
  }
  it("keeps owner and operator access when the directory has no member rows", async () => {
    const { board, member, token, owner } = await fixture(false);
    await env.DB.prepare("UPDATE boards SET owner_id=? WHERE id=?").bind(member.id, board.id).run();
    await env.DB.prepare("DELETE FROM board_members WHERE board_id=?").bind(board.id).run();
    for (const cookie of [member.cookie, owner.cookie]) {
      const response = await request(`/boards/${board.id}/members`, cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ members: [] });
      const candidates = await request(`/boards/${board.id}/membership-candidates`, cookie);
      expect(candidates.status).toBe(200);
      const body = await candidates.json<{ candidates: Array<{ id: string }> }>();
      // The board's workspace is the owner's own: only its members are offered, not the board's new owner,
      // and the new owner is no member of that workspace (a Guest), so is offered nobody.
      expect(body.candidates.map((candidate) => candidate.id)).toEqual(cookie === owner.cookie ? [owner.id] : []);
      for (const candidate of body.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["avatarVersion", "email", "githubLogin", "id", "name"]);
      }
    }
    const client = new Client({ name: "directory-owner", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => SELF.fetch(new Request(input, init)),
    }));
    try {
      const response = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ ok: true, data: { members: { items: [], nextCursor: null } } });
    } finally { await client.close(); }
  });
  it("returns an empty candidate list only while the viewer remains authorized", async () => {
    const { board, member } = await fixture(false);
    await env.DB.prepare("INSERT OR IGNORE INTO board_members(board_id,user_id,role) SELECT ?,id,'member' FROM users").bind(board.id).run();
    const response = await request(`/boards/${board.id}/membership-candidates`, member.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ candidates: [] });
  });
});
