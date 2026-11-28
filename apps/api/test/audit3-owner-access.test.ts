import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { REALTIME_PROTOCOL_VERSION } from "@foxban/shared";

import { AccessChangeConflict, runAccessChange } from "../src/access-changes";
import type { SessionUser } from "../src/auth";

/**
 * A board's creator opens it only while they are a member of its workspace (ADR 0087). Removal or leaving takes the
 * creator's own `board_members` row with the membership, so they lose the board, and a board move to a workspace the
 * creator is not in takes the seat and does not give one again (ADR 0090). A row added by hand is a guest row, which anyone
 * who can open the board may remove.
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
const del = (path: string, body: unknown, session?: string) => request(path, "DELETE", body, session);

type Person = { cookie: string; id: string; email: string };
type Board = { id: string; key: string; workspaceId: string; capabilities: { canManageBoard: boolean } };

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", { email, name: email.split("@")[0], password: PASSWORD, ...(invite ? { invite } : {}) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** An instance Admin, who is the only one who can mint the invites ordinary accounts need. */
let operator: string;
beforeAll(async () => {
  operator = await signup(`owner-access-operator-${crypto.randomUUID()}@foxban.test`);
});

/** An ordinary account: it holds no power except through the workspaces and boards it is put in. */
async function person(): Promise<Person> {
  const { token } = await (await post("/invites", {}, operator)).json<{ token: string }>();
  const email = `person-${crypto.randomUUID()}@example.test`;
  const cookie = await signup(email, token);
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id, email };
}

async function createWorkspace(by: Person): Promise<string> {
  const response = await post("/workspaces", { name: "Team" }, by.cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function add(by: Person, workspaceId: string, who: Person) {
  expect((await post(`/workspaces/${workspaceId}/members`, { userId: who.id, role: "member", operationId: crypto.randomUUID() }, by.cookie)).status).toBe(200);
}

const removeFromWorkspace = (by: Person, workspaceId: string, who: Person) =>
  del(`/workspaces/${workspaceId}/members/${who.id}`, { operationId: crypto.randomUUID() }, by.cookie);

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted"): Promise<Board> {
  const response = await post(
    "/boards",
    { name: "Owner board", key: `O${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId, accessMode },
    by.cookie,
  );
  expect(response.status).toBe(200);
  return response.json<Board>();
}

/** A live board connection: the upgrade status, and the close code once it ends. */
async function connect(who: Person, boardId: string) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie: who.cookie },
  });
  if (response.status !== 101) return { status: response.status, closed: Promise.resolve(0) };
  const socket = response.webSocket!;
  socket.accept();
  return { status: 101, closed: new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code))) };
}

const closeCode = (closed: Promise<number>) => Promise.race([closed, scheduler.wait(5_000).then(() => "still open" as const)]);

/** Every way to reach a board the rule decides, as one comparable row. */
async function surfacesFor(who: Person, board: Board) {
  const probe = await connect(who, board.id);
  const listed = (await (await get("/boards", who.cookie)).json<Array<{ id: string }>>()).some((entry) => entry.id === board.id);
  return {
    byId: (await get(`/boards/${board.id}`, who.cookie)).status,
    byKey: (await get(`/boards/by-key/${board.key}`, who.cookie)).status,
    socket: probe.status,
    listed,
  };
}
const OPENS = { byId: 200, byKey: 200, socket: 101, listed: true };
const CLOSED = { byId: 403, byKey: 403, socket: 403, listed: false };

const boardRows = (boardId: string, userId: string) =>
  env.DB.prepare("SELECT role FROM board_members WHERE board_id=? AND user_id=?").bind(boardId, userId).all();

describe("a creator who is removed from or leaves the workspace", () => {
  for (const [leave, mode] of [["removed", "workspace"], ["removed", "restricted"], ["left", "workspace"]] as const) {
    it(`loses a ${mode} board they made, REST and socket, once ${leave}`, async () => {
      const admin = await person();
      const creator = await person();
      const workspace = await createWorkspace(admin);
      await add(admin, workspace, creator);
      const board = await createBoard(creator, workspace, mode);
      // A board someone else made, where the creator was added by hand: that grant is not theirs to lose.
      const other = await createBoard(admin, workspace, "restricted");
      expect((await post(`/boards/${other.id}/members`, { userId: creator.id }, admin.cookie)).status).toBe(200);
      const live = await connect(creator, board.id);
      expect(live.status).toBe(101);
      expect(await surfacesFor(creator, board)).toEqual(OPENS);

      expect((await (leave === "removed" ? removeFromWorkspace(admin, workspace, creator) : removeFromWorkspace(creator, workspace, creator))).status).toBe(200);

      expect(await closeCode(live.closed)).toBe(4010);
      expect(await surfacesFor(creator, board)).toEqual(CLOSED);
      expect((await boardRows(board.id, creator.id)).results).toEqual([]);
      expect(await env.DB.prepare("SELECT owner_id AS ownerId FROM boards WHERE id=?").bind(board.id).first()).toEqual({ ownerId: creator.id });
      expect(await surfacesFor(creator, other)).toEqual(OPENS);
      expect(await surfacesFor(admin, board)).toEqual(OPENS);

      // Joining again gives the creator their board back through ownership.
      await add(admin, workspace, creator);
      expect(await surfacesFor(creator, board)).toEqual(OPENS);
      expect((await get(`/boards/${board.id}`, creator.cookie).then((r) => r.json<Board>())).capabilities.canManageBoard).toBe(true);
    });
  }
});

describe("a creator outside the workspace", () => {
  /** `creator` made a board in a workspace `admin` runs; `admin` then moves it to another workspace the creator is not in. */
  async function movedAway() {
    const admin = await person();
    const creator = await person();
    const source = await createWorkspace(admin);
    const destination = await createWorkspace(admin);
    await add(admin, source, creator);
    const board = await createBoard(creator, source, "workspace");
    expect((await removeFromWorkspace(admin, source, creator)).status).toBe(200);
    // The removal fenced the board, so the move must name its new access version.
    const { accessVersion } = (await env.DB.prepare("SELECT access_version AS accessVersion FROM boards WHERE id=?").bind(board.id).first<{ accessVersion: number }>())!;
    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      { operationId: crypto.randomUUID(), destinationWorkspaceId: destination, expectedWorkspaceId: source, expectedAccessVersion: accessVersion },
      admin.cookie,
    );
    expect(moved.status).toBe(200);
    return { admin, creator, destination, board };
  }

  it("is not given a seat again by a board move to a workspace they are not in", async () => {
    const { creator, board } = await movedAway();
    expect(await surfacesFor(creator, board)).toEqual(CLOSED);
    expect((await boardRows(board.id, creator.id)).results).toEqual([]);
  });

  it("loses the seat when the board moves to a workspace they are not in while they are still in the source", async () => {
    const admin = await person();
    const creator = await person();
    const source = await createWorkspace(admin);
    const destination = await createWorkspace(admin);
    await add(admin, source, creator);
    const board = await createBoard(creator, source, "workspace");
    expect((await boardRows(board.id, creator.id)).results).toEqual([{ role: "member" }]);
    const live = await connect(creator, board.id);
    expect(live.status).toBe(101);

    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      { operationId: crypto.randomUUID(), destinationWorkspaceId: destination, expectedWorkspaceId: source, expectedAccessVersion: 0 },
      admin.cookie,
    );
    expect(moved.status).toBe(200);

    expect(await closeCode(live.closed)).toBe(4010);
    expect(await surfacesFor(creator, board)).toEqual(CLOSED);
    expect((await boardRows(board.id, creator.id)).results).toEqual([]);
    expect(await env.DB.prepare("SELECT owner_id AS ownerId FROM boards WHERE id=?").bind(board.id).first()).toEqual({ ownerId: creator.id });
    expect(await surfacesFor(admin, board)).toEqual(OPENS);
    // Joining the board's new workspace gives it back through ownership, as joining again does (ADR 0087).
    await add(admin, destination, creator);
    expect(await surfacesFor(creator, board)).toEqual(OPENS);
  });

  it("keeps a row added by hand when the board moves while they are outside the source", async () => {
    const admin = await person();
    const creator = await person();
    const source = await createWorkspace(admin);
    const destination = await createWorkspace(admin);
    await add(admin, source, creator);
    const board = await createBoard(creator, source, "workspace");
    expect((await removeFromWorkspace(admin, source, creator)).status).toBe(200);
    expect((await post(`/boards/${board.id}/members`, { userId: creator.id }, admin.cookie)).status).toBe(200);
    const { accessVersion } = (await env.DB.prepare("SELECT access_version AS accessVersion FROM boards WHERE id=?").bind(board.id).first<{ accessVersion: number }>())!;

    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      { operationId: crypto.randomUUID(), destinationWorkspaceId: destination, expectedWorkspaceId: source, expectedAccessVersion: accessVersion },
      admin.cookie,
    );
    expect(moved.status).toBe(200);

    // A guest grant survives a move like any guest's: the seat was already gone with the membership.
    expect((await boardRows(board.id, creator.id)).results).toEqual([{ role: "member" }]);
    expect(await surfacesFor(creator, board)).toEqual(OPENS);
  });

  it("keeps the seat a board move leaves while they are in the destination", async () => {
    const admin = await person();
    const creator = await person();
    const source = await createWorkspace(admin);
    const destination = await createWorkspace(admin);
    await add(admin, source, creator);
    await add(admin, destination, creator);
    const board = await createBoard(creator, source, "workspace");
    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      { operationId: crypto.randomUUID(), destinationWorkspaceId: destination, expectedWorkspaceId: source, expectedAccessVersion: 0 },
      admin.cookie,
    );
    expect(moved.status).toBe(200);
    expect((await boardRows(board.id, creator.id)).results).toEqual([{ role: "member" }]);
  });

  it("opens the board only through a row added by hand, and a board member removing it cuts them off", async () => {
    const { admin, creator, board } = await movedAway();
    expect((await post(`/boards/${board.id}/members`, { userId: creator.id }, admin.cookie)).status).toBe(200);
    expect(await surfacesFor(creator, board)).toEqual(OPENS);
    expect((await get(`/boards/${board.id}`, creator.cookie).then((r) => r.json<Board>())).capabilities.canManageBoard).toBe(false);
    const live = await connect(creator, board.id);
    expect(live.status).toBe(101);
    // Their own row stays theirs: nobody removes themselves.
    expect((await del(`/boards/${board.id}/members/${creator.id}`, {}, creator.cookie)).status).toBe(403);

    const removal = await del(`/boards/${board.id}/members/${creator.id}`, { operationId: crypto.randomUUID() }, admin.cookie);
    expect(removal.status).toBe(200);

    expect(await closeCode(live.closed)).toBe(4010);
    expect(await surfacesFor(creator, board)).toEqual(CLOSED);
    expect((await boardRows(board.id, creator.id)).results).toEqual([]);
    expect(await env.DB.prepare("SELECT owner_id AS ownerId FROM boards WHERE id=?").bind(board.id).first()).toEqual({ ownerId: creator.id });
    expect(await surfacesFor(admin, board)).toEqual(OPENS);
  });
});

describe("removing the board's creator while they are in its workspace", () => {
  it("answers 403 from the route and is refused by the journal when the route's check is bypassed", async () => {
    const admin = await person();
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(admin);
    await add(admin, workspace, creator);
    await add(admin, workspace, peer);
    const board = await createBoard(creator, workspace, "restricted");
    expect((await post(`/boards/${board.id}/members`, { userId: peer.id }, creator.cookie)).status).toBe(200);

    for (const by of [admin, peer, creator]) {
      const response = await del(`/boards/${board.id}/members/${creator.id}`, { operationId: crypto.randomUUID() }, by.cookie);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "board owner cannot be removed" });
    }

    const actor = (await env.DB.prepare(`SELECT id,email,name,github_login AS githubLogin,avatar_version AS avatarVersion,timezone FROM users WHERE id=?`).bind(admin.id).first<SessionUser>())!;
    await expect(
      runAccessChange(env, actor, {
        operationId: crypto.randomUUID(),
        kind: "board-member-remove",
        payload: { boardId: board.id, userId: creator.id },
        workspaceIds: [workspace],
        boards: [{ boardId: board.id, workspaceId: workspace }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    expect((await boardRows(board.id, creator.id)).results).toEqual([{ role: "member" }]);
    expect(await surfacesFor(creator, board)).toEqual(OPENS);
  });
});
