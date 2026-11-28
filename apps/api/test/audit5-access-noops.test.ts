import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { REALTIME_PROTOCOL_VERSION } from "@foxban/shared";

/**
 * A membership write that would change nothing runs no access change (ADR 0090): no journal row, no fence, no
 * closed socket. Otherwise anyone who can open a board could loop a no-op and drop every connection to it. Only
 * while no access change holds the workspace; one in flight still meets its conflict.
 */
const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function request(path: string, method: string, body?: unknown, session?: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { cookie: session } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (path: string, body: unknown, session?: string) => request(path, "POST", body, session);
const get = (path: string, session?: string) => request(path, "GET", undefined, session);

type Person = { cookie: string; id: string };

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", { email, name: email.split("@")[0], password: PASSWORD, ...(invite ? { invite } : {}) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** An instance Admin, who is the only one who can mint the invites ordinary accounts need. */
let operator: string;
beforeAll(async () => {
  operator = await signup(`noops-operator-${crypto.randomUUID()}@foxban.test`);
});

async function person(): Promise<Person> {
  const { token } = await (await post("/invites", {}, operator)).json<{ token: string }>();
  const cookie = await signup(`person-${crypto.randomUUID()}@example.test`, token);
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id };
}

async function team(): Promise<{ admin: Person; member: Person; workspace: string; board: string }> {
  const admin = await person();
  const member = await person();
  const created = await post("/workspaces", { name: "Team" }, admin.cookie);
  expect(created.status).toBe(201);
  const workspace = (await created.json<{ workspace: { id: string } }>()).workspace.id;
  expect((await post(`/workspaces/${workspace}/members`, { userId: member.id, role: "member", operationId: crypto.randomUUID() }, admin.cookie)).status).toBe(200);
  const board = await post(
    "/boards",
    { name: "No-op board", key: `N${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: workspace, accessMode: "workspace" },
    admin.cookie,
  );
  expect(board.status).toBe(200);
  return { admin, member, workspace, board: (await board.json<{ id: string }>()).id };
}

/** A live board connection, and whether it is still open a moment later. */
async function connect(who: Person, boardId: string) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie: who.cookie },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  return { stillOpen: () => Promise.race([closed.then(() => false), scheduler.wait(300).then(() => true)]), close: () => socket.close() };
}

const accessVersion = async (boardId: string) =>
  (await env.DB.prepare("SELECT access_version AS v FROM boards WHERE id=?").bind(boardId).first<{ v: number }>())!.v;
const journaled = async (operationId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?").bind(operationId).first<{ n: number }>())!.n;
const holdWorkspace = (workspaceId: string) =>
  env.DB.prepare("INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)").bind(workspaceId, crypto.randomUUID()).run();
const releaseWorkspace = (workspaceId: string) =>
  env.DB.prepare("DELETE FROM access_change_scopes WHERE workspace_id=?").bind(workspaceId).run();
const CONFLICT = { error: "access change conflict", code: "access_change_conflict" };

describe("a board member add or remove that changes nothing", () => {
  it("adding someone who already has a board row answers success without an access change", async () => {
    const { admin, member, board } = await team();
    expect((await post(`/boards/${board}/members`, { userId: member.id, operationId: crypto.randomUUID() }, admin.cookie)).status).toBe(200);
    const version = await accessVersion(board);
    const live = await connect(admin, board);

    const operationId = crypto.randomUUID();
    const again = await post(`/boards/${board}/members`, { userId: member.id, operationId }, member.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(await journaled(operationId)).toBe(0);
    expect(await accessVersion(board)).toBe(version);
    expect(await live.stillOpen()).toBe(true);
    live.close();
  });

  it("still runs an add for a workspace member without a row: it writes one", async () => {
    const { admin, member, board } = await team();
    const operationId = crypto.randomUUID();
    expect((await post(`/boards/${board}/members`, { userId: member.id, operationId }, admin.cookie)).status).toBe(200);
    expect(await journaled(operationId)).toBe(1);
    expect(await env.DB.prepare("SELECT role FROM board_members WHERE board_id=? AND user_id=?").bind(board, member.id).first()).toEqual({ role: "member" });
  });

  it("removing someone with no board row answers success without an access change", async () => {
    const { admin, member, board } = await team();
    const version = await accessVersion(board);
    const live = await connect(admin, board);

    const operationId = crypto.randomUUID();
    const removed = await request(`/boards/${board}/members/${member.id}`, "DELETE", { operationId }, admin.cookie);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(await journaled(operationId)).toBe(0);
    expect(await accessVersion(board)).toBe(version);
    expect(await live.stillOpen()).toBe(true);
    live.close();
    // The refusals still come first: nobody removes themselves, row or not.
    expect((await request(`/boards/${board}/members/${member.id}`, "DELETE", { operationId: crypto.randomUUID() }, member.cookie)).status).toBe(403);
  });

  it("goes through the access change, and its conflict, while one holds the workspace", async () => {
    const { admin, member, workspace, board } = await team();
    expect((await post(`/boards/${board}/members`, { userId: member.id, operationId: crypto.randomUUID() }, admin.cookie)).status).toBe(200);
    const stranger = await person();
    await holdWorkspace(workspace);
    try {
      const add = await post(`/boards/${board}/members`, { userId: member.id, operationId: crypto.randomUUID() }, admin.cookie);
      expect(add.status).toBe(409);
      expect(await add.json()).toEqual(CONFLICT);
      const remove = await request(`/boards/${board}/members/${stranger.id}`, "DELETE", { operationId: crypto.randomUUID() }, admin.cookie);
      expect(remove.status).toBe(409);
      expect(await remove.json()).toEqual(CONFLICT);
    } finally {
      await releaseWorkspace(workspace);
    }
  });

  it("answers a recorded attempt from the journal first", async () => {
    const { admin, member, board } = await team();
    const operationId = crypto.randomUUID();
    expect((await post(`/boards/${board}/members`, { userId: member.id, operationId }, admin.cookie)).status).toBe(200);
    // The same id for another target is a different operation, not a no-op, even though that target has a row too.
    const reused = await post(`/boards/${board}/members`, { userId: admin.id, operationId }, admin.cookie);
    expect(reused.status).toBe(409);
    expect((await post(`/boards/${board}/members`, { userId: member.id, operationId }, admin.cookie)).status).toBe(200);
    expect(await journaled(operationId)).toBe(1);
  });
});

describe("a workspace role change to the role the person already holds", () => {
  it("answers success without an access change", async () => {
    const { admin, member, workspace, board } = await team();
    const version = await accessVersion(board);
    const live = await connect(member, board);

    for (const [who, role] of [[member, "member"], [admin, "admin"]] as const) {
      const operationId = crypto.randomUUID();
      const response = await request(`/workspaces/${workspace}/members/${who.id}`, "PATCH", { role, operationId }, admin.cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ operationId, state: "completed", outcome: "committed", result: { ok: true } });
      expect(await journaled(operationId)).toBe(0);
    }
    expect(await accessVersion(board)).toBe(version);
    expect(await live.stillOpen()).toBe(true);
    live.close();

    // Only an admin may set roles, no-op or not.
    expect((await request(`/workspaces/${workspace}/members/${member.id}`, "PATCH", { role: "member", operationId: crypto.randomUUID() }, member.cookie)).status).toBe(403);
    // A real change still runs one.
    const promotion = crypto.randomUUID();
    expect((await request(`/workspaces/${workspace}/members/${member.id}`, "PATCH", { role: "admin", operationId: promotion }, admin.cookie)).status).toBe(200);
    expect(await journaled(promotion)).toBe(1);
    expect(await accessVersion(board)).toBe(version + 1);
  });

  it("goes through the access change, and its conflict, while one holds the workspace", async () => {
    const { admin, member, workspace } = await team();
    await holdWorkspace(workspace);
    try {
      const response = await request(`/workspaces/${workspace}/members/${member.id}`, "PATCH", { role: "member", operationId: crypto.randomUUID() }, admin.cookie);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(CONFLICT);
    } finally {
      await releaseWorkspace(workspace);
    }
  });
});
