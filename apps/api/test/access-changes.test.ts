import { SELF, abortAllDurableObjects, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PresenceServerMessageSchema, REALTIME_PROTOCOL_VERSION } from "@foxban/shared";
import { ACCESS_CHANGE_ABORT, AccessChangeConflict, pruneAccessChanges, pruneWorkspaceInvites, recoverAccessChanges, runAccessChange } from "../src/access-changes";
import type { SessionUser } from "../src/auth";
import type { BoardDO } from "../src/board-do";
import { INTERNAL_BOARD_ID_HEADER, INTERNAL_USER_ID_HEADER } from "../src/internal-headers";

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response carried no session cookie");
  return header.split(";")[0]!;
}

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
const delBody = (path: string, body: unknown, session?: string) => request(path, "DELETE", body, session);
const patch = (path: string, body: unknown, session?: string) => request(path, "PATCH", body, session);

/** The full session identity, for attempts driven through `runAccessChange` directly. */
async function sessionUser(session: string): Promise<SessionUser> {
  const id = (await me(session)).id;
  const row = await env.DB.prepare(
    `SELECT id,email,name,github_login AS githubLogin,avatar_version AS avatarVersion,timezone
       FROM users WHERE id=?`,
  )
    .bind(id)
    .first<SessionUser>();
  if (!row) throw new Error("missing user row");
  return row;
}

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", {
    email,
    name: email.split("@")[0],
    password: PASSWORD,
    ...(invite ? { invite } : {}),
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
}

/** A signup on `@foxban.test` is listed as an admin (admin-signups.ts), so these are operators. */
const signupAdmin = () => signup(`admin-${crypto.randomUUID()}@foxban.test`);

/** Ordinary users need an account invitation, minted by a configured administrator. */
async function signupMember(admin: string, email?: string): Promise<string> {
  const minted = await post("/invites", {}, admin);
  expect(minted.status).toBe(201);
  const { token } = await minted.json<{ token: string }>();
  return signup(email ?? `member-${crypto.randomUUID()}@example.test`, token);
}

async function createWorkspace(session: string, name: string): Promise<string> {
  const response = await post("/workspaces", { name }, session);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function createBoard(
  session: string,
  workspaceId: string,
  accessMode: "workspace" | "restricted" = "workspace",
) {
  const key = `B${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const response = await post(
    "/boards",
    { name: "Recovery board", key, workspaceId, accessMode },
    session,
  );
  expect(response.status).toBe(200);
  return response.json<{ id: string; key: string; accessVersion: number }>();
}

async function me(session: string): Promise<{ id: string }> {
  const response = await get("/me", session);
  expect(response.status).toBe(200);
  return response.json<{ id: string }>();
}

/** Puts an existing account into a workspace through a real invitation link. */
async function inviteToWorkspace(
  admin: string,
  workspaceId: string,
  member: string,
  role: "member" | "admin" = "member",
): Promise<void> {
  const created = await post(`/workspaces/${workspaceId}/invites`, { role }, admin);
  expect(created.status).toBe(201);
  const { token } = await created.json<{ token: string }>();
  const accepted = await post(
    `/workspaces/${workspaceId}/invites/accept`,
    { token, operationId: crypto.randomUUID() },
    member,
  );
  expect(accepted.status).toBe(200);
}

const boardStub = (boardId: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));

function callBoardInternal(boardId: string, path: string, body: unknown) {
  return boardStub(boardId).fetch(`https://board.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_BOARD_ID_HEADER]: boardId },
    body: JSON.stringify(body),
  });
}

type AccessState = { generation: number; pendingOperationId: string | null; frozen: number };

function readAccessState(boardId: string): Promise<AccessState> {
  return runInDurableObject(boardStub(boardId), (_instance, state) =>
    state.storage.sql
      .exec<AccessState>(
        `SELECT generation,pending_operation_id AS pendingOperationId,frozen FROM board_access_state WHERE id=1`,
      )
      .toArray()[0]!,
  );
}

type BoardSnapshot = {
  id: string;
  name: string;
  boardKey: string;
  ownerId: string;
  icon: string;
  color: string;
  workspaceId: string;
  accessMode: string;
  accessVersion: number;
  pendingOperationId: string | null;
  createdAt: number;
};

function readBoard(boardId: string): Promise<BoardSnapshot | null> {
  return env.DB.prepare(
    `SELECT id,name,board_key AS boardKey,owner_id AS ownerId,icon,color,
            workspace_id AS workspaceId,access_mode AS accessMode,access_version AS accessVersion,
            pending_access_operation_id AS pendingOperationId,created_at AS createdAt
       FROM boards WHERE id=?`,
  )
    .bind(boardId)
    .first<BoardSnapshot>();
}

type OperationSnapshot = {
  phase: string;
  outcome: string | null;
  result: string | null;
  notified: number;
  effectStarted: number;
  notifyUserIds: string;
};

function readOperation(operationId: string): Promise<OperationSnapshot | null> {
  return env.DB.prepare(
    `SELECT phase,outcome,result_json AS result,notified,effect_started AS effectStarted,
            notify_user_ids_json AS notifyUserIds
       FROM access_change_operations WHERE id=?`,
  )
    .bind(operationId)
    .first<OperationSnapshot>();
}

type ParticipantSnapshot = {
  boardId: string;
  expectedVersion: number;
  nextVersion: number;
  prepared: number;
  released: number;
};

async function readParticipants(operationId: string): Promise<ParticipantSnapshot[]> {
  const { results } = await env.DB.prepare(
    `SELECT board_id AS boardId,expected_version AS expectedVersion,next_version AS nextVersion,
            prepared,released
       FROM access_change_boards WHERE operation_id=? ORDER BY board_id`,
  )
    .bind(operationId)
    .all<ParticipantSnapshot>();
  return results;
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

/**
 * Restores a finished operation to the state a crash right after reservation
 * leaves: fences unprepared and unreleased, the policy still at its pre-change
 * values, and the workspace lock plus pending marker in place.
 */
async function rewindToReserved(operationId: string, board: BoardSnapshot): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE boards SET workspace_id=?,access_mode=?,access_version=?,pending_access_operation_id=?
        WHERE id=?`,
    ).bind(board.workspaceId, board.accessMode, board.accessVersion, operationId, board.id),
    env.DB.prepare(
      `UPDATE access_change_operations
          SET phase='preparing',outcome=NULL,result_json=NULL,notified=0,effect_started=0,updated_at=?
        WHERE id=?`,
    ).bind(Date.now(), operationId),
    env.DB.prepare(`UPDATE access_change_boards SET prepared=0,released=0 WHERE operation_id=?`).bind(
      operationId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`,
    ).bind(board.workspaceId, operationId),
  ]);
  // The DO's own boundary belongs to the same crash: at reservation time it still
  // sits on the pre-change generation, unfrozen. Rewinding only D1 would describe a
  // state a reservation never produces, and prepare must not refreeze a generation
  // that was already consumed.
  await runInDurableObject(boardStub(board.id), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE board_access_state SET generation=?,pending_operation_id=NULL,frozen=0 WHERE id=1`,
      board.accessVersion,
    );
  });
}

/** The terminal state of a committed workspace self-removal: no scope, no fence, no access. */
async function expectSelfRemovalSettled(
  operationId: string,
  workspaceId: string,
  boardId: string,
  before: BoardSnapshot,
  leaver: string,
  owner: string,
): Promise<void> {
  expect(await readOperation(operationId)).toMatchObject({ phase: "completed", outcome: "committed" });
  expect(
    await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=? AND outcome='committed'", operationId),
  ).toBe(1);
  expect(
    await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE workspace_id=?", workspaceId),
  ).toBe(0);
  expect(await readBoard(boardId)).toMatchObject({
    accessVersion: before.accessVersion + 1,
    pendingOperationId: null,
  });
  expect(await readAccessState(boardId)).toEqual({
    generation: before.accessVersion + 1,
    pendingOperationId: null,
    frozen: 0,
  });
  expect((await get(`/boards/${boardId}`, leaver)).status).toBe(403);
  expect((await get(`/boards/${boardId}`, owner)).status).toBe(200);
}

/** A message-driven presence client: tests await real frames, never a guessed delay. */
async function connectPresence(session: string) {
  const response = await SELF.fetch(
    `${ORIGIN}/presence/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
    { headers: { Upgrade: "websocket", cookie: session } },
  );
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
    frames
      .map((frame) => PresenceServerMessageSchema.parse(frame))
      .filter((frame) => frame.type === "workspace.invalidated");
  return {
    frames,
    invalidations,
    async nextInvalidation() {
      for (;;) {
        if (invalidations().length > 0) return invalidations();
        // `lib` is ES2022, so `Promise.withResolvers` is not in the type surface yet.
        const arrived = new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
        await arrived;
      }
    },
  };
}

describe("access change journal", () => {
  it("binds an operation id to actor and canonical payload and exposes actor-scoped status", async () => {
    const session = await signupAdmin();
    const workspace = await createWorkspace(session, "Journal workspace");
    const board = await createBoard(session, workspace, "workspace");
    const destination = await createWorkspace(session, "Destination");
    const operationId = crypto.randomUUID();
    const input = {
      destinationWorkspaceId: destination,
      expectedWorkspaceId: workspace,
      expectedAccessVersion: board.accessVersion,
      operationId,
    };
    const first = await post(`/boards/${board.id}/move-workspace`, input, session);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      operationId,
      state: "completed",
      outcome: "committed",
      result: { boardId: board.id, workspaceId: destination, accessMode: "restricted" },
    });

    // A lost response is retried with the same attempt id: the journal replays the
    // recorded outcome instead of moving the board a second time.
    const replay = await post(`/boards/${board.id}/move-workspace`, input, session);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      operationId,
      state: "completed",
      outcome: "committed",
    });
    expect((await readBoard(board.id))?.accessVersion).toBe(1);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", operationId)).toBe(1);
    expect(await readParticipants(operationId)).toMatchObject([
      { expectedVersion: 0, nextVersion: 1, prepared: 1, released: 1 },
    ]);
    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "committed",
      notified: 1,
    });
    expect(await readAccessState(board.id)).toEqual({ generation: 1, pendingOperationId: null, frozen: 0 });

    const status = await get(`/access-changes/${operationId}`, session);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ operationId, state: "completed", outcome: "committed" });
    const row = await env.DB.prepare("SELECT payload_json AS payload FROM access_change_operations WHERE id=?")
      .bind(operationId)
      .first<{ payload: string }>();
    expect(row?.payload).not.toContain("invite=");
  });

  it("resumes a reserved operation through prepare, commit, release, completion and notification", async () => {
    const session = await signupAdmin();
    const actor = await me(session);
    const workspace = await createWorkspace(session, "Resume source");
    const board = await createBoard(session, workspace, "workspace");
    const destination = await createWorkspace(session, "Resume destination");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          {
            destinationWorkspaceId: destination,
            expectedWorkspaceId: workspace,
            expectedAccessVersion: board.accessVersion,
            operationId,
          },
          session,
        )
      ).status,
    ).toBe(200);

    await rewindToReserved(operationId, before);
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing", notified: 0 });
    expect((await readBoard(board.id))?.workspaceId).toBe(workspace);
    // The crash state: the board is unfrozen at its pre-change generation, and the
    // journal alone knows the attempt is outstanding.
    expect(await readAccessState(board.id)).toEqual({ generation: 0, pendingOperationId: null, frozen: 0 });

    await recoverAccessChanges(env);

    // The policy change landed exactly once, driven by the journal alone.
    expect(await readBoard(board.id)).toMatchObject({
      workspaceId: destination,
      accessMode: "restricted",
      accessVersion: 1,
      pendingOperationId: null,
    });
    const operation = (await readOperation(operationId))!;
    expect(operation).toMatchObject({
      phase: "completed",
      outcome: "committed",
      notified: 1,
      effectStarted: 0,
    });
    expect(JSON.parse(operation.notifyUserIds)).toContainEqual(
      expect.objectContaining({ id: actor.id, workspaces: expect.arrayContaining([workspace, destination]) }),
    );
    expect(await readParticipants(operationId)).toMatchObject([{ prepared: 1, released: 1 }]);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId)).toBe(0);
    // Prepare froze the board; release advanced and unfroze it.
    expect(await readAccessState(board.id)).toEqual({ generation: 1, pendingOperationId: null, frozen: 0 });

    // Recovery is idempotent: a second pass changes nothing.
    await recoverAccessChanges(env);
    expect((await readBoard(board.id))?.accessVersion).toBe(1);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", operationId)).toBe(1);
  });

  it("aborts with partially prepared participants, advances their generations, and changes no policy", async () => {
    const admin = await signupAdmin();
    const member = await signupMember(admin);
    const target = await me(member);
    const bystander = await signupMember(admin);
    const victim = await me(bystander);
    const workspace = await createWorkspace(admin, "Abort workspace");
    await inviteToWorkspace(admin, workspace, member);
    await inviteToWorkspace(admin, workspace, bystander);
    const first = await createBoard(admin, workspace, "workspace");
    const second = await createBoard(admin, workspace, "workspace");
    const operationId = crypto.randomUUID();
    const now = Date.now();

    // The journal names an ordinary member as the actor removing someone else (a
    // member may only remove themselves), so the commit-time permission recheck has
    // to refuse to apply the removal.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,created_at,updated_at)
         VALUES(?,?,'workspace-member-remove',?,'hash','preparing',?,?)`,
      ).bind(operationId, target.id, JSON.stringify({ workspaceId: workspace, userId: victim.id }), now, now),
      env.DB.prepare(`INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`).bind(
        workspace,
        operationId,
      ),
      ...[first.id, second.id].map((boardId) =>
        env.DB.prepare(
          `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
           VALUES(?,?,0,1,0,0)`,
        ).bind(operationId, boardId),
      ),
      env.DB.prepare(`UPDATE boards SET pending_access_operation_id=? WHERE id IN (?,?)`).bind(
        operationId,
        first.id,
        second.id,
      ),
    ]);

    // Only one participant acknowledged: the other's prepare never landed.
    expect(
      (await callBoardInternal(first.id, "/internal/access/prepare", { operationId, generation: 1 })).status,
    ).toBe(200);
    expect(await readAccessState(first.id)).toEqual({
      generation: 1,
      pendingOperationId: operationId,
      frozen: 1,
    });
    expect(await readAccessState(second.id)).toEqual({ generation: 0, pendingOperationId: null, frozen: 0 });

    await recoverAccessChanges(env);

    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      result: JSON.stringify("forbidden"),
      notified: 1,
    });
    // Nothing was applied, and no notification was invented for a change that
    // never happened (a hand-built reservation captured no recipients).
    expect((await readOperation(operationId))!.notifyUserIds).toBe("[]");
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?",
        workspace,
        victim.id,
      ),
    ).toBe(1);

    // Both participants are terminal: the reserved generation is consumed, and
    // the unprepared one is released without a local pending fence.
    for (const board of [first, second]) {
      expect((await readBoard(board.id))?.accessVersion).toBe(1);
      expect(await readAccessState(board.id)).toEqual({
        generation: 1,
        pendingOperationId: null,
        frozen: 0,
      });
    }
    expect((await readParticipants(operationId)).map((row) => row.released)).toEqual([1, 1]);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId)).toBe(0);
  });

  it("journals board deletion, sets effect_started before the terminal DO delete, and finishes it after a crash", async () => {
    const session = await signupAdmin();
    const workspace = await createWorkspace(session, "Deletion workspace");
    const board = await createBoard(session, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();

    const deleted = await del(`/boards/${board.id}?operationId=${operationId}`, session);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    expect(await readBoard(board.id)).toBeNull();
    expect(await countRows("SELECT COUNT(*) AS n FROM board_members WHERE board_id=?", board.id)).toBe(0);
    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "committed",
      effectStarted: 1,
      notified: 1,
    });
    expect(await readParticipants(operationId)).toMatchObject([{ released: 1 }]);
    // Content is gone; only deletion/recovery metadata survives the terminal path.
    const cards = await runInDurableObject(boardStub(board.id), (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM cards`)
        .toArray()[0]!,
    );
    expect(cards.n).toBe(0);

    // Crash past the DO deletion but before the D1 commit: recovery may only
    // finish the deletion, never reopen or abort it.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO boards(id,name,board_key,owner_id,icon,color,workspace_id,access_mode,access_version,pending_access_operation_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        before.id,
        before.name,
        before.boardKey,
        before.ownerId,
        before.icon,
        before.color,
        before.workspaceId,
        before.accessMode,
        before.accessVersion,
        operationId,
        before.createdAt,
      ),
      env.DB.prepare(
        `UPDATE access_change_operations SET phase='preparing',outcome=NULL,result_json=NULL,notified=0 WHERE id=?`,
      ).bind(operationId),
      env.DB.prepare(`UPDATE access_change_boards SET prepared=1,released=0 WHERE operation_id=?`).bind(operationId),
      env.DB.prepare(`INSERT OR IGNORE INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`).bind(
        workspace,
        operationId,
      ),
    ]);

    await recoverAccessChanges(env);

    expect(await readBoard(board.id)).toBeNull();
    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "committed",
      effectStarted: 1,
      notified: 1,
    });
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId)).toBe(0);
  });

  it("keeps a newer fence when a stale prepare or release arrives", async () => {
    const session = await signupAdmin();
    const actor = await me(session);
    const workspace = await createWorkspace(session, "Fence workspace");
    const board = await createBoard(session, workspace, "workspace");
    const now = Date.now();

    // A newer attempt already owns the fence, at generation 3.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,outcome,created_at,updated_at)
         VALUES('other-operation',?,'board-move','{}','hash','preparing',NULL,?,?)`,
      ).bind(actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,created_at,updated_at)
         VALUES('older-operation',?,'board-move','{}','hash','preparing',?,?)`,
      ).bind(actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
         VALUES('other-operation',?,0,3,1,0)`,
      ).bind(board.id),
      env.DB.prepare(
        `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
         VALUES('older-operation',?,0,1,0,0)`,
      ).bind(board.id),
      env.DB.prepare(`UPDATE boards SET pending_access_operation_id='other-operation' WHERE id=?`).bind(board.id),
    ]);
    expect(
      (await callBoardInternal(board.id, "/internal/access/prepare", { operationId: "other-operation", generation: 3 }))
        .status,
    ).toBe(200);
    expect(await readAccessState(board.id)).toEqual({
      generation: 3,
      pendingOperationId: "other-operation",
      frozen: 1,
    });

    // An older prepare cannot refreeze, or steal, a fence it no longer owns.
    expect(
      (await callBoardInternal(board.id, "/internal/access/prepare", { operationId: "older-operation", generation: 1 }))
        .status,
    ).toBe(409);
    expect(await readAccessState(board.id)).toEqual({
      generation: 3,
      pendingOperationId: "other-operation",
      frozen: 1,
    });

    // Committing is what makes the participant releasable.
    await env.DB.prepare(
      `UPDATE access_change_operations SET phase='committed',outcome='committed' WHERE id='other-operation'`,
    ).run();
    expect(
      (await callBoardInternal(board.id, "/internal/access/release", { operationId: "other-operation", generation: 3 }))
        .status,
    ).toBe(200);
    expect(await readAccessState(board.id)).toEqual({
      generation: 3,
      pendingOperationId: null,
      frozen: 0,
    });

    // A stale release must not unlock, or downgrade, the newer generation. The
    // older attempt is terminal, so only the generation guard can refuse it.
    await env.DB.prepare(
      `UPDATE access_change_operations SET phase='aborted',outcome='aborted' WHERE id='older-operation'`,
    ).run();
    expect(
      (await callBoardInternal(board.id, "/internal/access/release", { operationId: "older-operation", generation: 1 }))
        .status,
    ).toBe(200);
    expect(await readAccessState(board.id)).toEqual({
      generation: 3,
      pendingOperationId: null,
      frozen: 0,
    });
  });

  it("enforces a durable fence across a restart and refuses content while frozen", async () => {
    const session = await signupAdmin();
    const actor = await me(session);
    const workspace = await createWorkspace(session, "Hibernation workspace");
    const board = await createBoard(session, workspace, "workspace");
    const operationId = crypto.randomUUID();
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,created_at,updated_at)
         VALUES(?,?,'board-move','{}','hash','preparing',?,?)`,
      ).bind(operationId, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
         VALUES(?,?,0,1,1,0)`,
      ).bind(operationId, board.id),
      env.DB.prepare(`UPDATE boards SET pending_access_operation_id=? WHERE id=?`).bind(operationId, board.id),
    ]);
    expect(
      (await callBoardInternal(board.id, "/internal/access/prepare", { operationId, generation: 1 })).status,
    ).toBe(200);

    const stub = boardStub(board.id);
    // A restart: in-memory state is gone, durable storage (and the fence) is not.
    await abortAllDurableObjects();
    // The fence lives in durable storage, so a freshly constructed instance reports it.
    expect(await readAccessState(board.id)).toEqual({
      generation: 1,
      pendingOperationId: operationId,
      frozen: 1,
    });

    const refused = await stub.fetch("https://board.internal/ws", {
      headers: {
        Upgrade: "websocket",
        [INTERNAL_BOARD_ID_HEADER]: board.id,
        [INTERNAL_USER_ID_HEADER]: actor.id,
      },
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "access_change_pending" });
  });

  it("sends frames only to open sockets holding the current generation", async () => {
    const session = await signupAdmin();
    const workspace = await createWorkspace(session, "Send guard workspace");
    const board = await createBoard(session, workspace, "workspace");
    const stub = boardStub(board.id);
    await readAccessState(board.id);

    const outcome = await runInDurableObject(stub, async (instance: BoardDO, state) => {
      // `send` is the DO's private frame boundary; this test drives it directly.
      const guarded = instance as unknown as { send(ws: WebSocket, message: unknown): void };
      const delivered: string[] = [];
      const accept = (generation: number) => {
        const { 0: client, 1: server } = new WebSocketPair();
        state.acceptWebSocket(server);
        server.serializeAttachment({ generation, protocolVersion: REALTIME_PROTOCOL_VERSION });
        client.accept();
        client.addEventListener("message", (event) => {
          delivered.push(String(event.data));
        });
        return server;
      };

      state.storage.sql.exec(
        "UPDATE board_access_state SET generation=4,pending_operation_id=NULL,frozen=0 WHERE id=1",
      );
      const current = accept(4);
      const stale = accept(3);
      const closing = accept(4);
      // A socket that is closing can still appear in `getWebSockets()`.
      closing.close(1000, "closing");

      guarded.send(current, { type: "error", mutationId: null, message: "current" });
      guarded.send(stale, { type: "error", mutationId: null, message: "stale" });
      let closingThrew = false;
      try {
        guarded.send(closing, { type: "error", mutationId: null, message: "closing" });
      } catch {
        closingThrew = true;
      }
      // A yield lets the accepted client sockets receive what was actually sent.
      await scheduler.wait(0);
      const whileOpen = [...delivered];

      state.storage.sql.exec(
        "UPDATE board_access_state SET generation=4,pending_operation_id='frozen-op',frozen=1 WHERE id=1",
      );
      guarded.send(current, { type: "error", mutationId: null, message: "frozen" });
      await scheduler.wait(0);

      return {
        whileOpen,
        afterFreeze: [...delivered],
        closingThrew,
        closingState: closing.readyState,
        listed: state.getWebSockets().length,
      };
    });

    expect(outcome.whileOpen).toEqual([JSON.stringify({ type: "error", mutationId: null, message: "current" })]);
    // The frozen generation produced no further frame.
    expect(outcome.afterFreeze).toEqual(outcome.whileOpen);
    expect(outcome.closingThrew).toBe(false);
    expect(outcome.closingState).not.toBe(WebSocket.OPEN);
    expect(outcome.listed).toBeGreaterThan(0);
  });

  it("notifies captured recipients and no one else, through the private PresenceDO route", async () => {
    const admin = await signupAdmin();
    const outsider = await signupMember(admin);
    const workspace = await createWorkspace(admin, "Notify workspace");
    const board = await createBoard(admin, workspace, "workspace");
    const destination = await createWorkspace(admin, "Notify destination");

    const adminPresence = await connectPresence(admin);
    const outsiderPresence = await connectPresence(outsider);

    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      {
        destinationWorkspaceId: destination,
        expectedWorkspaceId: workspace,
        expectedAccessVersion: board.accessVersion,
        operationId: crypto.randomUUID(),
      },
      admin,
    );
    expect(moved.status).toBe(200);

    const invalidations = await adminPresence.nextInvalidation();
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({ workspaceIds: expect.arrayContaining([workspace, destination]) });
    expect(invalidations[0]).toMatchObject({ boardIds: [board.id] });
    // An account with no visibility in either workspace never receives the hint.
    await scheduler.wait(0);
    expect(outsiderPresence.invalidations()).toEqual([]);
  });

  it("converges under concurrent recovery passes with a single terminal result", async () => {
    const session = await signupAdmin();
    const workspace = await createWorkspace(session, "Concurrent source");
    const board = await createBoard(session, workspace, "workspace");
    const destination = await createWorkspace(session, "Concurrent destination");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          {
            destinationWorkspaceId: destination,
            expectedWorkspaceId: workspace,
            expectedAccessVersion: board.accessVersion,
            operationId,
          },
          session,
        )
      ).status,
    ).toBe(200);
    await rewindToReserved(operationId, before);

    await Promise.all([recoverAccessChanges(env), recoverAccessChanges(env)]);

    const after = (await readBoard(board.id))!;
    const operation = (await readOperation(operationId))!;
    expect(operation.phase).toBe("completed");
    // Exactly one terminal result: applied once or not at all, never twice.
    if (operation.outcome === "committed") {
      expect(after).toMatchObject({ workspaceId: destination, accessVersion: 1, pendingOperationId: null });
    } else {
      expect(after).toMatchObject({ workspaceId: workspace, accessVersion: 1, pendingOperationId: null });
    }
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId)).toBe(0);
    expect((await readParticipants(operationId)).map((row) => row.released)).toEqual([1]);
    expect(await readAccessState(board.id)).toEqual({ generation: 1, pendingOperationId: null, frozen: 0 });
  });

  it("advances every fenced board's generation on each successful membership change", async () => {
    const admin = await signupAdmin();
    const member = await signupMember(admin);
    const target = await me(member);
    const workspace = await createWorkspace(admin, "Generation workspace");
    const first = await createBoard(admin, workspace, "workspace");
    const second = await createBoard(admin, workspace, "workspace");
    const restricted = await createBoard(admin, workspace, "restricted");

    // Acceptance fences every board of the workspace, Private ones included: a
    // workspace role decides who may open a Private board (its admins).
    const everyBoard = [first, second, restricted];
    const expectGeneration = async (generation: number) => {
      for (const board of everyBoard) {
        expect((await readBoard(board.id))?.accessVersion).toBe(generation);
        expect(await readAccessState(board.id)).toEqual({
          generation,
          pendingOperationId: null,
          frozen: 0,
        });
      }
    };
    await inviteToWorkspace(admin, workspace, member);
    await expectGeneration(1);

    // The next transition reserves 1 -> 2 rather than reusing generation 1, so D1
    // and the DO keep agreeing on which revision the board is on.
    const roleOperation = crypto.randomUUID();
    const roleChange = await patch(
      `/workspaces/${workspace}/members/${target.id}`,
      { role: "admin", operationId: roleOperation },
      admin,
    );
    expect(roleChange.status).toBe(200);
    await expectGeneration(2);
    expect(await readParticipants(roleOperation)).toMatchObject(
      everyBoard
        .map((board) => ({ boardId: board.id, expectedVersion: 1, nextVersion: 2, prepared: 1, released: 1 }))
        .sort((a, b) => a.boardId.localeCompare(b.boardId)),
    );

    // An explicit board grant fences exactly its own board.
    const addOperation = crypto.randomUUID();
    expect(
      (await post(`/boards/${restricted.id}/members`, { userId: target.id, operationId: addOperation }, admin))
        .status,
    ).toBe(200);
    expect((await readBoard(restricted.id))?.accessVersion).toBe(3);
    expect(await readAccessState(restricted.id)).toEqual({
      generation: 3,
      pendingOperationId: null,
      frozen: 0,
    });
    expect(await readParticipants(addOperation)).toMatchObject([
      { boardId: restricted.id, expectedVersion: 2, nextVersion: 3, prepared: 1, released: 1 },
    ]);
    for (const board of [first, second]) expect((await readBoard(board.id))?.accessVersion).toBe(2);
    // And a removal continues the same sequence on every board of the workspace.
    const removeOperation = crypto.randomUUID();
    expect(
      (
        await delBody(
          `/workspaces/${workspace}/members/${target.id}`,
          { operationId: removeOperation },
          admin,
        )
      ).status,
    ).toBe(200);
    for (const board of [first, second]) {
      expect((await readBoard(board.id))?.accessVersion).toBe(3);
      expect(await readAccessState(board.id)).toEqual({
        generation: 3,
        pendingOperationId: null,
        frozen: 0,
      });
    }
    expect((await readBoard(restricted.id))?.accessVersion).toBe(4);
    expect(await readAccessState(restricted.id)).toEqual({
      generation: 4,
      pendingOperationId: null,
      frozen: 0,
    });
  });

  it("releases an aborted pre-effect deletion instead of stranding a frozen board", async () => {
    const admin = await signupAdmin();
    const member = await signupMember(admin);
    const target = await me(member);
    const workspace = await createWorkspace(admin, "Abort delete workspace");
    await inviteToWorkspace(admin, workspace, member);
    const board = await createBoard(admin, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    const now = Date.now();

    // A deletion reserved for a caller with no management of the board: the DO is
    // prepared, and the commit-time recheck refuses it before the effect starts.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,created_at,updated_at)
         VALUES(?,?,'board-delete',?,'hash','preparing',?,?)`,
      ).bind(
        operationId,
        target.id,
        JSON.stringify({ boardId: board.id, workspaceId: workspace, ownerId: before.ownerId }),
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`).bind(
        workspace,
        operationId,
      ),
      env.DB.prepare(
        `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
         VALUES(?,?,?,?,0,0)`,
      ).bind(operationId, board.id, before.accessVersion, before.accessVersion + 1),
      env.DB.prepare(`UPDATE boards SET pending_access_operation_id=? WHERE id=?`).bind(
        operationId,
        board.id,
      ),
    ]);
    expect(
      (await callBoardInternal(board.id, "/internal/access/prepare", { operationId, generation: before.accessVersion + 1 }))
        .status,
    ).toBe(200);
    expect(await readAccessState(board.id)).toEqual({
      generation: before.accessVersion + 1,
      pendingOperationId: operationId,
      frozen: 1,
    });

    await recoverAccessChanges(env);

    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      effectStarted: 0,
    });
    // Nothing was deleted, and the fence the abort consumed was released: a board
    // that stayed frozen with no unfinished operation would be permanently unusable.
    expect(await readBoard(board.id)).toMatchObject({
      id: board.id,
      accessVersion: before.accessVersion + 1,
      pendingOperationId: null,
    });
    expect(await readAccessState(board.id)).toEqual({
      generation: before.accessVersion + 1,
      pendingOperationId: null,
      frozen: 0,
    });
    expect((await readParticipants(operationId)).map((row) => row.released)).toEqual([1]);

    // The owner can really use the board again.
    const upgrade = await boardStub(board.id).fetch("https://board.internal/ws", {
      headers: {
        Upgrade: "websocket",
        [INTERNAL_BOARD_ID_HEADER]: board.id,
        [INTERNAL_USER_ID_HEADER]: before.ownerId,
      },
    });
    expect(upgrade.status).toBe(101);
    upgrade.webSocket?.accept();
    upgrade.webSocket?.close(1000, "test finished");
  });

  it("materializes and rechecks participants inside the reservation transaction", async () => {
    const admin = await signupAdmin();
    const actor = await sessionUser(admin);
    const member = await signupMember(admin);
    const target = await me(member);
    const workspace = await createWorkspace(admin, "Reservation source");
    const destination = await createWorkspace(admin, "Reservation destination");
    await inviteToWorkspace(admin, workspace, member);
    const board = await createBoard(admin, workspace, "workspace");
    const restricted = await createBoard(admin, workspace, "restricted");

    // A board whose placement changed after the caller resolved it is refused, and
    // the refusal is total: no journal row, no scope and no pending marker survive.
    const staleOperation = crypto.randomUUID();
    await expect(
      runAccessChange(env, actor, {
        operationId: staleOperation,
        kind: "board-move",
        payload: {
          boardId: board.id,
          destinationWorkspaceId: destination,
          expectedWorkspaceId: workspace,
          expectedAccessVersion: (await readBoard(board.id))!.accessVersion,
          ownerId: actor.id,
          grantManager: false,
        },
        workspaceIds: [workspace, destination],
        boards: [{ boardId: board.id, workspaceId: destination }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", staleOperation)).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", staleOperation)).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_boards WHERE operation_id=?", staleOperation)).toBe(0);
    expect((await readBoard(board.id))?.pendingOperationId).toBeNull();
    expect(await readAccessState(board.id)).toEqual({ generation: 0, pendingOperationId: null, frozen: 0 });

    // Authority is re-asserted in the same transaction: a caller who is not a
    // manager of the workspace cannot reserve the change at all, so nothing is
    // written for the refused attempt.
    const plainMember = await sessionUser(member);
    const refusedOperation = crypto.randomUUID();
    await expect(
      runAccessChange(env, plainMember, {
        operationId: refusedOperation,
        kind: "workspace-member-role",
        payload: { workspaceId: workspace, userId: target.id, role: "admin" },
        workspaceIds: [workspace],
        inheritWorkspaceBoards: true,
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", refusedOperation)).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_boards WHERE operation_id=?", refusedOperation)).toBe(0);

    // Every board present at reservation time is fenced, Private ones included (a
    // workspace admin opens those), including ones created after the caller
    // resolved anything of its own.
    const lateBoard = await createBoard(admin, workspace, "workspace");
    const before = {
      board: (await readBoard(board.id))!.accessVersion,
      late: (await readBoard(lateBoard.id))!.accessVersion,
      restricted: (await readBoard(restricted.id))!.accessVersion,
    };
    const removeOperation = crypto.randomUUID();
    const result = await runAccessChange(env, actor, {
      operationId: removeOperation,
      kind: "workspace-member-remove",
      payload: { workspaceId: workspace, userId: target.id },
      workspaceIds: [workspace],
      inheritWorkspaceBoards: true,
    });
    expect(result).toMatchObject({ state: "completed", outcome: "committed" });
    // The journal names exactly the workspace's boards; the read orders them by id,
    // so compare as a set rather than by insertion order.
    expect(
      (await readParticipants(removeOperation)).map((row) => row.boardId).sort(),
    ).toEqual([board.id, lateBoard.id, restricted.id].sort());
    expect((await readBoard(board.id))?.accessVersion).toBe(before.board + 1);
    expect((await readBoard(lateBoard.id))?.accessVersion).toBe(before.late + 1);
    expect((await readBoard(restricted.id))?.accessVersion).toBe(before.restricted + 1);
    expect(await readAccessState(lateBoard.id)).toEqual({
      generation: before.late + 1,
      pendingOperationId: null,
      frozen: 0,
    });
  });

  it("binds an attempt id to its kind and replays a recorded resolution exactly", async () => {
    const admin = await signupAdmin();
    const member = await signupMember(admin);
    const target = await me(member);
    const workspace = await createWorkspace(admin, "Attempt identity workspace");
    const board = await createBoard(admin, workspace, "restricted");
    const operationId = crypto.randomUUID();

    expect(
      (await post(`/boards/${board.id}/members`, { userId: target.id, operationId }, admin)).status,
    ).toBe(200);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?",
        board.id,
        target.id,
      ),
    ).toBe(1);

    // Add and remove share one payload shape, so identity alone cannot tell them
    // apart: the kind is bound too, and the collision changes nothing.
    const reused = await delBody(
      `/boards/${board.id}/members/${target.id}`,
      { operationId },
      admin,
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "access_change_conflict" });
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?",
        board.id,
        target.id,
      ),
    ).toBe(1);

    // A real removal, then its own replay, both answer success.
    const removeId = crypto.randomUUID();
    expect(
      (
        await delBody(
          `/boards/${board.id}/members/${target.id}`,
          { operationId: removeId },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?",
        board.id,
        target.id,
      ),
    ).toBe(0);
    expect(
      (
        await delBody(
          `/boards/${board.id}/members/${target.id}`,
          { operationId: removeId },
          admin,
        )
      ).status,
    ).toBe(200);

    // A deletion removes the board, so its retry can only be answered from the
    // journal: it replays the recorded success instead of "board not found".
    const deleteId = crypto.randomUUID();
    expect((await del(`/boards/${board.id}?operationId=${deleteId}`, admin)).status).toBe(200);
    expect(await readBoard(board.id)).toBeNull();
    const deleteRetry = await del(`/boards/${board.id}?operationId=${deleteId}`, admin);
    expect(deleteRetry.status).toBe(200);
    expect(await deleteRetry.json()).toEqual({ ok: true });
  });

  it("replays an inherited mover's move after it granted them manager", async () => {
    const admin = await signupAdmin();
    const mover = await signupMember(admin);
    const moverId = (await me(mover)).id;
    const source = await createWorkspace(admin, "Move source");
    const destination = await createWorkspace(admin, "Move destination");
    await inviteToWorkspace(admin, source, mover, "admin");
    await inviteToWorkspace(admin, destination, mover);
    const board = await createBoard(admin, source, "workspace");
    const operationId = crypto.randomUUID();
    const input = {
      destinationWorkspaceId: destination,
      expectedWorkspaceId: source,
      expectedAccessVersion: board.accessVersion,
      operationId,
    };

    const first = await post(`/boards/${board.id}/move-workspace`, input, mover);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ operationId, state: "completed", outcome: "committed" });
    // The move granted the mover an explicit manager grant, which is exactly the
    // field a recomputed payload would resolve differently on the retry.
    expect(
      (
        await env.DB.prepare("SELECT role FROM board_members WHERE board_id=? AND user_id=?")
          .bind(board.id, moverId)
          .first<{ role: string }>()
      )?.role,
    ).toBe("manager");

    const retry = await post(`/boards/${board.id}/move-workspace`, input, mover);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ operationId, state: "completed", outcome: "committed" });
    expect((await readBoard(board.id))?.accessVersion).toBe(1);
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", operationId)).toBe(1);
  });

  it("answers a pending status read by driving its own recovery", async () => {
    const session = await signupAdmin();
    const workspace = await createWorkspace(session, "Status source");
    const board = await createBoard(session, workspace, "workspace");
    const destination = await createWorkspace(session, "Status destination");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          {
            destinationWorkspaceId: destination,
            expectedWorkspaceId: workspace,
            expectedAccessVersion: board.accessVersion,
            operationId,
          },
          session,
        )
      ).status,
    ).toBe(200);
    await rewindToReserved(operationId, before);
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing" });

    // The actor asking for status is the one waiting: the read itself advances the
    // attempt instead of reporting "pending" until the next cron pass.
    const status = await get(`/access-changes/${operationId}`, session);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      operationId,
      state: "completed",
      outcome: "committed",
      result: { boardId: board.id, workspaceId: destination, accessMode: "restricted" },
    });
    expect(await readBoard(board.id)).toMatchObject({
      workspaceId: destination,
      accessVersion: 1,
      pendingOperationId: null,
    });
    expect(await readAccessState(board.id)).toEqual({
      generation: 1,
      pendingOperationId: null,
      frozen: 0,
    });
  });

  it("notifies a board whose recipient set exceeds one statement's parameter budget", async () => {
    const admin = await signupAdmin();
    const workspace = await createWorkspace(admin, "Large audience");
    const board = await createBoard(admin, workspace, "workspace");

    // Every one of these accounts is a member of the workspace, so this board has far
    // more captured recipients than D1 allows bound parameters in one statement.
    // Reading them in one query made the notification throw after the policy had
    // already committed, which surfaced as a failed delete.
    await env.DB.prepare(
      `INSERT INTO users(id,email,name,password_hash,created_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1200)
       SELECT 'bulk-'||n,'bulk-'||n||'@example.test','Bulk '||n,'hash',? FROM seq`,
    )
      .bind(Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
       SELECT ?,id,'member',?,? FROM users WHERE id LIKE 'bulk-%'`,
    )
      .bind(workspace, Date.now(), Date.now())
      .run();
    expect(
      await countRows("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id LIKE 'bulk-%'", workspace),
    ).toBe(1200);

    const operationId = crypto.randomUUID();
    const deleted = await del(`/boards/${board.id}?operationId=${operationId}`, admin);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    const operation = (await readOperation(operationId))!;
    expect(operation).toMatchObject({ phase: "completed", outcome: "committed", notified: 1 });
    // Nothing was truncated to fit: every captured recipient is still named.
    expect(JSON.parse(operation.notifyUserIds).length).toBeGreaterThan(1200);
    expect(await readBoard(board.id)).toBeNull();

    // The hint is retried from the journal on its own, without reopening the policy
    // change it reports.
    await env.DB.prepare("UPDATE access_change_operations SET notified=0 WHERE id=?")
      .bind(operationId)
      .run();
    await recoverAccessChanges(env);
    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "committed",
      notified: 1,
    });
  });

  it("prunes settled, notified operations after thirty days with their participant rows, and nothing else", async () => {
    const DAY = 86_400_000;
    const now = Date.now();
    const insert = async (id: string, phase: string, notified: number, updatedAt: number) => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,outcome,notify_user_ids_json,notified,created_at,updated_at)
           VALUES(?,'actor','board-member-add','{}','hash',?,?,'[]',?,?,?)`,
        ).bind(id, phase, phase === "preparing" ? null : "committed", notified, updatedAt, updatedAt),
        env.DB.prepare(
          `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released) VALUES(?,?,0,1,1,1)`,
        ).bind(id, `board-of-${id}`),
      ]);
    };
    const tag = crypto.randomUUID();
    const [old, unnotified, preparing, committed, aborted, recent] = ["old", "unnotified", "preparing", "committed", "aborted", "recent"].map((name) => `${tag}-${name}`);
    await insert(old!, "completed", 1, now - 31 * DAY);
    await insert(unnotified!, "completed", 0, now - 31 * DAY);
    await insert(preparing!, "preparing", 0, now - 31 * DAY);
    await insert(committed!, "committed", 1, now - 31 * DAY);
    await insert(aborted!, "aborted", 1, now - 31 * DAY);
    await insert(recent!, "completed", 1, now - 29 * DAY);

    await pruneAccessChanges(env, now);
    const present = async (id: string) => ({
      operation: await countRows("SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?", id),
      participants: await countRows("SELECT COUNT(*) AS n FROM access_change_boards WHERE operation_id=?", id),
    });
    expect(await present(old!)).toEqual({ operation: 0, participants: 0 });
    for (const kept of [unnotified!, preparing!, committed!, aborted!, recent!]) {
      expect(await present(kept), kept).toEqual({ operation: 1, participants: 1 });
    }

    // Leave the journal as other tests expect it: no unfinished rows of this one.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM access_change_boards WHERE operation_id LIKE ?").bind(`${tag}%`),
      env.DB.prepare("DELETE FROM access_change_operations WHERE id LIKE ?").bind(`${tag}%`),
    ]);
  });

  it("prunes from the cron pass, which is what keeps the journal from growing forever", async () => {
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,outcome,notify_user_ids_json,notified,created_at,updated_at)
         VALUES(?,'actor','board-member-add','{}','hash','completed','committed','[]',1,0,?)`,
      ).bind(id, Date.now() - 40 * 86_400_000),
      env.DB.prepare(
        `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released) VALUES(?,?,0,1,1,1)`,
      ).bind(id, `board-of-${id}`),
    ]);
    await recoverAccessChanges(env);
    expect(await readOperation(id)).toBeNull();
    expect(await countRows("SELECT COUNT(*) AS n FROM access_change_boards WHERE operation_id=?", id)).toBe(0);
  });

  it("prunes workspace invites that expired or were revoked over thirty days ago, and keeps the rest", async () => {
    const DAY = 86_400_000;
    const now = Date.now();
    const tag = crypto.randomUUID();
    const insert = (name: string, expiresAt: number, revokedAt: number | null) =>
      env.DB.prepare(
        `INSERT INTO workspace_invites(id,workspace_id,role,token_hash,invited_by,created_at,expires_at,revoked_at) VALUES(?,?, 'member',?,'inviter',?,?,?)`,
      ).bind(`${tag}-${name}`, `${tag}-workspace`, `${tag}-${name}-hash`, now - 90 * DAY, expiresAt, revokedAt);
    await env.DB.batch([
      insert("expired-long-ago", now - 31 * DAY, null),
      insert("revoked-long-ago", now + 5 * DAY, now - 31 * DAY),
      insert("expired-recently", now - 29 * DAY, null),
      insert("revoked-recently", now + 5 * DAY, now - 29 * DAY),
      insert("live", now + 5 * DAY, null),
    ]);
    await pruneWorkspaceInvites(env, now);
    const left = await env.DB.prepare("SELECT id FROM workspace_invites WHERE workspace_id=? ORDER BY id").bind(`${tag}-workspace`).all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual(["expired-recently", "live", "revoked-recently"].map((name) => `${tag}-${name}`));
    await env.DB.prepare("DELETE FROM workspace_invites WHERE workspace_id=?").bind(`${tag}-workspace`).run();
  });

  it("sends an operation that is still pending to the back of the recovery queue, like one that throws", async () => {
    const id = crypto.randomUUID();
    const old = Date.now() - 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,notify_user_ids_json,notified,created_at,updated_at)
         VALUES(?,'actor','workspace-member-remove',?,'hash','preparing','[]',0,?,?)`,
      ).bind(id, JSON.stringify({ workspaceId: "w", userId: "u" }), old, old),
      env.DB.prepare(`INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released) VALUES(?,?,0,1,0,0)`).bind(id, `board-of-${id}`),
    ]);
    // The participant never answers, so the row cannot get past prepare: it is not an error, only not done.
    const unreachable = { idFromName: () => "board", get: () => ({ fetch: () => Promise.reject(new Error("DO unavailable")) }) };
    await recoverAccessChanges({ ...env, BOARD_DO: unreachable } as unknown as typeof env);
    const row = await env.DB.prepare("SELECT phase,updated_at AS updatedAt FROM access_change_operations WHERE id=?").bind(id).first<{ phase: string; updatedAt: number }>();
    expect(row?.phase).toBe("preparing");
    expect(row!.updatedAt).toBeGreaterThan(old);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM access_change_boards WHERE operation_id=?").bind(id),
      env.DB.prepare("DELETE FROM access_change_operations WHERE id=?").bind(id),
    ]);
  });

  it("deletes a board's GitHub routing pointers with the board", async () => {
    const admin = await signupAdmin();
    const workspace = await createWorkspace(admin, "Routes workspace");
    const doomed = await createBoard(admin, workspace, "workspace");
    const kept = await createBoard(admin, workspace, "workspace");
    const repoId = Math.floor(Math.random() * 1_000_000_000);
    await env.DB.batch(
      [doomed.id, kept.id].flatMap((boardId) => [
        env.DB.prepare("INSERT INTO github_pr_routes(repo_id,pr_number,board_id) VALUES(?,?,?)").bind(repoId, 7, boardId),
        env.DB.prepare("INSERT INTO github_branch_routes(repo_id,branch_name,board_id) VALUES(?,?,?)").bind(repoId, "feature/x", boardId),
      ]),
    );
    expect((await del(`/boards/${doomed.id}?operationId=${crypto.randomUUID()}`, admin)).status).toBe(200);
    for (const table of ["github_pr_routes", "github_branch_routes"]) {
      const rows = await env.DB.prepare(`SELECT board_id AS boardId FROM ${table} WHERE repo_id=?`).bind(repoId).all<{ boardId: string }>();
      expect(rows.results, table).toEqual([{ boardId: kept.id }]);
    }
  });

  it("recovers stuck operations even when pruning fails, and says so", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,outcome,notify_user_ids_json,notified,created_at,updated_at)
       VALUES(?,'actor','board-member-add','{}','hash','completed','committed','[]',0,?,?)`,
    ).bind(id, Date.now(), Date.now()).run();
    // Every statement works except the prune's deletes.
    const failingPrune = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("DELETE FROM access_change_boards WHERE operation_id IN")) throw new Error("D1 unavailable");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recoverAccessChanges({ ...env, DB: failingPrune });
      expect(warn).toHaveBeenCalledWith("[access-changes] prune failed:", "D1 unavailable");
    } finally {
      warn.mockRestore();
    }
    expect(await readOperation(id)).toMatchObject({ phase: "completed", notified: 1 });
    await env.DB.prepare("DELETE FROM access_change_operations WHERE id=?").bind(id).run();
  });

  it("does not let rows that keep failing starve a newer operation out of the recovery pass", async () => {
    // More failing rows than one pass reads (20), all older than the row that can be recovered.
    const insert = (id: string, updatedAt: number) =>
      env.DB.prepare(
        `INSERT INTO access_change_operations(id,actor_id,kind,payload_json,payload_hash,phase,notify_user_ids_json,notified,created_at,updated_at)
         VALUES(?,'actor','board-member-add','not json','hash','preparing','[]',0,?,?)`,
      ).bind(id, updatedAt, updatedAt);
    const failing = new Set(Array.from({ length: 25 }, () => crypto.randomUUID()));
    const healthy = crypto.randomUUID();
    const base = Date.now() - 60_000;
    await env.DB.batch([...[...failing].map((id, index) => insert(id, base + index)), insert(healthy, base + 1_000)]);
    // The participant read fails for the failing rows only, so driving them throws.
    const flaky = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("FROM access_change_boards WHERE operation_id=?")) return statement;
            return {
              ...statement,
              bind: (id: string) => {
                if (failing.has(id)) throw new Error("D1 unavailable");
                return statement.bind(id);
              },
            };
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 3; pass++) await recoverAccessChanges({ ...env, DB: flaky });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[access-changes] recovery of operation"), "D1 unavailable");
    } finally {
      warn.mockRestore();
    }
    expect(await readOperation(healthy)).toMatchObject({ phase: "completed", outcome: "aborted" });
    await env.DB.prepare(`DELETE FROM access_change_operations WHERE id IN (${[...failing, healthy].map(() => "?").join(",")})`).bind(...failing, healthy).run();
  });

  it("answers a replay of a pruned attempt as a new attempt, not as an error in the journal", async () => {
    const admin = await signupAdmin();
    const workspace = await createWorkspace(admin, "Replay window");
    const board = await createBoard(admin, workspace, "workspace");
    const operationId = crypto.randomUUID();
    expect((await del(`/boards/${board.id}?operationId=${operationId}`, admin)).status).toBe(200);
    // Within the window the recorded success is replayed even though the board is gone.
    expect((await del(`/boards/${board.id}?operationId=${operationId}`, admin)).status).toBe(200);

    await env.DB.prepare("UPDATE access_change_operations SET updated_at=? WHERE id=?").bind(Date.now() - 31 * 86_400_000, operationId).run();
    await pruneAccessChanges(env);
    expect(await readOperation(operationId)).toBeNull();
    expect((await get(`/access-changes/${operationId}`, admin)).status).toBe(404);
    // Past it the same id finds no attempt: the board is simply not there.
    const replay = await del(`/boards/${board.id}?operationId=${operationId}`, admin);
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual({ error: "board not found" });
  });

  it("notifies each recipient only with the contexts that recipient may know", async () => {
    const admin = await signupAdmin();
    const sourceOnly = await signupMember(admin);
    const destinationOnly = await signupMember(admin);
    const source = await createWorkspace(admin, "Disclosure source");
    const destination = await createWorkspace(admin, "Disclosure destination");
    const board = await createBoard(admin, source, "workspace");
    await inviteToWorkspace(admin, source, sourceOnly);
    await inviteToWorkspace(admin, destination, destinationOnly);

    const sourcePresence = await connectPresence(sourceOnly);
    const destinationPresence = await connectPresence(destinationOnly);

    // The workspace invitation above already consumed a generation on the shared
    // board, so the move carries the version the caller can currently read.
    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      {
        destinationWorkspaceId: destination,
        expectedWorkspaceId: source,
        expectedAccessVersion: (await readBoard(board.id))!.accessVersion,
        operationId: crypto.randomUUID(),
      },
      admin,
    );
    expect(moved.status).toBe(200);

    // The source-only member keeps the board it could already open and learns
    // nothing about the destination workspace it was never invited to.
    const [sourceFrames, destinationFrames] = await Promise.all([
      sourcePresence.nextInvalidation(),
      destinationPresence.nextInvalidation(),
    ]);
    expect(sourceFrames).toHaveLength(1);
    expect(sourceFrames[0]!.workspaceIds).toEqual([source]);
    expect(sourceFrames[0]!.boardIds).toEqual([board.id]);
    // The destination-only member invalidates its own workspace and never receives
    // the restricted board's identity.
    expect(destinationFrames).toHaveLength(1);
    expect(destinationFrames[0]!.workspaceIds).toEqual([destination]);
    expect(destinationFrames[0]!.boardIds).toEqual([]);
  });

  it("refuses a Private board's move and delete for a workspace member who holds no grant on it", async () => {
    const admin = await signupAdmin();
    const actorSession = await signupMember(admin);
    const actor = await sessionUser(actorSession);
    const workspace = await createWorkspace(admin, "Restricted home");
    const destination = await createWorkspace(admin, "Restricted destination");
    await inviteToWorkspace(admin, workspace, actorSession);
    await inviteToWorkspace(admin, destination, actorSession);
    const board = await createBoard(admin, workspace, "restricted");
    const before = (await readBoard(board.id))!;
    expect(before.accessMode).toBe("restricted");
    const deleteId = crypto.randomUUID();
    const moveId = crypto.randomUUID();

    // A workspace admin manages every board of the workspace, a Private one included,
    // but a plain member inherits nothing from a Private board: the reservation
    // transaction — the one place the authority still holds while the scopes are
    // locked — must refuse the membership alone.
    await expect(
      runAccessChange(env, actor, {
        operationId: deleteId,
        kind: "board-delete",
        payload: { boardId: board.id, workspaceId: workspace, ownerId: before.ownerId },
        workspaceIds: [workspace],
        boards: [{ boardId: board.id, workspaceId: workspace }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);
    await expect(
      runAccessChange(env, actor, {
        operationId: moveId,
        kind: "board-move",
        payload: {
          boardId: board.id,
          destinationWorkspaceId: destination,
          expectedWorkspaceId: workspace,
          expectedAccessVersion: before.accessVersion,
          ownerId: before.ownerId,
          grantManager: true,
        },
        workspaceIds: [workspace, destination],
        boards: [{ boardId: board.id, workspaceId: workspace }],
      }),
    ).rejects.toBeInstanceOf(AccessChangeConflict);

    // Nothing was reserved, fenced or moved by either attempt.
    expect(await readBoard(board.id)).toEqual(before);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM access_change_operations WHERE id IN (?,?)",
        deleteId,
        moveId,
      ),
    ).toBe(0);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM access_change_boards WHERE operation_id IN (?,?)",
        deleteId,
        moveId,
      ),
    ).toBe(0);
  });

  it("aborts a reserved move whose only remaining authority was the workspace membership", async () => {
    const admin = await signupAdmin();
    const mover = await signupMember(admin);
    const moverId = (await me(mover)).id;
    const source = await createWorkspace(admin, "Commit source");
    const destination = await createWorkspace(admin, "Commit destination");
    await inviteToWorkspace(admin, source, mover);
    await inviteToWorkspace(admin, destination, mover);
    const board = await createBoard(admin, source, "restricted");
    // The explicit grant is the authority the route's capability read and the
    // reservation both accept; a plain membership of a Private board's workspace is
    // the arm that must not stand in for it once it is gone.
    await env.DB.prepare(`INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`)
      .bind(board.id, moverId)
      .run();
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          {
            destinationWorkspaceId: destination,
            expectedWorkspaceId: source,
            expectedAccessVersion: before.accessVersion,
            operationId,
          },
          mover,
        )
      ).status,
    ).toBe(200);
    expect(await readBoard(board.id)).toMatchObject({ workspaceId: destination });

    // A crash right after the reservation, then the grant is gone while the commit
    // is still outstanding: the evaluation that re-reads authority must abort rather
    // than lean on the workspace membership of a now-Private board.
    await rewindToReserved(operationId, before);
    await env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?")
      .bind(board.id, moverId)
      .run();
    await recoverAccessChanges(env);

    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden),
    });
    expect(await readBoard(board.id)).toMatchObject({
      workspaceId: source,
      accessMode: "restricted",
      // An abort consumes the reserved generation without changing placement, so the
      // board returns to its workspace one version on and unfenced.
      accessVersion: before.accessVersion + 1,
      pendingOperationId: null,
    });
    expect(await readAccessState(board.id)).toEqual({
      generation: before.accessVersion + 1,
      pendingOperationId: null,
      frozen: 0,
    });
    expect(
      await countRows("SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?", board.id, moverId),
    ).toBe(0);
  });

  it("resumes a reserved direct member add through prepare, commit, release and notification", async () => {
    const owner = await signupAdmin();
    const ownerId = (await me(owner)).id;
    const candidate = await signupMember(owner);
    const added = await me(candidate);
    const workspace = await createWorkspace(owner, "Add resume");
    const board = await createBoard(owner, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (await post(`/workspaces/${workspace}/members`, { userId: added.id, operationId }, owner)).status,
    ).toBe(200);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?",
        workspace,
        added.id,
      ),
    ).toBe(1);

    // The crash a reservation can leave: the journal is outstanding, the board sits
    // on its pre-change generation, and the membership was never written.
    await rewindToReserved(operationId, before);
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(workspace, added.id)
      .run();
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing", notified: 0 });
    expect(await readAccessState(board.id)).toEqual({ generation: 0, pendingOperationId: null, frozen: 0 });
    // The account that is about to gain the workspace is listening before the pass.
    const addedPresence = await connectPresence(candidate);

    await recoverAccessChanges(env);

    // The membership landed exactly once, driven by the journal alone.
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='member'",
        workspace,
        added.id,
      ),
    ).toBe(1);
    expect(await readBoard(board.id)).toMatchObject({
      accessVersion: before.accessVersion + 1,
      pendingOperationId: null,
    });
    const operation = (await readOperation(operationId))!;
    expect(operation).toMatchObject({
      phase: "completed",
      outcome: "committed",
      notified: 1,
      effectStarted: 0,
    });
    expect(JSON.parse(operation.notifyUserIds)).toContainEqual(
      expect.objectContaining({ id: added.id }),
    );
    expect(JSON.parse(operation.notifyUserIds)).toContainEqual(
      expect.objectContaining({ id: ownerId, workspaces: expect.arrayContaining([workspace]) }),
    );
    expect(await readParticipants(operationId)).toMatchObject([{ prepared: 1, released: 1 }]);
    expect(
      await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId),
    ).toBe(0);
    expect(await readAccessState(board.id)).toEqual({
      generation: before.accessVersion + 1,
      pendingOperationId: null,
      frozen: 0,
    });
    // The new member hears about the workspace they just joined.
    const invalidations = await addedPresence.nextInvalidation();
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({ workspaceIds: expect.arrayContaining([workspace]) });

    // Recovery is idempotent: a second pass changes nothing.
    await recoverAccessChanges(env);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?",
        workspace,
        added.id,
      ),
    ).toBe(1);
    expect((await readBoard(board.id))?.accessVersion).toBe(before.accessVersion + 1);
  });

  it("lets a workspace Admin remove themselves and releases every fence", async () => {
    const owner = await signupAdmin();
    const leaver = await signupMember(owner);
    const leaverId = (await me(leaver)).id;
    const workspace = await createWorkspace(owner, "Self removal");
    await inviteToWorkspace(owner, workspace, leaver, "admin");
    const board = await createBoard(owner, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();

    const removed = await delBody(`/workspaces/${workspace}/members/${leaverId}`, { operationId }, leaver);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ outcome: "committed" });

    await expectSelfRemovalSettled(operationId, workspace, board.id, before, leaver, owner);
  });

  it("recovers a stranded workspace Admin self-removal to a committed, unfenced state", async () => {
    const owner = await signupAdmin();
    const leaver = await signupMember(owner);
    const leaverId = (await me(leaver)).id;
    const workspace = await createWorkspace(owner, "Self removal recovery");
    await inviteToWorkspace(owner, workspace, leaver, "admin");
    const board = await createBoard(owner, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (await delBody(`/workspaces/${workspace}/members/${leaverId}`, { operationId }, leaver)).status,
    ).toBe(200);

    // The state the contradictory commit assertion used to strand: the journal is
    // outstanding with actor === target, the scope held and the board fenced.
    await rewindToReserved(operationId, before);
    await env.DB.prepare(
      `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'admin',?,?)`,
    )
      .bind(workspace, leaverId, Date.now(), Date.now())
      .run();
    await runInDurableObject(boardStub(board.id), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE board_access_state SET pending_operation_id=?,frozen=1 WHERE id=1`,
        operationId,
      );
    });
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing" });

    await recoverAccessChanges(env);

    await expectSelfRemovalSettled(operationId, workspace, board.id, before, leaver, owner);
  });

  it("aborts a reserved member add whose actor is no longer a manager", async () => {
    const owner = await signupAdmin();
    const adder = await signupMember(owner);
    const adderId = (await me(adder)).id;
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Add abort");
    await inviteToWorkspace(owner, workspace, adder, "admin");
    const board = await createBoard(owner, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect(
      (await post(`/workspaces/${workspace}/members`, { userId: target.id, operationId }, adder)).status,
    ).toBe(200);

    await rewindToReserved(operationId, before);
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(workspace, target.id)
      .run();
    // The management the attempt was reserved under is gone while it is still
    // outstanding, so recovery must abort instead of installing a membership.
    await env.DB.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND user_id=?")
      .bind(workspace, adderId)
      .run();
    await recoverAccessChanges(env);

    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden),
    });
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?",
        workspace,
        target.id,
      ),
    ).toBe(0);
    // An abort consumes the reserved generation without changing the policy.
    expect(await readBoard(board.id)).toMatchObject({
      accessVersion: before.accessVersion + 1,
      pendingOperationId: null,
    });
    expect(await readAccessState(board.id)).toEqual({
      generation: before.accessVersion + 1,
      pendingOperationId: null,
      frozen: 0,
    });
    expect(
      await countRows("SELECT COUNT(*) AS n FROM access_change_scopes WHERE operation_id=?", operationId),
    ).toBe(0);
  });

  it("keeps a board fenced when the abort write fails, and aborts on the next run", async () => {
    const owner = await signupAdmin();
    const adder = await signupMember(owner);
    const adderId = (await me(adder)).id;
    const target = await me(await signupMember(owner));
    const workspace = await createWorkspace(owner, "Abort write fails");
    await inviteToWorkspace(owner, workspace, adder, "admin");
    const board = await createBoard(owner, workspace, "workspace");
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();
    expect((await post(`/workspaces/${workspace}/members`, { userId: target.id, operationId }, adder)).status).toBe(200);
    await rewindToReserved(operationId, before);
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace, target.id).run();
    await env.DB.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND user_id=?").bind(workspace, adderId).run();

    // Fail only the abort's batch, once: D1 can refuse a write and accept the next one.
    const realBatch = env.DB.batch.bind(env.DB);
    let failed = false;
    const batch = vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      // Only this operation's abort: recovery also drives whatever other tests left unfinished.
      const parts = statements.map((statement) => statement as unknown as { statement?: string; params?: unknown[] });
      const abortsThis = parts.some((part) => part.statement?.includes("SET phase='aborted'") && part.params?.includes(operationId));
      if (!failed && abortsThis) {
        failed = true;
        throw new Error("D1 unavailable");
      }
      return realBatch(statements);
    });
    try {
      await recoverAccessChanges(env);
    } finally {
      batch.mockRestore();
    }
    expect(failed).toBe(true);
    // The attempt is still open, so its board must stay fenced.
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing" });
    expect(await readAccessState(board.id)).toMatchObject({ pendingOperationId: operationId, frozen: 1 });

    await recoverAccessChanges(env);
    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden),
    });
    expect(await readAccessState(board.id)).toEqual({ generation: before.accessVersion + 1, pendingOperationId: null, frozen: 0 });
  });

  it("aborts a reserved deletion whose only remaining authority was the workspace membership", async () => {
    const admin = await signupAdmin();
    const deleter = await signupMember(admin);
    const deleterId = (await me(deleter)).id;
    const workspace = await createWorkspace(admin, "Delete source");
    await inviteToWorkspace(admin, workspace, deleter);
    const board = await createBoard(admin, workspace, "restricted");
    await env.DB.prepare(`INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`)
      .bind(board.id, deleterId)
      .run();
    const before = (await readBoard(board.id))!;
    const operationId = crypto.randomUUID();

    // Holding the prepare acknowledgement leaves exactly the state a crash between
    // reservation and commit leaves: the fences reserved, the board row intact, and
    // the deletion not yet staged.
    await env.DB.prepare(
      `CREATE TRIGGER hold_prepared_ack BEFORE UPDATE OF prepared ON access_change_boards
         WHEN NEW.prepared=1 BEGIN SELECT RAISE(ABORT, 'held'); END;`,
    ).run();
    try {
      await expect(
        runAccessChange(env, await sessionUser(deleter), {
          operationId,
          kind: "board-delete",
          payload: { boardId: board.id, workspaceId: workspace, ownerId: before.ownerId },
          workspaceIds: [workspace],
          boards: [{ boardId: board.id, workspaceId: workspace }],
        }),
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER hold_prepared_ack").run();
    }
    expect(await readOperation(operationId)).toMatchObject({ phase: "preparing" });

    await env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?")
      .bind(board.id, deleterId)
      .run();
    await recoverAccessChanges(env);

    expect(await readOperation(operationId)).toMatchObject({
      phase: "completed",
      outcome: "aborted",
      result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden),
    });
    // The deletion never ran against the board it no longer had authority to remove.
    expect(await readBoard(board.id)).toMatchObject({
      workspaceId: workspace,
      accessMode: "restricted",
      pendingOperationId: null,
    });
  });

  describe("a workspace admin's authority over a Private board they hold no grant on", () => {
    /** The crash a reservation can leave: fences reserved, the change itself not yet applied. */
    async function reserveAndStall(run: () => Promise<unknown>, operationId: string) {
      await env.DB.prepare(
        `CREATE TRIGGER hold_prepared_ack BEFORE UPDATE OF prepared ON access_change_boards
           WHEN NEW.prepared=1 BEGIN SELECT RAISE(ABORT, 'held'); END;`,
      ).run();
      try {
        await expect(run()).rejects.toThrow();
      } finally {
        await env.DB.prepare("DROP TRIGGER hold_prepared_ack").run();
      }
      expect(await readOperation(operationId)).toMatchObject({ phase: "preparing" });
    }

    async function privateBoardWithRoleHolder() {
      const founder = await signupAdmin();
      const holder = await signupMember(founder);
      const holderId = (await me(holder)).id;
      const source = await createWorkspace(founder, "Role source");
      const destination = await createWorkspace(founder, "Role destination");
      await inviteToWorkspace(founder, source, holder, "admin");
      await inviteToWorkspace(founder, destination, holder);
      const board = await createBoard(founder, source, "restricted");
      return { founder, holder, holderId, source, destination, board, before: (await readBoard(board.id))! };
    }
    const demote = (workspaceId: string, userId: string) =>
      env.DB.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND user_id=?").bind(workspaceId, userId).run();

    it("commits a reserved move on the workspace admin role alone, and aborts it once the role is gone", async () => {
      for (const demoted of [false, true]) {
        const { holder, holderId, source, destination, board, before } = await privateBoardWithRoleHolder();
        const operationId = crypto.randomUUID();
        await reserveAndStall(
          async () =>
            runAccessChange(env, await sessionUser(holder), {
              operationId,
              kind: "board-move",
              payload: {
                boardId: board.id,
                destinationWorkspaceId: destination,
                expectedWorkspaceId: source,
                expectedAccessVersion: before.accessVersion,
                ownerId: before.ownerId,
                grantManager: true,
              },
              workspaceIds: [source, destination],
              boards: [{ boardId: board.id, workspaceId: source }],
            }),
          operationId,
        );
        if (demoted) await demote(source, holderId);
        await recoverAccessChanges(env);

        if (demoted) {
          expect(await readOperation(operationId)).toMatchObject({
            phase: "completed",
            outcome: "aborted",
            result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden),
          });
          expect(await readBoard(board.id)).toMatchObject({ workspaceId: source, pendingOperationId: null });
        } else {
          expect(await readOperation(operationId)).toMatchObject({ phase: "completed", outcome: "committed" });
          expect(await readBoard(board.id)).toMatchObject({ workspaceId: destination, accessMode: "restricted", pendingOperationId: null });
        }
      }
    });

    it("commits a reserved deletion on the workspace admin role alone, and aborts it once the role is gone", async () => {
      for (const demoted of [false, true]) {
        const { holder, holderId, source, board, before } = await privateBoardWithRoleHolder();
        const operationId = crypto.randomUUID();
        await reserveAndStall(
          async () =>
            runAccessChange(env, await sessionUser(holder), {
              operationId,
              kind: "board-delete",
              payload: { boardId: board.id, workspaceId: source, ownerId: before.ownerId },
              workspaceIds: [source],
              boards: [{ boardId: board.id, workspaceId: source }],
            }),
          operationId,
        );
        if (demoted) await demote(source, holderId);
        await recoverAccessChanges(env);

        expect(await readOperation(operationId)).toMatchObject(
          demoted
            ? { phase: "completed", outcome: "aborted", result: JSON.stringify(ACCESS_CHANGE_ABORT.forbidden) }
            : { phase: "completed", outcome: "committed" },
        );
        expect(await readBoard(board.id)).toEqual(demoted ? expect.objectContaining({ workspaceId: source }) : null);
      }
    });
  });

  it("binds a repeated attempt id to the endpoint inputs that created it", async () => {
    const admin = await signupAdmin();
    const workspace = await createWorkspace(admin, "Replay home");
    const destination = await createWorkspace(admin, "Replay destination");
    const board = await createBoard(admin, workspace, "workspace");
    const operationId = crypto.randomUUID();
    const move = {
      destinationWorkspaceId: destination,
      expectedWorkspaceId: workspace,
      expectedAccessVersion: board.accessVersion,
      operationId,
    };
    expect((await post(`/boards/${board.id}/move-workspace`, move, admin)).status).toBe(200);
    expect(await readBoard(board.id)).toMatchObject({ workspaceId: destination });

    // The id belongs to that request. Another destination, another source version or
    // another board under the same id conflicts instead of replaying its success.
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          { ...move, destinationWorkspaceId: workspace },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          `/boards/${board.id}/move-workspace`,
          { ...move, expectedAccessVersion: move.expectedAccessVersion + 5 },
          admin,
        )
      ).status,
    ).toBe(409);
    const otherBoard = await createBoard(admin, destination, "workspace");
    const otherMove = await post(`/boards/${otherBoard.id}/move-workspace`, move, admin);
    expect(otherMove.status).toBe(409);
    expect(await otherMove.json()).toMatchObject({ code: "access_change_conflict" });
    expect(await readBoard(otherBoard.id)).toMatchObject({ workspaceId: destination });

    // The exact retry still replays the resolution the attempt recorded for itself.
    const retry = await post(`/boards/${board.id}/move-workspace`, move, admin);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      operationId,
      state: "completed",
      outcome: "committed",
    });
    expect((await readBoard(board.id))?.accessVersion).toBe(1);

    // Workspace member writes are bound the same way: target, role and the token a
    // join attempt was issued for.
    const roleMember = await signupMember(admin);
    const roleMemberId = (await me(roleMember)).id;
    const otherMember = await signupMember(admin);
    const otherMemberId = (await me(otherMember)).id;
    await inviteToWorkspace(admin, workspace, roleMember);
    await inviteToWorkspace(admin, workspace, otherMember);
    const roleOperationId = crypto.randomUUID();
    expect(
      (
        await patch(
          `/workspaces/${workspace}/members/${roleMemberId}`,
          { role: "admin", operationId: roleOperationId },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await patch(
          `/workspaces/${workspace}/members/${roleMemberId}`,
          { role: "member", operationId: roleOperationId },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await patch(
          `/workspaces/${workspace}/members/${otherMemberId}`,
          { role: "admin", operationId: roleOperationId },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?")
          .bind(workspace, roleMemberId)
          .first<{ role: string }>()
      )?.role,
    ).toBe("admin");

    const outsider = await signupMember(admin);
    const created = await post(`/workspaces/${workspace}/invites`, { role: "member" }, admin);
    const { token } = await created.json<{ token: string }>();
    const acceptOperationId = crypto.randomUUID();
    expect(
      (
        await post(
          `/workspaces/${workspace}/invites/accept`,
          { token, operationId: acceptOperationId },
          outsider,
        )
      ).status,
    ).toBe(200);
    // A different token under the consumed attempt id is another request, not a replay.
    expect(
      (
        await post(
          `/workspaces/${workspace}/invites/accept`,
          { token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, operationId: acceptOperationId },
          outsider,
        )
      ).status,
    ).toBe(409);
  });

  it("tells a configured operator about a change without giving it workspace management", async () => {
    const admin = await signupAdmin();
    const workspace = await createWorkspace(admin, "Operator visibility");
    const destination = await createWorkspace(admin, "Operator destination");
    const board = await createBoard(admin, workspace, "workspace");
    // A second operator account that is a member of nothing and holds no grant.
    const operator = await signupAdmin();
    const operatorId = (await me(operator)).id;
    const operatorPresence = await connectPresence(operator);

    const moved = await post(
      `/boards/${board.id}/move-workspace`,
      {
        destinationWorkspaceId: destination,
        expectedWorkspaceId: workspace,
        expectedAccessVersion: board.accessVersion,
        operationId: crypto.randomUUID(),
      },
      admin,
    );
    expect(moved.status).toBe(200);

    // Discovery is what an operator has: the attempt's own contexts arrive over its
    // open surface, which previously captured an operator and then filtered it out.
    const frames = await operatorPresence.nextInvalidation();
    expect(frames).toHaveLength(1);
    expect([...frames[0]!.workspaceIds].sort()).toEqual([destination, workspace].sort());
    expect(frames[0]!.boardIds).toEqual([board.id]);

    // Discovery is not management: no directory, settings, invitations or creation.
    expect(
      (
        await post(
          "/boards",
          {
            name: "Operator board",
            key: `O${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
            workspaceId: workspace,
          },
          operator,
        )
      ).status,
    ).toBe(403);
    expect((await get(`/workspaces/${workspace}/members`, operator)).status).toBe(403);
    expect((await get(`/workspaces/${workspace}/invites`, operator)).status).toBe(403);
    expect(
      (await patch(`/workspaces/${workspace}`, { name: "Operator rename" }, operator)).status,
    ).toBe(403);
    expect(
      await countRows("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?", workspace, operatorId),
    ).toBe(0);
    const detail = await get(`/workspaces/${workspace}`, operator);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      workspace: { id: workspace, role: null, access: "operator" },
    });
  });
});
