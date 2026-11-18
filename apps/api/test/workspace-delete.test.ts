import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { PresenceServerMessageSchema, REALTIME_PROTOCOL_VERSION } from "@foxban/shared";
import { queriesOf, workerWithPausedD1 } from "./paused-d1";

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
const del = (path: string, session?: string) => request(path, "DELETE", undefined, session);

type Person = { cookie: string; id: string };

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

/** A signup on `@foxban.test` is an instance Admin (admin-signups.ts): an Operator wherever it is not a member. */
let operator: Person;
beforeAll(async () => {
  const cookie = await signup(`operator-${crypto.randomUUID()}@foxban.test`);
  operator = { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id };
});

/** An ordinary account: it holds no power except through the workspaces it is put in. */
async function person(): Promise<Person> {
  const minted = await post("/invites", {}, operator.cookie);
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

async function add(by: Person, workspaceId: string, who: Person, role: "admin" | "member" = "member") {
  const response = await post(
    `/workspaces/${workspaceId}/members`,
    { userId: who.id, role, operationId: crypto.randomUUID() },
    by.cookie,
  );
  expect(response.status).toBe(200);
}

async function invite(by: Person, workspaceId: string): Promise<string> {
  const response = await post(`/workspaces/${workspaceId}/invites`, { role: "member" }, by.cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

const tryCreateBoard = (by: Person, workspaceId: string, accessMode: "workspace" | "restricted" = "workspace") =>
  post(
    "/boards",
    {
      name: "Delete board",
      key: `D${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      workspaceId,
      accessMode,
    },
    by.cookie,
  );

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted" = "workspace") {
  const response = await tryCreateBoard(by, workspaceId, accessMode);
  expect(response.status).toBe(200);
  return response.json<{ id: string; accessVersion: number }>();
}

const tryMoveBoard = (by: Person, boardId: string, from: string, to: string, accessVersion: number) =>
  post(
    `/boards/${boardId}/move-workspace`,
    {
      destinationWorkspaceId: to,
      expectedWorkspaceId: from,
      expectedAccessVersion: accessVersion,
      operationId: crypto.randomUUID(),
    },
    by.cookie,
  );

const deleteWorkspace = (by: Person, workspaceId: string) => del(`/workspaces/${workspaceId}`, by.cookie);
/** Starts `action` after `ms`, so a round can sweep which request reaches D1 first. */
const after = async <T>(ms: number, action: () => Promise<T>): Promise<T> => {
  if (ms > 0) await scheduler.wait(ms);
  return action();
};

const count = async (sql: string, ...bindings: string[]): Promise<number> =>
  (await env.DB.prepare(sql).bind(...bindings).first<{ n: number }>())!.n;
const workspaceRows = (id: string) => count(`SELECT COUNT(*) AS n FROM workspaces WHERE id=?`, id);
const memberRows = (id: string) => count(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=?`, id);
const inviteRows = (id: string) => count(`SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id=?`, id);
const boardRows = (id: string) => count(`SELECT COUNT(*) AS n FROM boards WHERE workspace_id=?`, id);
/** The invariant every board must keep: its workspace exists. */
const boardsWithoutWorkspace = () =>
  count(`SELECT COUNT(*) AS n FROM boards WHERE workspace_id IS NULL OR workspace_id NOT IN (SELECT id FROM workspaces)`);

describe("deleting an empty workspace", () => {
  it("lets an admin delete it, taking its members and pending invites along", async () => {
    const admin = await person();
    const member = await person();
    const bystander = await person();
    const workspace = await createWorkspace(admin, "Doomed");
    await add(admin, workspace, member);
    const token = await invite(admin, workspace);
    // A workspace the same people share is untouched by the delete.
    const other = await createWorkspace(admin, "Survivor");
    await add(admin, other, member);
    const otherToken = await invite(admin, other);
    expect(await memberRows(workspace)).toBe(2);

    const response = await deleteWorkspace(admin, workspace);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(await workspaceRows(workspace)).toBe(0);
    expect(await memberRows(workspace)).toBe(0);
    expect(await inviteRows(workspace)).toBe(0);
    for (const who of [admin, member]) {
      expect((await get(`/workspaces/${workspace}`, who.cookie)).status).toBe(403);
      const listed = await (await get("/workspaces", who.cookie)).json<{ workspaces: Array<{ id: string }> }>();
      expect(listed.workspaces.map((w) => w.id)).not.toContain(workspace);
    }
    // The invitation that was pending can no longer be inspected or accepted.
    expect((await post(`/workspaces/${workspace}/invites/inspect`, { token }, bystander.cookie)).status).toBe(400);
    const accepted = await post(
      `/workspaces/${workspace}/invites/accept`,
      { token, operationId: crypto.randomUUID() },
      bystander.cookie,
    );
    expect(accepted.status).toBe(400);
    expect(await memberRows(workspace)).toBe(0);

    expect(await workspaceRows(other)).toBe(1);
    expect(await memberRows(other)).toBe(2);
    expect(await inviteRows(other)).toBe(1);
    expect((await post(`/workspaces/${other}/invites/inspect`, { token: otherToken }, bystander.cookie)).status).toBe(200);
  });

  it("leaves a person who deleted their only workspace with none", async () => {
    const admin = await person();
    const workspaces = await (await get("/workspaces", admin.cookie)).json<{ workspaces: Array<{ id: string }> }>();
    // Signup's first workspace is an ordinary workspace: it deletes like any other.
    expect(workspaces.workspaces).toHaveLength(1);
    expect((await deleteWorkspace(admin, workspaces.workspaces[0]!.id)).status).toBe(200);
    const after = await (await get("/workspaces", admin.cookie)).json<{ workspaces: unknown[] }>();
    expect(after.workspaces).toEqual([]);
  });
});

/** Everything a refused delete must leave as it found it. */
async function expectIntact(workspace: string, members: number, invites: number, boards = 0) {
  expect(await workspaceRows(workspace)).toBe(1);
  expect(await memberRows(workspace)).toBe(members);
  expect(await inviteRows(workspace)).toBe(invites);
  expect(await boardRows(workspace)).toBe(boards);
}

describe("who may delete a workspace", () => {
  it("refuses a member, a Guest, a stranger, an Operator and an anonymous caller with 403", async () => {
    const admin = await person();
    const member = await person();
    const guest = await person();
    const stranger = await person();
    const workspace = await createWorkspace(admin, "Protected");
    await add(admin, workspace, member);
    await invite(admin, workspace);
    // The Guest holds a grant on one Private board of this workspace, and is no member.
    // The board stays: a refusal for who asks must come before any word about what is in it.
    const board = await createBoard(admin, workspace, "restricted");
    const granted = await post(
      `/boards/${board.id}/members`,
      { userId: guest.id, operationId: crypto.randomUUID() },
      admin.cookie,
    );
    expect(granted.status).toBe(200);

    for (const who of [member, guest, stranger, operator]) {
      const response = await deleteWorkspace(who, workspace);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect((await del(`/workspaces/${workspace}`)).status).toBe(401);
    await expectIntact(workspace, 2, 1, 1);

    // A workspace that does not exist answers like one the caller may not touch.
    expect((await deleteWorkspace(admin, crypto.randomUUID())).status).toBe(403);
  });

  it("lets an admin who is not the creator delete it, and refuses a demoted creator", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator, "Handed over");
    await add(creator, workspace, peer, "admin");
    const demoted = await request(
      `/workspaces/${workspace}/members/${creator.id}`,
      "PATCH",
      { role: "member", operationId: crypto.randomUUID() },
      peer.cookie,
    );
    expect(demoted.status).toBe(200);

    expect((await deleteWorkspace(creator, workspace)).status).toBe(403);
    await expectIntact(workspace, 2, 0);
    expect((await deleteWorkspace(peer, workspace)).status).toBe(200);
    expect(await workspaceRows(workspace)).toBe(0);
  });

  it("does not let an instance Admin act as Operator: only a workspace admin deletes, a member Admin included", async () => {
    const admin = await person();
    const workspace = await createWorkspace(admin, "Operated");
    // Operator access is for reaching a workspace, not for destroying one.
    expect((await deleteWorkspace(operator, workspace)).status).toBe(403);
    await expectIntact(workspace, 1, 0);

    // The same Admin account, once a workspace admin of it, may delete like anyone.
    await add(admin, workspace, operator, "admin");
    expect((await deleteWorkspace(operator, workspace)).status).toBe(200);
    expect(await workspaceRows(workspace)).toBe(0);
  });
});

describe("a workspace that is not empty", () => {
  it("returns a conflict that names the boards and deletes nothing", async () => {
    const admin = await person();
    const member = await person();
    const workspace = await createWorkspace(admin, "Busy");
    await add(admin, workspace, member);
    await invite(admin, workspace);
    await createBoard(admin, workspace);

    const response = await deleteWorkspace(admin, workspace);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "workspace_not_empty",
      error: "Move or delete this workspace's boards first.",
    });
    await expectIntact(workspace, 2, 1, 1);
  });

  it("counts a Private board the admin is not on", async () => {
    const admin = await person();
    const member = await person();
    const workspace = await createWorkspace(admin, "Hidden board");
    await add(admin, workspace, member);
    // Created by a member as Private: the admin is neither its owner nor on it, and
    // opens it only as a workspace admin. Every board counts, however it is reached.
    await createBoard(member, workspace, "restricted");

    expect((await deleteWorkspace(admin, workspace)).status).toBe(409);
    await expectIntact(workspace, 2, 0, 1);
  });

  it("is deletable once its last board is deleted", async () => {
    const admin = await person();
    const workspace = await createWorkspace(admin, "Emptied");
    const board = await createBoard(admin, workspace);
    expect((await deleteWorkspace(admin, workspace)).status).toBe(409);

    const removed = await del(`/boards/${board.id}?operationId=${crypto.randomUUID()}`, admin.cookie);
    expect(removed.status).toBe(200);
    expect(await boardRows(workspace)).toBe(0);
    expect((await deleteWorkspace(admin, workspace)).status).toBe(200);
  });
});

describe("a workspace with an access change in flight", () => {
  it("is refused with a conflict until the change settles, and deletes nothing meanwhile", async () => {
    const admin = await person();
    const member = await person();
    const workspace = await createWorkspace(admin, "Mid-change");
    await add(admin, workspace, member);
    await invite(admin, workspace);
    // The scope row is the workspace's transition lock: every access change holds one
    // from reservation until it is released, and a board move holds its destination's.
    await env.DB.prepare(`INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`)
      .bind(workspace, "in-flight")
      .run();

    const refused = await deleteWorkspace(admin, workspace);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "access change conflict", code: "access_change_conflict" });
    await expectIntact(workspace, 2, 1);

    await env.DB.prepare(`DELETE FROM access_change_scopes WHERE operation_id=?`).bind("in-flight").run();
    expect((await deleteWorkspace(admin, workspace)).status).toBe(200);
    expect(await workspaceRows(workspace)).toBe(0);
  });
});

const ROUNDS = 8;

describe("a board can never be left without a workspace", () => {
  it("cannot be created in, or moved into, a workspace that is already gone", async () => {
    const admin = await person();
    const gone = await createWorkspace(admin, "Gone");
    const home = await createWorkspace(admin, "Home");
    const board = await createBoard(admin, home);
    expect((await deleteWorkspace(admin, gone)).status).toBe(200);

    const created = await tryCreateBoard(admin, gone);
    expect(created.status).toBe(403);
    expect(await boardRows(gone)).toBe(0);

    const moved = await tryMoveBoard(admin, board.id, home, gone, board.accessVersion);
    expect(moved.status).toBe(403);
    expect(await env.DB.prepare(`SELECT workspace_id AS w FROM boards WHERE id=?`).bind(board.id).first()).toEqual({ w: home });
    expect(await boardsWithoutWorkspace()).toBe(0);
  });

  it("is refused by the schema itself, so no route can skip the rule", async () => {
    const admin = await person();
    const home = await createWorkspace(admin, "Home");
    const board = await createBoard(admin, home);
    const gone = await createWorkspace(admin, "Gone");
    expect((await deleteWorkspace(admin, gone)).status).toBe(200);

    await expect(
      env.DB.prepare(
        `INSERT INTO boards(id,name,board_key,owner_id,icon,color,workspace_id,access_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
        .bind(crypto.randomUUID(), "Raw", `X${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, admin.id, "rocket", "teal", gone, "workspace", Date.now())
        .run(),
    ).rejects.toThrow(/board workspace does not exist/);
    await expect(
      env.DB.prepare(`UPDATE boards SET workspace_id=? WHERE id=?`).bind(gone, board.id).run(),
    ).rejects.toThrow(/board workspace does not exist/);
    expect(await boardsWithoutWorkspace()).toBe(0);
  });

  it("holds when concurrent requests create boards while it deletes", async () => {
    const outcomes = { deleted: 0, kept: 0 };
    const admin = await person();
    const member = await person();
    for (let round = 0; round < ROUNDS; round++) {
      const workspace = await createWorkspace(admin, `Race create ${round}`);
      await add(admin, workspace, member);
      // Creations arrive over a few milliseconds around the delete, from both roles, so
      // some land before it, some after, and some between its steps.
      const [deleted, ...created] = await Promise.all([
        after(round % 4, () => deleteWorkspace(admin, workspace)),
        ...Array.from({ length: 6 }, (_, i) =>
          after(Math.floor(i / 2) % 6, () => tryCreateBoard(i % 2 ? member : admin, workspace, i % 3 ? "workspace" : "restricted"))),
      ]);
      const landed = created.filter((r) => r.status === 200).length;
      // Either the delete saw a board and refused, or the boards found no workspace to
      // join: never a board whose workspace is gone.
      if (deleted.status === 200) {
        outcomes.deleted++;
        expect(created.map((r) => r.status).every((status) => status === 403 || status === 200)).toBe(true);
        expect(await boardRows(workspace)).toBe(0);
        expect(await memberRows(workspace)).toBe(0);
        expect(landed).toBe(0);
      } else {
        outcomes.kept++;
        expect(deleted.status).toBe(409);
        expect(await workspaceRows(workspace)).toBe(1);
        expect(await memberRows(workspace)).toBe(2);
        expect(await boardRows(workspace)).toBe(landed);
        expect(landed).toBeGreaterThan(0);
      }
      expect(await boardsWithoutWorkspace()).toBe(0);
    }
    expect(outcomes.deleted + outcomes.kept).toBe(ROUNDS);
  }, 60_000);

  it("holds when concurrent requests move a board in while it deletes", async () => {
    const admin = await person();
    for (let round = 0; round < ROUNDS; round++) {
      const source = await createWorkspace(admin, `Race source ${round}`);
      const target = await createWorkspace(admin, `Race target ${round}`);
      const board = await createBoard(admin, source);
      const offset = round % 8;
      const [deleted, moved] = await Promise.all([
        after(offset < 4 ? 0 : offset - 3, () => deleteWorkspace(admin, target)),
        after(offset < 4 ? offset : 0, () => tryMoveBoard(admin, board.id, source, target, board.accessVersion)),
      ]);
      const placed = await env.DB.prepare(`SELECT workspace_id AS w FROM boards WHERE id=?`).bind(board.id).first<{ w: string }>();
      if (deleted.status === 200) {
        // The workspace went first: the move found no destination and the board stayed.
        expect([403, 409]).toContain(moved.status);
        expect(placed).toEqual({ w: source });
        expect(await workspaceRows(target)).toBe(0);
      } else {
        // The board (or the move holding the workspace) was seen: nothing was deleted.
        expect(deleted.status).toBe(409);
        expect(await workspaceRows(target)).toBe(1);
        expect(await memberRows(target)).toBe(1);
        expect(placed).toEqual({ w: moved.status === 200 ? target : source });
      }
      expect(await boardsWithoutWorkspace()).toBe(0);
    }
  }, 60_000);

  it("answers two admins deleting at once with one success and one refusal, never an error", async () => {
    const first = await person();
    const second = await person();
    const workspace = await createWorkspace(first, "Two hands");
    await add(first, workspace, second, "admin");
    const statuses = (await Promise.all([deleteWorkspace(first, workspace), deleteWorkspace(second, workspace)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 403]);
    expect(await workspaceRows(workspace)).toBe(0);
    expect(await memberRows(workspace)).toBe(0);
  });
});

describe("every gap between a request's own queries", () => {
  it("never leaves a board without a workspace when a board is created at any point of the delete", async () => {
    const admin = await person();
    const member = await person();
    const prepare = async () => {
      const workspace = await createWorkspace(admin, "Gap create");
      await add(admin, workspace, member);
      return workspace;
    };
    const gaps = await queriesOf(async (hooked) => hooked.fetch(`/workspaces/${await prepare()}`, "DELETE", admin));
    expect(gaps).toBeGreaterThan(1);

    const seen = new Set<number>();
    // One past the last query means: the board arrives after the delete is over.
    for (let gap = 0; gap <= gaps; gap++) {
      const workspace = await prepare();
      let created: Response | undefined;
      const hooked = workerWithPausedD1(async (n) => {
        if (n === gap) created = await tryCreateBoard(member, workspace);
      });
      const deleted = await hooked.fetch(`/workspaces/${workspace}`, "DELETE", admin);
      created ??= await tryCreateBoard(member, workspace);

      seen.add(deleted.status);
      expect(await boardsWithoutWorkspace(), `board without a workspace, gap ${gap}`).toBe(0);
      if (deleted.status === 200) {
        expect(created.status, `gap ${gap}`).toBe(403);
        expect(await boardRows(workspace)).toBe(0);
        expect(await memberRows(workspace)).toBe(0);
      } else {
        expect(deleted.status, `gap ${gap}`).toBe(409);
        expect(created.status).toBe(200);
        expect(await boardRows(workspace)).toBe(1);
        expect(await memberRows(workspace)).toBe(2);
      }
    }
    // Both outcomes were reached, so the gaps really straddled the delete.
    expect([...seen].sort()).toEqual([200, 409]);
  }, 60_000);

  it("never leaves a board without a workspace when the delete lands at any point of a board's creation", async () => {
    const admin = await person();
    const member = await person();
    const prepare = async () => {
      const workspace = await createWorkspace(admin, "Gap create 2");
      await add(admin, workspace, member);
      return workspace;
    };
    const create = (hooked: ReturnType<typeof workerWithPausedD1>, workspace: string) =>
      hooked.fetch("/boards", "POST", member, {
        name: "Gap board",
        key: `G${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        workspaceId: workspace,
        accessMode: "workspace",
      });
    const gaps = await queriesOf(async (hooked) => create(hooked, await prepare()));
    expect(gaps).toBeGreaterThan(1);

    const seen = new Set<number>();
    for (let gap = 0; gap <= gaps; gap++) {
      const workspace = await prepare();
      let deleted: Response | undefined;
      const hooked = workerWithPausedD1(async (n) => {
        if (n === gap) deleted = await deleteWorkspace(admin, workspace);
      });
      const created = await create(hooked, workspace);
      deleted ??= await deleteWorkspace(admin, workspace);

      seen.add(created.status);
      expect(await boardsWithoutWorkspace(), `board without a workspace, gap ${gap}`).toBe(0);
      if (deleted.status === 200) {
        expect(created.status, `gap ${gap}`).toBe(403);
        expect(await workspaceRows(workspace)).toBe(0);
        expect(await boardRows(workspace)).toBe(0);
      } else {
        expect(deleted.status, `gap ${gap}`).toBe(409);
        expect(created.status).toBe(200);
        expect(await boardRows(workspace)).toBe(1);
      }
    }
    expect([...seen].sort()).toEqual([200, 403]);
  }, 60_000);

  it("never leaves a board without a workspace when a board is moved in at any point of the delete", async () => {
    const admin = await person();
    const prepare = async () => {
      const source = await createWorkspace(admin, "Gap source");
      const target = await createWorkspace(admin, "Gap target");
      return { source, target, board: await createBoard(admin, source) };
    };
    const gaps = await queriesOf(async (hooked) => hooked.fetch(`/workspaces/${(await prepare()).target}`, "DELETE", admin));

    const seen = new Set<number>();
    for (let gap = 0; gap <= gaps; gap++) {
      const { source, target, board } = await prepare();
      let moved: Response | undefined;
      const hooked = workerWithPausedD1(async (n) => {
        if (n === gap) moved = await tryMoveBoard(admin, board.id, source, target, board.accessVersion);
      });
      const deleted = await hooked.fetch(`/workspaces/${target}`, "DELETE", admin);
      moved ??= await tryMoveBoard(admin, board.id, source, target, board.accessVersion);

      seen.add(deleted.status);
      expect(await boardsWithoutWorkspace(), `board without a workspace, gap ${gap}`).toBe(0);
      const placed = (await env.DB.prepare(`SELECT workspace_id AS w FROM boards WHERE id=?`).bind(board.id).first<{ w: string }>())!.w;
      if (deleted.status === 200) {
        expect([403, 409], `gap ${gap}`).toContain(moved.status);
        expect(placed).toBe(source);
        expect(await workspaceRows(target)).toBe(0);
      } else {
        expect(deleted.status, `gap ${gap}`).toBe(409);
        expect(await workspaceRows(target)).toBe(1);
        expect(placed).toBe(moved.status === 200 ? target : source);
      }
    }
    expect([...seen].sort()).toEqual([200, 409]);
  }, 120_000);

  it("never leaves a board without a workspace when the delete lands at any point of a board's move", async () => {
    const admin = await person();
    const prepare = async () => {
      const source = await createWorkspace(admin, "Gap source 2");
      const target = await createWorkspace(admin, "Gap target 2");
      return { source, target, board: await createBoard(admin, source) };
    };
    const move = (hooked: ReturnType<typeof workerWithPausedD1>, w: Awaited<ReturnType<typeof prepare>>, operationId = crypto.randomUUID()) =>
      hooked.fetch(`/boards/${w.board.id}/move-workspace`, "POST", admin, {
        destinationWorkspaceId: w.target,
        expectedWorkspaceId: w.source,
        expectedAccessVersion: w.board.accessVersion,
        operationId,
      });
    const gaps = await queriesOf(async (hooked) => move(hooked, await prepare()));
    expect(gaps).toBeGreaterThan(5);

    const seen = new Set<number>();
    for (let gap = 0; gap <= gaps; gap++) {
      const w = await prepare();
      let deleted: Response | undefined;
      const hooked = workerWithPausedD1(async (n) => {
        if (n === gap) deleted = await deleteWorkspace(admin, w.target);
      });
      const operationId = crypto.randomUUID();
      const moved = await move(hooked, w, operationId);
      deleted ??= await deleteWorkspace(admin, w.target);

      seen.add(deleted.status);
      expect(await boardsWithoutWorkspace(), `board without a workspace, gap ${gap}`).toBe(0);
      const placed = (await env.DB.prepare(`SELECT workspace_id AS w FROM boards WHERE id=?`).bind(w.board.id).first<{ w: string }>())!.w;
      if (deleted.status === 200) {
        // The workspace was gone before the move reserved it: the board never left, and
        // no operation was ever journaled that the delete could have aborted under it.
        expect([403, 409], `gap ${gap}`).toContain(moved.status);
        expect(placed).toBe(w.source);
        expect(await count(`SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?`, operationId), `gap ${gap}`).toBe(0);
      } else {
        // The move already held the workspace or had landed in it: the delete waited it out.
        expect(deleted.status, `gap ${gap}`).toBe(409);
        expect(await workspaceRows(w.target)).toBe(1);
        expect(placed).toBe(moved.status === 200 ? w.target : w.source);
      }
    }
    expect([...seen].sort()).toEqual([200, 409]);
  }, 120_000);
});

/** A message-driven presence client: tests await real frames, never a guessed delay. */
async function connectPresence(by: Person) {
  const response = await SELF.fetch(`${ORIGIN}/presence/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie: by.cookie },
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
    invalidations,
    async nextInvalidation() {
      for (;;) {
        if (invalidations().length > 0) return invalidations();
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

describe("people who are online when a workspace is deleted", () => {
  it("are told to refresh, and only they", async () => {
    const admin = await person();
    const member = await person();
    const stranger = await person();
    const workspace = await createWorkspace(admin, "Announced");
    await add(admin, workspace, member);
    const adminPresence = await connectPresence(admin);
    const memberPresence = await connectPresence(member);
    const strangerPresence = await connectPresence(stranger);

    expect((await deleteWorkspace(admin, workspace)).status).toBe(200);

    for (const presence of [adminPresence, memberPresence]) {
      expect(await presence.nextInvalidation()).toEqual([
        { type: "workspace.invalidated", workspaceIds: [workspace], boardIds: [] },
      ]);
    }
    await scheduler.wait(0);
    expect(strangerPresence.invalidations()).toEqual([]);
  });

  it("hear nothing when the delete is refused", async () => {
    const admin = await person();
    const member = await person();
    const workspace = await createWorkspace(admin, "Kept");
    await add(admin, workspace, member);
    await createBoard(admin, workspace);
    const memberPresence = await connectPresence(member);

    expect((await deleteWorkspace(admin, workspace)).status).toBe(409);
    expect((await deleteWorkspace(member, workspace)).status).toBe(403);
    await scheduler.wait(0);
    expect(memberPresence.invalidations()).toEqual([]);
  });
});

describe("an access change in flight, whatever its kind", () => {
  // One scenario per journaled kind. Each runs the operation through the Worker with its
  // D1 binding paused, and tries the delete before every one of the operation's queries.
  type Setup = { workspace: string; destination?: string; board?: { id: string; accessVersion: number } };
  const kinds: Array<{
    kind: string;
    withBoard: boolean;
    request: (
      hooked: ReturnType<typeof workerWithPausedD1>,
      w: Setup,
      people: { admin: Person; member: Person; candidate: Person; token: string },
      operationId: string,
    ) => Promise<Response>;
  }> = [
    {
      kind: "workspace-member-add",
      withBoard: false,
      request: (h, w, p, operationId) =>
        h.fetch(`/workspaces/${w.workspace}/members`, "POST", p.admin, { userId: p.candidate.id, role: "member", operationId }),
    },
    {
      kind: "workspace-member-role",
      withBoard: false,
      request: (h, w, p, operationId) =>
        h.fetch(`/workspaces/${w.workspace}/members/${p.member.id}`, "PATCH", p.admin, { role: "admin", operationId }),
    },
    {
      kind: "workspace-member-remove",
      withBoard: false,
      request: (h, w, p, operationId) =>
        h.fetch(`/workspaces/${w.workspace}/members/${p.member.id}`, "DELETE", p.admin, { operationId }),
    },
    {
      kind: "workspace-invite-accept",
      withBoard: false,
      request: (h, w, p, operationId) =>
        h.fetch(`/workspaces/${w.workspace}/invites/accept`, "POST", p.candidate, { token: p.token, operationId }),
    },
    {
      kind: "board-move",
      withBoard: true,
      request: (h, w, p, operationId) =>
        h.fetch(`/boards/${w.board!.id}/move-workspace`, "POST", p.admin, {
          destinationWorkspaceId: w.destination!,
          expectedWorkspaceId: w.workspace,
          expectedAccessVersion: w.board!.accessVersion,
          operationId,
        }),
    },
    {
      kind: "board-member-add",
      withBoard: true,
      request: (h, w, p, operationId) =>
        h.fetch(`/boards/${w.board!.id}/members`, "POST", p.admin, { userId: p.candidate.id, operationId }),
    },
    {
      kind: "board-member-remove",
      withBoard: true,
      request: (h, w, p, operationId) =>
        h.fetch(`/boards/${w.board!.id}/members/${p.member.id}`, "DELETE", p.admin, { operationId }),
    },
    {
      kind: "board-delete",
      withBoard: true,
      request: (h, w, p, operationId) => h.fetch(`/boards/${w.board!.id}?operationId=${operationId}`, "DELETE", p.admin),
    },
  ];

  it.each(kinds)("$kind: the delete is refused at every point where the change is still in flight", async ({ kind, withBoard, request }) => {
    const admin = await person();
    const member = await person();
    const candidate = await person();
    const prepare = async () => {
      const workspace = await createWorkspace(admin, `In flight ${kind}`);
      await add(admin, workspace, member);
      const token = await invite(admin, workspace);
      let board: Setup["board"];
      if (withBoard) {
        board = await createBoard(admin, workspace, "restricted");
        // The grant `board-member-remove` removes.
        const granted = await post(`/boards/${board.id}/members`, { userId: member.id, operationId: crypto.randomUUID() }, admin.cookie);
        expect(granted.status).toBe(200);
      }
      const destination = kind === "board-move" ? await createWorkspace(admin, `In flight destination`) : undefined;
      return { setup: { workspace, destination, board } as Setup, people: { admin, member, candidate, token } };
    };
    const journal = async (operationId: string) =>
      (await env.DB.prepare(`SELECT phase FROM access_change_operations WHERE id=?`).bind(operationId).first<{ phase: string }>())?.phase ?? null;

    const gaps = await queriesOf(async (hooked) => {
      const { setup, people } = await prepare();
      return request(hooked, setup, people, crypto.randomUUID());
    });
    expect(gaps).toBeGreaterThan(1);

    let refusedInFlight = 0;
    for (let gap = 0; gap <= gaps; gap++) {
      const { setup, people } = await prepare();
      const operationId = crypto.randomUUID();
      // A move holds its destination too, so that is the workspace to try to delete.
      const target = setup.destination ?? setup.workspace;
      let phaseAtDelete: string | null = null;
      let deleted: Response | undefined;
      const hooked = workerWithPausedD1(async (n) => {
        if (n !== gap) return;
        phaseAtDelete = await journal(operationId);
        deleted = await deleteWorkspace(admin, target);
      });
      const operation = await request(hooked, setup, people, operationId);
      if (!deleted) {
        phaseAtDelete = await journal(operationId);
        deleted = await deleteWorkspace(admin, target);
      }

      expect(operation.status, `${kind} gap ${gap}`).toBeLessThan(500);
      expect(await boardsWithoutWorkspace(), `board without a workspace, ${kind} gap ${gap}`).toBe(0);
      if (phaseAtDelete !== null && phaseAtDelete !== "completed") {
        // Journaled and not completed: the operation holds the workspace's scope.
        refusedInFlight++;
        expect(deleted.status, `${kind} gap ${gap} (${phaseAtDelete})`).toBe(409);
        expect(await workspaceRows(target), `${kind} gap ${gap}`).toBe(1);
      }
      if (deleted.status === 200) {
        expect(await workspaceRows(target)).toBe(0);
        expect(await memberRows(target)).toBe(0);
      }
    }
    // The gaps really straddled the operation, so its in-flight states were all tried.
    expect(refusedInFlight, kind).toBeGreaterThan(0);
  }, 240_000);
});
