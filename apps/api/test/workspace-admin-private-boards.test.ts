import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { PresenceServerMessageSchema, REALTIME_PROTOCOL_VERSION } from "@foxban/shared";

/**
 * Who may open a Private board (ADR 0066): its board members and the admins of
 * its workspace. The rule is written in several places (the accessible-board
 * lookup, the board list, the WebSocket connect, the BoardDO's own check, and the
 * routes that re-assert it with their write), so every viewer kind is run against
 * every surface: one place being wrong shows up as a row that disagrees.
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

type Person = { cookie: string; id: string };
type Board = { id: string; key: string; viaWorkspaceAdmin: boolean; capabilities: { canManageBoard: boolean; canManageColumns: boolean } };

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", {
    email,
    name: email.split("@")[0],
    password: PASSWORD,
    ...(invite ? { invite } : {}),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** A signup on `@foxban.test` is an instance Admin (admin-signups.ts): an Operator, who reaches every board. */
let operatorCookie: string;
let operator: Person;
beforeAll(async () => {
  operatorCookie = await signup(`operator-${crypto.randomUUID()}@foxban.test`);
  operator = { cookie: operatorCookie, id: (await (await get("/me", operatorCookie)).json<{ id: string }>()).id };
});

/** An ordinary account: it holds no power except through the workspaces and boards it is put in. */
async function person(): Promise<Person> {
  const minted = await post("/invites", {}, operatorCookie);
  const { token } = await minted.json<{ token: string }>();
  const cookie = await signup(`person-${crypto.randomUUID()}@example.test`, token);
  const me = await (await get("/me", cookie)).json<{ id: string }>();
  return { cookie, id: me.id };
}

async function createWorkspace(by: Person, name = "Team"): Promise<string> {
  const response = await post("/workspaces", { name }, by.cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function addToWorkspace(by: Person, workspaceId: string, who: Person, role: "admin" | "member" = "member") {
  const response = await post(
    `/workspaces/${workspaceId}/members`,
    { userId: who.id, role, operationId: crypto.randomUUID() },
    by.cookie,
  );
  expect(response.status).toBe(200);
}

const setRole = (by: Person, workspaceId: string, who: Person, role: "admin" | "member") =>
  patch(`/workspaces/${workspaceId}/members/${who.id}`, { role, operationId: crypto.randomUUID() }, by.cookie);
const removeFromWorkspace = (by: Person, workspaceId: string, who: Person) =>
  del(`/workspaces/${workspaceId}/members/${who.id}`, { operationId: crypto.randomUUID() }, by.cookie);

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted"): Promise<Board> {
  const response = await post(
    "/boards",
    {
      name: "Private board",
      key: `P${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      workspaceId,
      accessMode,
    },
    by.cookie,
  );
  expect(response.status).toBe(200);
  return response.json<Board>();
}

async function addToBoard(by: Person, boardId: string, who: Person) {
  const response = await post(`/boards/${boardId}/members`, { userId: who.id }, by.cookie);
  expect(response.status).toBe(200);
}

/** A live board connection: the upgrade status, and the close code once it ends. */
async function connect(who: Person, boardId: string) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie: who.cookie },
  });
  if (response.status !== 101) return { status: response.status, socket: null, closed: Promise.resolve(0) };
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  return { status: 101, socket, closed };
}

async function closeCode(closed: Promise<number>): Promise<number | "still open"> {
  return Promise.race([closed, scheduler.wait(5_000).then(() => "still open" as const)]);
}

type Surfaces = { list: boolean; listInWorkspace: boolean; byKey: number; byId: number; socket: number };
/** Every way to reach a board the rule decides, as one comparable row. */
async function surfacesFor(who: Person, board: Board, workspaceId: string): Promise<Surfaces> {
  const inList = async (path: string) =>
    (await (await get(path, who.cookie)).json<Array<{ id: string }>>()).some((listed) => listed.id === board.id);
  const probe = await connect(who, board.id);
  probe.socket?.close(1000, "test finished");
  return {
    list: await inList("/boards"),
    listInWorkspace: await inList(`/boards?workspaceId=${workspaceId}`),
    byKey: (await get(`/boards/by-key/${board.key}`, who.cookie)).status,
    byId: (await get(`/boards/${board.id}`, who.cookie)).status,
    socket: probe.status,
  };
}
const CAN_OPEN: Surfaces = { list: true, listInWorkspace: true, byKey: 200, byId: 200, socket: 101 };
const CANNOT_OPEN: Surfaces = { list: false, listInWorkspace: false, byKey: 403, byId: 403, socket: 403 };

let viewers: Record<"founder" | "author" | "admin" | "member" | "boardMember" | "guest" | "stranger", Person> | undefined;
beforeAll(async () => {
  viewers = {
    founder: await person(),
    author: await person(),
    admin: await person(),
    member: await person(),
    boardMember: await person(),
    guest: await person(),
    stranger: await person(),
  };
}, 60_000);

/**
 * One workspace with a Private board and one of each kind of viewer. The board's
 * author is a plain workspace member, so `admin` is on the board only through the
 * workspace.
 */
async function privateBoardWithEveryViewer() {
  // The accounts are made once for the file (signup hashes a password); what each test
  // owns is its workspace, so no role or grant leaks from one test into the next.
  const { founder, author, admin, member, boardMember, guest, stranger } = viewers!;
  const workspaceId = await createWorkspace(founder);
  await addToWorkspace(founder, workspaceId, author);
  await addToWorkspace(founder, workspaceId, admin, "admin");
  await addToWorkspace(founder, workspaceId, member);
  await addToWorkspace(founder, workspaceId, boardMember);
  const board = await createBoard(author, workspaceId, "restricted");
  await addToBoard(author, board.id, boardMember);
  await addToBoard(author, board.id, guest);
  return { founder, author, admin, member, boardMember, guest, stranger, workspaceId, board };
}

describe("who can open a Private board, on every surface", () => {
  it("opens it for board members, the board's Guests, workspace admins and Operators, and for no one else", async () => {
    const { founder, author, admin, member, boardMember, guest, stranger, workspaceId, board } =
      await privateBoardWithEveryViewer();
    const rows = {
      author: await surfacesFor(author, board, workspaceId),
      boardMember: await surfacesFor(boardMember, board, workspaceId),
      // Not a workspace member: added to this one board only.
      guest: await surfacesFor(guest, board, workspaceId),
      admin: await surfacesFor(admin, board, workspaceId),
      founderAdmin: await surfacesFor(founder, board, workspaceId),
      operator: await surfacesFor(operator, board, workspaceId),
      // A workspace member who was not added: Private still means something.
      member: await surfacesFor(member, board, workspaceId),
      stranger: await surfacesFor(stranger, board, workspaceId),
    };
    expect(rows).toEqual({
      author: CAN_OPEN,
      boardMember: CAN_OPEN,
      guest: CAN_OPEN,
      admin: CAN_OPEN,
      founderAdmin: CAN_OPEN,
      // An Operator opens it directly and through the workspace page they operate, but the default board list holds only what they have as a member or Guest.
      operator: { ...CAN_OPEN, list: false },
      member: CANNOT_OPEN,
      stranger: CANNOT_OPEN,
    });
  });

  it("keeps a Workspace board open to every member and closed to a stranger, as before", async () => {
    const { author, member, stranger, workspaceId } = await privateBoardWithEveryViewer();
    const shared = await createBoard(author, workspaceId, "workspace");
    expect(await surfacesFor(member, shared, workspaceId)).toEqual(CAN_OPEN);
    expect(await surfacesFor(stranger, shared, workspaceId)).toEqual(CANNOT_OPEN);
  });

  it("counts a Private board in the workspace's board count only for those who may open it", async () => {
    const { admin, member, stranger, workspaceId } = await privateBoardWithEveryViewer();
    const countFor = async (who: Person) => {
      const listed = (await (await get("/workspaces", who.cookie)).json<{ workspaces: Array<{ id: string; boardCount: number }> }>()).workspaces;
      const single = (await (await get(`/workspaces/${workspaceId}`, who.cookie)).json<{ workspace: { boardCount: number } }>()).workspace;
      expect(single.boardCount).toBe(listed.find((workspace) => workspace.id === workspaceId)?.boardCount);
      return single.boardCount;
    };
    expect(await countFor(admin)).toBe(1);
    expect(await countFor(member)).toBe(0);
    expect((await get(`/workspaces/${workspaceId}`, stranger.cookie)).status).toBe(403);
  });

  it("gives an admin of another workspace nothing on this workspace's Private board", async () => {
    const { board, workspaceId } = await privateBoardWithEveryViewer();
    const other = await person();
    await createWorkspace(other, "Elsewhere");
    expect(await surfacesFor(other, board, workspaceId)).toEqual(CANNOT_OPEN);
  });
});

/** A message-driven presence client: tests await real frames, never a guessed delay. */
async function connectPresence(who: Person) {
  const response = await SELF.fetch(`${ORIGIN}/presence/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie: who.cookie },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: unknown[] = [];
  const waiters: Array<() => void> = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
    waiters.shift()?.();
  });
  const invalidations = () =>
    frames.map((frame) => PresenceServerMessageSchema.parse(frame)).filter((frame) => frame.type === "workspace.invalidated");
  return {
    async nextInvalidation() {
      for (;;) {
        if (invalidations().length > 0) return invalidations();
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

describe("telling a workspace admin they are on a Private board only as one", () => {
  /** The flag as every board-metadata read reports it: by key, by id and in the board list. */
  async function noted(who: Person, board: Board, workspaceId: string) {
    const byKey = (await (await get(`/boards/by-key/${board.key}`, who.cookie)).json<Board>()).viaWorkspaceAdmin;
    const byId = (await (await get(`/boards/${board.id}`, who.cookie)).json<Board>()).viaWorkspaceAdmin;
    const listed = (await (await get(`/boards?workspaceId=${workspaceId}`, who.cookie)).json<Board[]>()).find((entry) => entry.id === board.id)
      ?.viaWorkspaceAdmin;
    expect([byId, listed]).toEqual([byKey, byKey]);
    return byKey;
  }

  it("flags it for an admin who is not on the board, and for no one else", async () => {
    const { founder, author, admin, boardMember, guest, workspaceId, board } = await privateBoardWithEveryViewer();
    expect(await noted(admin, board, workspaceId)).toBe(true);
    expect(await noted(founder, board, workspaceId)).toBe(true);
    expect(await noted(author, board, workspaceId)).toBe(false);
    expect(await noted(boardMember, board, workspaceId)).toBe(false);
    expect(await noted(guest, board, workspaceId)).toBe(false);
    // An Operator is not in the workspace at all: Operator access is a different story.
    expect(await noted(operator, board, workspaceId)).toBe(false);
  });

  it("drops the flag once the admin is a board member, and brings it back when they are removed from the board", async () => {
    const { author, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    expect(await noted(admin, board, workspaceId)).toBe(true);
    await addToBoard(author, board.id, admin);
    expect(await noted(admin, board, workspaceId)).toBe(false);
    expect((await del(`/boards/${board.id}/members/${admin.id}`, { operationId: crypto.randomUUID() }, author.cookie)).status).toBe(200);
    expect(await noted(admin, board, workspaceId)).toBe(true);
  });

  it("does not flag the admin who made the board, nor any Workspace board", async () => {
    const { admin, workspaceId } = await privateBoardWithEveryViewer();
    const own = await createBoard(admin, workspaceId, "restricted");
    expect(await noted(admin, own, workspaceId)).toBe(false);
    expect(own.viaWorkspaceAdmin).toBe(false);
    const shared = await createBoard(admin, workspaceId, "workspace");
    const other = await person();
    await addToWorkspace(admin, workspaceId, other, "admin");
    expect(await noted(other, shared, workspaceId)).toBe(false);
  });
});

describe("changing a workspace role changes access to its Private boards", () => {
  it("drops a demoted admin's open connection to a Private board they are not a member of", async () => {
    const { founder, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const { status, closed } = await connect(admin, board.id);
    expect(status).toBe(101);

    const demoted = await setRole(founder, workspaceId, admin, "member");
    expect(await demoted.json()).toMatchObject({ state: "completed", outcome: "committed" });
    expect(await closeCode(closed)).toBe(4010);
    // Every way back in is closed with it.
    expect(await surfacesFor(admin, board, workspaceId)).toEqual(CANNOT_OPEN);
  });

  it("drops the connection of an admin who is removed from the workspace", async () => {
    const { founder, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const { status, closed } = await connect(admin, board.id);
    expect(status).toBe(101);

    expect((await removeFromWorkspace(founder, workspaceId, admin)).status).toBe(200);
    expect(await closeCode(closed)).toBe(4010);
    expect(await surfacesFor(admin, board, workspaceId)).toEqual(CANNOT_OPEN);
  });

  it("drops the connection of an admin who leaves the workspace themselves", async () => {
    const { admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const { status, closed } = await connect(admin, board.id);
    expect(status).toBe(101);

    expect((await removeFromWorkspace(admin, workspaceId, admin)).status).toBe(200);
    expect(await closeCode(closed)).toBe(4010);
    expect(await surfacesFor(admin, board, workspaceId)).toEqual(CANNOT_OPEN);
  });

  it("keeps a demoted admin on a Private board they were added to", async () => {
    const { founder, author, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    await addToBoard(author, board.id, admin);
    const { closed } = await connect(admin, board.id);

    expect((await setRole(founder, workspaceId, admin, "member")).status).toBe(200);
    // The fence closes every connection to the board while the change lands...
    expect(await closeCode(closed)).toBe(4010);
    // ...and the board member is let straight back in, but no longer manages it.
    expect(await surfacesFor(admin, board, workspaceId)).toEqual(CAN_OPEN);
    expect((await (await get(`/boards/${board.id}`, admin.cookie)).json<Board>()).capabilities.canManageBoard).toBe(false);
  });

  it("gives a promoted member access, and tells them so without a reload", async () => {
    const { founder, member, workspaceId, board } = await privateBoardWithEveryViewer();
    expect(await surfacesFor(member, board, workspaceId)).toEqual(CANNOT_OPEN);
    const presence = await connectPresence(member);

    const promoted = await setRole(founder, workspaceId, member, "admin");
    expect(await promoted.json()).toMatchObject({ state: "completed", outcome: "committed" });
    expect(await surfacesFor(member, board, workspaceId)).toEqual(CAN_OPEN);
    // The hint names the workspace, which is what makes an open page refetch its board lists.
    expect(await presence.nextInvalidation()).toEqual([expect.objectContaining({ workspaceIds: [workspaceId] })]);
  });

  it("tells a demoted admin about the Private board they lost", async () => {
    const { founder, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const presence = await connectPresence(admin);

    expect((await setRole(founder, workspaceId, admin, "member")).status).toBe(200);
    expect(await presence.nextInvalidation()).toEqual([
      expect.objectContaining({ workspaceIds: [workspaceId], boardIds: expect.arrayContaining([board.id]) }),
    ]);
  });
});

/** One column mutation over a live connection: the board's own verdict on what the viewer may do. */
async function createColumn(who: Person, boardId: string): Promise<{ type: string; message?: string }> {
  const { socket } = await connect(who, boardId);
  expect(socket).not.toBeNull();
  const frames: Array<{ type: string; mutationId?: string; message?: string }> = [];
  const waiting: Array<() => void> = [];
  socket!.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
    waiting.shift()?.();
  });
  try {
    const mutationId = crypto.randomUUID();
    socket!.send(JSON.stringify({ type: "column.create", mutationId, id: crypto.randomUUID(), title: "Todo", position: "a0" }));
    for (;;) {
      const answer = frames.find((frame) => frame.mutationId === mutationId);
      if (answer) return answer;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  } finally {
    socket!.close(1000, "test finished");
  }
}

const moveBoard = (by: Person, board: Board, from: string, to: string, accessVersion: number) =>
  post(
    `/boards/${board.id}/move-workspace`,
    { destinationWorkspaceId: to, expectedWorkspaceId: from, expectedAccessVersion: accessVersion, operationId: crypto.randomUUID() },
    by.cookie,
  );
const accessVersionOf = async (by: Person, board: Board) =>
  (await (await get(`/boards/${board.id}`, by.cookie)).json<{ accessVersion: number }>()).accessVersion;

describe("a workspace admin manages a Private board they were not added to", () => {
  it("holds board management in the metadata they are shown", async () => {
    const { admin, member, boardMember, board } = await privateBoardWithEveryViewer();
    const metadata = async (who: Person) =>
      (await (await get(`/boards/by-key/${board.key}`, who.cookie)).json<Board>()).capabilities;
    expect(await metadata(admin)).toMatchObject({ canManageBoard: true, canManageColumns: true });
    // A board member who is not a manager keeps what they had.
    expect(await metadata(boardMember)).toMatchObject({ canManageBoard: false, canManageColumns: false });
    expect((await get(`/boards/by-key/${board.key}`, member.cookie)).status).toBe(403);
  });

  it("renames and re-keys it, and a board member who is not a manager cannot", async () => {
    const { admin, boardMember, board } = await privateBoardWithEveryViewer();
    const edit = { name: "Renamed", key: `Z${board.key.slice(1)}`, icon: "rocket", color: "teal" };
    expect((await patch(`/boards/${board.id}`, edit, boardMember.cookie)).status).toBe(403);
    expect((await patch(`/boards/${board.id}`, edit, admin.cookie)).status).toBe(200);
    expect(await (await get(`/boards/${board.id}`, admin.cookie)).json()).toMatchObject({ name: "Renamed", key: edit.key });
  });

  it("changes its columns over the live connection, as a board member who is not a manager cannot", async () => {
    const { admin, boardMember, board } = await privateBoardWithEveryViewer();
    expect(await createColumn(boardMember, board.id)).toMatchObject({ type: "error", message: expect.stringMatching(/owner or an admin/) });
    expect(await createColumn(admin, board.id)).toMatchObject({ type: "column.create" });
  });

  it("reads and changes the board's members", async () => {
    const { admin, member, author, board } = await privateBoardWithEveryViewer();
    expect((await get(`/boards/${board.id}/members`, admin.cookie)).status).toBe(200);
    expect((await get(`/boards/${board.id}/membership-candidates`, admin.cookie)).status).toBe(200);

    expect((await post(`/boards/${board.id}/members`, { userId: member.id }, admin.cookie)).status).toBe(200);
    expect((await get(`/boards/${board.id}`, member.cookie)).status).toBe(200);
    const removed = await del(`/boards/${board.id}/members/${member.id}`, { operationId: crypto.randomUUID() }, admin.cookie);
    expect(removed.status).toBe(200);
    expect((await get(`/boards/${board.id}`, member.cookie)).status).toBe(403);
    // The owner stays protected from everyone, admins included.
    expect((await del(`/boards/${board.id}/members/${author.id}`, { operationId: crypto.randomUUID() }, admin.cookie)).status).toBe(403);
  });

  it("refuses a workspace member who was not added the same reads and changes", async () => {
    const { member, board } = await privateBoardWithEveryViewer();
    for (const path of ["members", "membership-candidates", "transfer-options"]) {
      expect((await get(`/boards/${board.id}/${path}`, member.cookie)).status, path).toBe(403);
    }
    expect((await post(`/boards/${board.id}/members`, { userId: member.id }, member.cookie)).status).toBe(403);
  });

  it("offers it as a destination for cards, and only to those who may open it", async () => {
    const { admin, member, workspaceId, board } = await privateBoardWithEveryViewer();
    const source = await createBoard(admin, workspaceId, "workspace");
    const offered = async (who: Person) =>
      (await (await get(`/boards/${source.id}/transfer-options`, who.cookie)).json<{ boards: Array<{ id: string }> }>()).boards.map(
        (listed) => listed.id,
      );
    expect(await offered(admin)).toContain(board.id);
    expect(await offered(member)).not.toContain(board.id);
    // An Operator may open the source, but destinations follow what they hold as a
    // member, Guest or workspace admin: not every board in the instance.
    expect(await offered(operator)).not.toContain(board.id);
    // The per-destination read follows the same rule.
    expect((await get(`/boards/${source.id}/transfer-options/${board.id}`, admin.cookie)).status).toBe(200);
    expect((await get(`/boards/${source.id}/transfer-options/${board.id}`, member.cookie)).status).toBe(403);
  });

  it("hands a moved board from the source workspace's admins to the destination's", async () => {
    const { founder, author, admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const destinationAdmin = await person();
    const destinationId = await createWorkspace(author, "Destination");
    await addToWorkspace(author, destinationId, destinationAdmin, "admin");
    expect(await surfacesFor(destinationAdmin, board, destinationId)).toEqual(CANNOT_OPEN);
    const { closed } = await connect(admin, board.id);

    const moved = await moveBoard(author, board, workspaceId, destinationId, await accessVersionOf(author, board));
    expect(moved.status).toBe(200);
    // The source workspace's admins lose it, open connections included; the destination's gain it.
    expect(await closeCode(closed)).toBe(4010);
    expect(await surfacesFor(admin, board, workspaceId)).toEqual(CANNOT_OPEN);
    expect(await surfacesFor(founder, board, workspaceId)).toEqual(CANNOT_OPEN);
    expect(await surfacesFor(destinationAdmin, board, destinationId)).toEqual(CAN_OPEN);
    expect(await surfacesFor(author, board, destinationId)).toEqual(CAN_OPEN);
  });

  it("moves it to another workspace they belong to, keeping it, and deletes it", async () => {
    const { admin, workspaceId, board } = await privateBoardWithEveryViewer();
    const elsewhere = await createWorkspace(admin, "Elsewhere");
    const moved = await moveBoard(admin, board, workspaceId, elsewhere, await accessVersionOf(admin, board));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ state: "completed", outcome: "committed" });
    // Private in its new workspace; the mover holds an explicit grant there.
    expect((await get(`/boards/${board.id}`, admin.cookie)).status).toBe(200);

    const removable = await createBoard(admin, workspaceId, "restricted");
    const otherAdmin = await person();
    await addToWorkspace(admin, workspaceId, otherAdmin, "admin");
    expect((await del(`/boards/${removable.id}`, undefined, otherAdmin.cookie)).status).toBe(200);
    expect((await get(`/boards/${removable.id}`, admin.cookie)).status).toBe(403);
  });

  it("does not let a board member who is not a manager move or delete it", async () => {
    const { boardMember, workspaceId, board } = await privateBoardWithEveryViewer();
    const elsewhere = await createWorkspace(boardMember, "Elsewhere");
    const moved = await moveBoard(boardMember, board, workspaceId, elsewhere, await accessVersionOf(boardMember, board));
    expect(moved.status).toBe(403);
    expect((await del(`/boards/${board.id}`, undefined, boardMember.cookie)).status).toBe(403);
  });
});
