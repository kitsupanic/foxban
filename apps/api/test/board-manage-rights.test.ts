import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { ACCESS_CHANGE_ABORT, AccessChangeConflict, runAccessChange } from "../src/access-changes";
import type { SessionUser } from "../src/auth";
import { firstWorkspaceId } from "./first-workspace";
import { queriesOf, workerWithPausedD1 } from "./paused-d1";

/**
 * Who manages a board, and who may take a manager off it: the creator and a board manager
 * manage only while still in the board's workspace (a creator who is out of it opens the board only
 * through a guest row, ADR 0087), removing a board manager takes manage rights,
 * and a board is not "moved" to the workspace it is already in.
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
const patch = (path: string, body: unknown, session?: string) => request(path, "PATCH", body, session);
const del = (path: string, body: unknown, session?: string) => request(path, "DELETE", body, session);

type Person = { cookie: string; id: string; email: string };

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", { email, name: email.split("@")[0], password: PASSWORD, ...(invite ? { invite } : {}) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** An instance Admin, who is the only one who can mint the invites ordinary accounts need. */
let operator: string;
beforeAll(async () => {
  operator = await signup(`manage-operator-${crypto.randomUUID()}@foxban.test`);
});

/** An ordinary account: it holds no power except through the workspaces and boards it is put in. */
async function person(): Promise<Person> {
  const { token } = await (await post("/invites", {}, operator)).json<{ token: string }>();
  const email = `person-${crypto.randomUUID()}@example.test`;
  const cookie = await signup(email, token);
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id, email };
}

async function createWorkspace(by: Person, name = "Team"): Promise<string> {
  const response = await post("/workspaces", { name }, by.cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function add(by: Person, workspaceId: string, who: Person, role: "admin" | "member" = "member") {
  const response = await post(`/workspaces/${workspaceId}/members`, { userId: who.id, role, operationId: crypto.randomUUID() }, by.cookie);
  expect(response.status).toBe(200);
}

const removeFromWorkspace = (by: Person, workspaceId: string, who: Person) =>
  del(`/workspaces/${workspaceId}/members/${who.id}`, { operationId: crypto.randomUUID() }, by.cookie);

type Board = { id: string; workspaceId: string; accessMode: string; capabilities: { canManageBoard: boolean } };

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted" = "workspace"): Promise<Board> {
  const response = await post(
    "/boards",
    { name: "Rights board", key: `M${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId, accessMode },
    by.cookie,
  );
  expect(response.status).toBe(200);
  return response.json<Board>();
}

const sessionUser = async (who: Person) =>
  (await env.DB.prepare(`SELECT id,email,name,github_login AS githubLogin,avatar_version AS avatarVersion,timezone FROM users WHERE id=?`).bind(who.id).first<SessionUser>())!;

describe("a creator who is no longer in the workspace", () => {
  /**
   * A board made by `creator`, a plain member of a workspace `admin` runs; `leave` then takes them out of it,
   * which takes the board with it (ADR 0087), so `admin` adds them back to it as a guest.
   */
  async function scene(leave: "removed" | "left") {
    const admin = await person();
    const creator = await person();
    const workspace = await createWorkspace(admin);
    await add(admin, workspace, creator);
    const board = await createBoard(creator, workspace);
    expect(board.capabilities).toMatchObject({ canManageBoard: true });
    expect((await (leave === "removed" ? removeFromWorkspace(admin, workspace, creator) : removeFromWorkspace(creator, workspace, creator))).status).toBe(200);
    expect((await get(`/boards/${board.id}`, creator.cookie)).status).toBe(403);
    expect((await post(`/boards/${board.id}/members`, { userId: creator.id }, admin.cookie)).status).toBe(200);
    return { admin, creator, workspace, board };
  }

  for (const leave of ["removed", "left"] as const) {
    it(`opens the board only as a guest and loses every manage right once ${leave}`, async () => {
      const { admin, creator, workspace, board } = await scene(leave);

      const metadata = await get(`/boards/${board.id}`, creator.cookie);
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({ capabilities: { canManageBoard: false } });

      const own = await firstWorkspaceId(creator.cookie);
      expect((await patch(`/boards/${board.id}`, { name: "Renamed", key: "RNMD" }, creator.cookie)).status).toBe(403);
      expect((await post(`/boards/${board.id}/move-workspace`, {
        operationId: crypto.randomUUID(), destinationWorkspaceId: own, expectedWorkspaceId: workspace, expectedAccessVersion: 0,
      }, creator.cookie)).status).toBe(403);
      expect((await request(`/boards/${board.id}?operationId=${crypto.randomUUID()}`, "DELETE", undefined, creator.cookie)).status).toBe(403);
      expect(await env.DB.prepare("SELECT name,workspace_id AS workspaceId FROM boards WHERE id=?").bind(board.id).first()).toEqual({ name: "Rights board", workspaceId: workspace });

      // The workspace's admin still manages it, and joining again gives the creator their right back.
      expect((await get(`/boards/${board.id}`, admin.cookie).then((r) => r.json<Board>())).capabilities.canManageBoard).toBe(true);
      await add(admin, workspace, creator);
      expect((await get(`/boards/${board.id}`, creator.cookie).then((r) => r.json<Board>())).capabilities.canManageBoard).toBe(true);
    });
  }

  it("is refused by the journal itself when the routes' checks are bypassed", async () => {
    const { creator, workspace, board } = await scene("removed");
    await expect(
      runAccessChange(env, await sessionUser(creator), {
        operationId: crypto.randomUUID(),
        kind: "board-delete",
        payload: { boardId: board.id, workspaceId: workspace, ownerId: creator.id },
        workspaceIds: [workspace],
        boards: [{ boardId: board.id, workspaceId: workspace }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    expect(await env.DB.prepare("SELECT 1 FROM boards WHERE id=?").bind(board.id).first()).not.toBeNull();
  });
});

describe("a board manager who is no longer in the workspace", () => {
  it("keeps the open right but loses every manage right once removed from it", async () => {
    const admin = await person();
    const owner = await person();
    const manager = await person();
    const workspace = await createWorkspace(admin);
    await add(admin, workspace, owner);
    await add(admin, workspace, manager);
    const board = await createBoard(owner, workspace, "restricted");
    expect((await post(`/boards/${board.id}/members`, { userId: manager.id }, owner.cookie)).status).toBe(200);
    await env.DB.prepare("UPDATE board_members SET role='manager' WHERE board_id=? AND user_id=?").bind(board.id, manager.id).run();
    const rights = async () => (await get(`/boards/${board.id}`, manager.cookie).then((r) => r.json<Board>())).capabilities;
    expect(await rights()).toMatchObject({ canManageBoard: true });

    expect((await removeFromWorkspace(admin, workspace, manager)).status).toBe(200);

    expect(await rights()).toMatchObject({ canManageBoard: false });
    const own = await firstWorkspaceId(manager.cookie);
    expect((await patch(`/boards/${board.id}`, { name: "Renamed", key: "RNMD" }, manager.cookie)).status).toBe(403);
    expect((await post(`/boards/${board.id}/move-workspace`, {
      operationId: crypto.randomUUID(), destinationWorkspaceId: own, expectedWorkspaceId: workspace, expectedAccessVersion: 0,
    }, manager.cookie)).status).toBe(403);
    expect((await request(`/boards/${board.id}?operationId=${crypto.randomUUID()}`, "DELETE", undefined, manager.cookie)).status).toBe(403);
    expect(await env.DB.prepare("SELECT name,workspace_id AS workspaceId FROM boards WHERE id=?").bind(board.id).first()).toEqual({ name: "Rights board", workspaceId: workspace });

    // Joining again gives the manager their grant's right back.
    await add(admin, workspace, manager);
    expect(await rights()).toMatchObject({ canManageBoard: true });
  });
});

describe("moving a board to the workspace it is already in", () => {
  it("answers 400, not a retryable conflict, and changes nothing", async () => {
    const owner = await person();
    const workspace = await createWorkspace(owner);
    const board = await createBoard(owner, workspace);
    const operationId = crypto.randomUUID();
    const response = await post(`/boards/${board.id}/move-workspace`, {
      operationId, destinationWorkspaceId: workspace, expectedWorkspaceId: workspace, expectedAccessVersion: 0,
    }, owner.cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "board is already in that workspace" });
    expect(await env.DB.prepare("SELECT 1 FROM access_change_operations WHERE id=?").bind(operationId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT workspace_id AS workspaceId,access_mode AS accessMode FROM boards WHERE id=?").bind(board.id).first()).toEqual({ workspaceId: workspace, accessMode: "workspace" });
  });
});

describe("a workspace role change refused for want of the right", () => {
  it("answers 403 forbidden, not 404 member not found, when the journal recorded a forbidden abort", async () => {
    const admin = await person();
    const member = await person();
    const workspace = await createWorkspace(admin);
    await add(admin, workspace, member);
    // The attempt lost its authority between the route's read and the commit: the journal holds a settled abort.
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,outcome,result_json,notify_user_ids_json,notified,created_at,updated_at)
       VALUES(?,?,'workspace-member-role',?,'hash','completed','aborted',?,'[]',1,?,?)`,
    )
      .bind(operationId, admin.id, JSON.stringify({ workspaceId: workspace, userId: member.id, role: "admin" }), JSON.stringify(ACCESS_CHANGE_ABORT.forbidden), Date.now(), Date.now())
      .run();
    const replay = await patch(`/workspaces/${workspace}/members/${member.id}`, { role: "admin", operationId }, admin.cookie);
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({ error: "forbidden" });
    expect(await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace, member.id).first()).toEqual({ role: "member" });
  });
});

describe("removing a board manager", () => {
  /** A board owned by a workspace member, with two managers (X, T, who are members of its workspace), a plain guest (M) and a second plain guest (P). */
  async function scene() {
    const admin = await person();
    const owner = await person();
    const workspace = await createWorkspace(admin);
    await add(admin, workspace, owner);
    const board = await createBoard(owner, workspace, "restricted");
    const [x, t, m, p] = [await person(), await person(), await person(), await person()];
    for (const who of [x, t, m, p]) expect((await post(`/boards/${board.id}/members`, { userId: who.id }, owner.cookie)).status).toBe(200);
    for (const who of [x, t]) await add(admin, workspace, who);
    for (const who of [x, t]) await env.DB.prepare("UPDATE board_members SET role='manager' WHERE board_id=? AND user_id=?").bind(board.id, who.id).run();
    return { admin, owner, workspace, board, x, t, m, p };
  }
  const remove = (by: Person, boardId: string, who: Person) => del(`/boards/${boardId}/members/${who.id}`, { operationId: crypto.randomUUID() }, by.cookie);
  const isMember = async (boardId: string, who: Person) =>
    (await env.DB.prepare("SELECT 1 FROM board_members WHERE board_id=? AND user_id=?").bind(boardId, who.id).first()) !== null;

  it("takes manage rights: a plain member is refused, a manager, the owner and a workspace admin are not", async () => {
    const { owner, board, x, t, m, p } = await scene();
    const refused = await remove(m, board.id, t);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });
    expect(await isMember(board.id, t)).toBe(true);

    // Anyone on the board still removes a plain member.
    expect((await remove(m, board.id, p)).status).toBe(200);
    expect(await isMember(board.id, p)).toBe(false);

    expect((await remove(x, board.id, t)).status).toBe(200);
    expect(await isMember(board.id, t)).toBe(false);
    expect((await remove(owner, board.id, x)).status).toBe(200);
    expect(await isMember(board.id, x)).toBe(false);

    // An admin of the board's workspace, with no grant on this Private board, manages it too.
    const second = await scene();
    expect((await remove(second.admin, second.board.id, second.x)).status).toBe(200);
    expect(await isMember(second.board.id, second.x)).toBe(false);
  });

  it("is refused at the reservation when the route's check is bypassed", async () => {
    const { board, workspace, t, m } = await scene();
    await expect(
      runAccessChange(env, await sessionUser(m), {
        operationId: crypto.randomUUID(),
        kind: "board-member-remove",
        payload: { boardId: board.id, userId: t.id },
        workspaceIds: [workspace],
        boards: [{ boardId: board.id, workspaceId: workspace }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    expect(await isMember(board.id, t)).toBe(true);
  });

  it("never removes a manager after the remover lost the role, at any point of the removal", async () => {
    const path = (s: { board: Board; t: Person }) => `/boards/${s.board.id}/members/${s.t.id}`;
    const gaps = await queriesOf(async (hooked) => {
      const s = await scene();
      return hooked.fetch(path(s), "DELETE", s.x, { operationId: crypto.randomUUID() });
    });
    expect(gaps).toBeGreaterThan(5);

    const seen = new Set<number>();
    for (let gap = 0; gap <= gaps; gap++) {
      const s = await scene();
      let fired = false;
      let removedFirst = false;
      const fire = async () => {
        fired = true;
        removedFirst = !(await isMember(s.board.id, s.t));
        await env.DB.prepare("UPDATE board_members SET role='member' WHERE board_id=? AND user_id=?").bind(s.board.id, s.x.id).run();
      };
      const response = await workerWithPausedD1(async (n) => {
        if (n === gap) await fire();
      }).fetch(path(s), "DELETE", s.x, { operationId: crypto.randomUUID() });
      // One past the last query means: the demotion arrives after the removal is over.
      if (!fired) await fire();
      seen.add(response.status);
      // The manager went only while the remover still held the role.
      if (!removedFirst) expect(await isMember(s.board.id, s.t), `removed after the demotion, gap ${gap}`).toBe(true);
    }
    expect(seen.has(200)).toBe(true);
    expect([...seen].some((status) => status === 403 || status === 409)).toBe(true);
  }, 120_000);
});
