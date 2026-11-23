import { SELF, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { REALTIME_PROTOCOL_VERSION, SESSION_REVOKED_CLOSE } from "@foxban/shared";
import { revokeIfSessionEnded, revokeRealtimeSessions, sha256Hex } from "../src/auth";
import { boardClient } from "../src/board-client";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_SESSION_HASH_HEADER,
  INTERNAL_USER_ID_HEADER,
  stripInternalHeaders,
  upgradeHeaders,
} from "../src/internal-headers";
import { REVOKE_SESSIONS_PATH } from "../src/session-revocation";

/**
 * A revoked session's open sockets close (ADR 0082). A socket is checked once at upgrade, so deleting the
 * session row does not reach it: sign-out and a password change tell the board and presence objects, which
 * close every socket the revocation names. Driven through real hibernatable sockets on `SELF`.
 */

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

function request(path: string, method: string, body?: unknown, cookie?: string, extra?: HeadersInit) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (path: string, body: unknown, cookie?: string) => request(path, "POST", body, cookie);
const get = (path: string, cookie?: string) => request(path, "GET", undefined, cookie);

const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
/** The hash a socket carries for this session cookie: `name=<id>` → SHA-256 of the id. */
const hashOf = (cookie: string) => sha256Hex(cookie.slice(cookie.indexOf("=") + 1));

/** An instance Admin (`@foxban.test`, admin-signups.ts) mints the invites the ordinary accounts sign up with. */
let adminCookie: string;
beforeAll(async () => {
  const response = await post("/auth/signup", { email: `admin-${crypto.randomUUID()}@foxban.test`, name: "Admin", password: PASSWORD });
  expect(response.status).toBe(200);
  adminCookie = cookieOf(response);
});

type Account = { id: string; email: string; cookie: string };

/** An ordinary account with its own first session. */
async function account(): Promise<Account> {
  const { token } = await (await post("/invites", {}, adminCookie)).json<{ token: string }>();
  const email = `person-${crypto.randomUUID()}@example.test`;
  const signup = await post("/auth/signup", { email, name: "Person", password: PASSWORD, invite: token });
  expect(signup.status).toBe(200);
  const cookie = cookieOf(signup);
  return { id: (await (await get("/me", cookie)).json<{ id: string }>()).id, email, cookie };
}

/** A second session of the same account, as a login from another browser makes one. */
async function anotherSession(who: Account): Promise<string> {
  const login = await post("/auth/login", { email: who.email, password: PASSWORD });
  expect(login.status).toBe(200);
  return cookieOf(login);
}

/** A board `owner` owns, in a workspace of their own, with `member` added. */
async function boardWith(owner: Account, member: Account): Promise<string> {
  const workspace = await post("/workspaces", { name: "Team" }, owner.cookie);
  expect(workspace.status).toBe(201);
  const { workspace: { id: workspaceId } } = await workspace.json<{ workspace: { id: string } }>();
  const board = await post("/boards", { name: "Board", key: `R${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId }, owner.cookie);
  expect(board.status).toBe(200);
  const { id } = await board.json<{ id: string }>();
  // Straight into D1: the add-member route runs an access change that answers 202 when the suite keeps the pool busy.
  await env.DB.prepare("INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'member')").bind(id, member.id).run();
  return id;
}

type Live = {
  closed: Promise<number>;
  frames: Array<Record<string, unknown>>;
  send: (message: unknown) => void;
  /** The socket's close code, or "open" if it is still open after `ms`. */
  closeCode: (ms?: number) => Promise<number | "open">;
};

function live(socket: WebSocket): Live {
  const frames: Live["frames"] = [];
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  socket.accept();
  return {
    closed,
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    closeCode: (ms = 5_000) => Promise.race([closed, scheduler.wait(ms).then(() => "open" as const)]),
  };
}

async function openBoard(cookie: string, boardId: string, forged: HeadersInit = {}): Promise<Live> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie, ...forged },
  });
  expect(response.status).toBe(101);
  return live(response.webSocket!);
}

async function openPresence(cookie: string, forged: HeadersInit = {}): Promise<Live> {
  const response = await SELF.fetch(`${ORIGIN}/presence/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie, ...forged },
  });
  expect(response.status).toBe(101);
  return live(response.webSocket!);
}

const presenceStub = () => env.PRESENCE_DO.get(env.PRESENCE_DO.idFromName("global"));
const revokeOnPresence = (body: unknown) =>
  presenceStub().fetch(`https://presence.internal${REVOKE_SESSIONS_PATH}`, { method: "POST", body: JSON.stringify(body) });

const mutation = (message: Record<string, unknown>) => ({ mutationId: crypto.randomUUID(), ...message });
const cardCreate = (id: string) => mutation({ type: "card.create", id, columnId: "col", title: "Card", position: "a0" });
const sawFrame = (socket: Live, id: string) => socket.frames.some((frame) => frame.id === id && frame.type === "card.create");

describe("signing out", () => {
  it("closes that session's board and presence sockets, and no other session's or account's", async () => {
    const owner = await account();
    const peer = await account();
    const boardId = await boardWith(owner, peer);
    const a = owner.cookie;
    const b = await anotherSession(owner);

    const boardA = await openBoard(a, boardId);
    const boardB = await openBoard(b, boardId);
    const boardPeer = await openBoard(peer.cookie, boardId);
    const presenceA = await openPresence(a);
    const presenceB = await openPresence(b);
    const presencePeer = await openPresence(peer.cookie);
    boardB.send(mutation({ type: "column.create", id: "col", title: "To do", position: "a0" }));
    await expect.poll(() => boardPeer.frames.some((frame) => frame.type === "column.create"), { timeout: 10_000 }).toBe(true);

    expect((await post("/auth/logout", {}, a)).status).toBe(200);

    expect(await boardA.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await presenceA.closeCode()).toBe(SESSION_REVOKED_CLOSE);

    // A frame sent on the closed socket is not applied: the send fails or the board drops it. The mutation sent on
    // the surviving session afterwards is, so the peer has seen everything the board accepted before it.
    const lost = crypto.randomUUID();
    const kept = crypto.randomUUID();
    try {
      boardA.send(cardCreate(lost));
    } catch {
      // A closed socket refuses the send.
    }
    boardB.send(cardCreate(kept));
    await expect.poll(() => sawFrame(boardPeer, kept), { timeout: 10_000 }).toBe(true);
    expect(sawFrame(boardPeer, lost)).toBe(false);

    // The signed-out cookie opens nothing new, and every other socket is still up.
    const retry = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, { headers: { Upgrade: "websocket", cookie: a } });
    expect(retry.status).toBe(401);
    for (const survivor of [boardB, boardPeer, presenceB, presencePeer]) expect(await survivor.closeCode(300)).toBe("open");
  });
});

describe("revokeRealtimeSessions", () => {
  /** The helper as a handler calls it, with an execution context that lets the test await what it scheduled. */
  async function revoke(userId: string, revocation: Parameters<typeof revokeRealtimeSessions>[3]) {
    const scheduled: Promise<unknown>[] = [];
    revokeRealtimeSessions(env, { waitUntil: (work) => void scheduled.push(work) }, userId, revocation);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
  }

  it("finds every board the user can open and closes every session's sockets but the excepted one", async () => {
    const owner = await account();
    const first = await boardWith(owner, await account());
    const second = await boardWith(owner, await account());
    const cookies = [owner.cookie, await anotherSession(owner)] as const;
    const sockets = await Promise.all(
      cookies.map(async (cookie) => ({ boards: [await openBoard(cookie, first), await openBoard(cookie, second)], presence: await openPresence(cookie) })),
    );

    await revoke(owner.id, { exceptSessionHash: await hashOf(cookies[1]) });

    expect(await sockets[0]!.boards[0]!.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await sockets[0]!.boards[1]!.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await sockets[0]!.presence.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    for (const survivor of [...sockets[1]!.boards, sockets[1]!.presence]) expect(await survivor.closeCode(300)).toBe("open");
  });

  it("reaches an instance Admin's sockets on boards they open only as an Operator", async () => {
    const owner = await account();
    const boardId = await boardWith(owner, await account());
    const email = `operator-${crypto.randomUUID()}@foxban.test`;
    const signup = await post("/auth/signup", { email, name: "Operator", password: PASSWORD });
    expect(signup.status).toBe(200);
    const operator = { id: (await (await get("/me", cookieOf(signup))).json<{ id: string }>()).id, email, cookie: cookieOf(signup) };
    const socket = await openBoard(operator.cookie, boardId);

    await revoke(operator.id, { sessionHashes: [await hashOf(operator.cookie)] });
    expect(await socket.closeCode()).toBe(SESSION_REVOKED_CLOSE);
  });

  it("does not throw when a board cannot be reached", async () => {
    const owner = await account();
    await boardWith(owner, await account());
    // A copy of the three bindings the helper reads: assigning onto `env` itself would break every later test.
    const broken = { DB: env.DB, PRESENCE_DO: env.PRESENCE_DO, ADMIN_EMAILS: env.ADMIN_EMAILS, BOARD_DO: { idFromName: () => { throw new Error("unreachable"); } } } as unknown as Env;
    const scheduled: Promise<unknown>[] = [];
    revokeRealtimeSessions(broken, { waitUntil: (work) => void scheduled.push(work) }, owner.id, { sessionHashes: ["a".repeat(64)] });
    await expect(Promise.all(scheduled)).resolves.toBeDefined();
  });
});

describe("revoking through the internal routes", () => {
  /** An account with three sessions (A, B, C), each holding a board and a presence socket, and a peer on the same board. */
  async function threeSessions() {
    const owner = await account();
    const peer = await account();
    const boardId = await boardWith(owner, peer);
    const cookies = [owner.cookie, await anotherSession(owner), await anotherSession(owner)] as const;
    const sockets = await Promise.all(cookies.map(async (cookie) => ({ board: await openBoard(cookie, boardId), presence: await openPresence(cookie) })));
    const bystander = { board: await openBoard(peer.cookie, boardId), presence: await openPresence(peer.cookie) };
    return { owner, boardId, cookies, sockets, bystander };
  }

  it("closes every other session of the user, board and presence, and keeps the excepted one and other accounts", async () => {
    const { owner, boardId, cookies, sockets, bystander } = await threeSessions();
    const except = await hashOf(cookies[1]);

    const body = { userId: owner.id, exceptSessionHash: except };
    expect(await boardClient(env, boardId).revokeSessions(body, 5_000)).toBe(true);
    const presence = await revokeOnPresence(body);
    expect(presence.status).toBe(200);
    expect(await presence.json()).toEqual({ closed: 2 });

    for (const index of [0, 2] as const) {
      expect(await sockets[index]!.board.closeCode()).toBe(SESSION_REVOKED_CLOSE);
      expect(await sockets[index]!.presence.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    }
    for (const survivor of [sockets[1]!.board, sockets[1]!.presence, bystander.board, bystander.presence]) {
      expect(await survivor.closeCode(300)).toBe("open");
    }
  });

  it("closes only the named sessions of the user", async () => {
    const { owner, boardId, cookies, sockets } = await threeSessions();
    const body = { userId: owner.id, sessionHashes: [await hashOf(cookies[0]), await hashOf(cookies[2])] };
    expect(await boardClient(env, boardId).revokeSessions(body, 5_000)).toBe(true);
    expect((await revokeOnPresence(body)).status).toBe(200);

    expect(await sockets[0]!.board.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await sockets[2]!.presence.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await sockets[1]!.board.closeCode(300)).toBe("open");
    expect(await sockets[1]!.presence.closeCode(300)).toBe("open");
  });

  it("closes a socket that holds no session hash on any revocation for its user", async () => {
    const owner = await account();
    const peer = await account();
    const boardId = await boardWith(owner, peer);
    // What a socket accepted before this change looks like: the DO is reached with no session-hash header.
    const boardUpgrade = await env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId)).fetch(`https://board.internal/boards/${boardId}/ws`, {
      headers: {
        Upgrade: "websocket",
        [INTERNAL_BOARD_ID_HEADER]: boardId,
        [INTERNAL_USER_ID_HEADER]: owner.id,
        [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: "true",
      },
    });
    expect(boardUpgrade.status).toBe(101);
    const legacyBoard = live(boardUpgrade.webSocket!);
    const presenceUpgrade = await presenceStub().fetch("https://presence.internal/presence/ws", {
      headers: { Upgrade: "websocket", [INTERNAL_USER_ID_HEADER]: owner.id },
    });
    expect(presenceUpgrade.status).toBe(101);
    const legacyPresence = live(presenceUpgrade.webSocket!);

    // Naming a session it was never tied to still closes it, since nothing says it is not that one.
    const body = { userId: owner.id, sessionHashes: ["0".repeat(64)] };
    expect(await boardClient(env, boardId).revokeSessions(body, 5_000)).toBe(true);
    expect((await revokeOnPresence(body)).status).toBe(200);
    expect(await legacyBoard.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await legacyPresence.closeCode()).toBe(SESSION_REVOKED_CLOSE);
  });

  it("still answers a board whose access is changing, and one that was deleted", async () => {
    const owner = await account();
    const boardId = await boardWith(owner, await account());
    const body = { userId: owner.id, sessionHashes: ["a".repeat(64)] };
    await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId)), (_instance, state) => {
      state.storage.sql.exec(`UPDATE board_access_state SET generation=generation+1,frozen=1,pending_operation_id='revocation-test' WHERE id=1`);
    });
    expect(await boardClient(env, boardId).revokeSessions(body, 5_000)).toBe(true);
    expect(await boardClient(env, boardId).deleteBoard(5_000)).toBe(true);
    expect(await boardClient(env, boardId).revokeSessions(body, 5_000)).toBe(true);
  });

  it("refuses a body that is not exactly one of the two selectors", async () => {
    const hash = "a".repeat(64);
    const userId = "someone";
    const bad: unknown[] = [
      { userId },
      { userId, sessionHashes: [hash], exceptSessionHash: hash },
      { userId, sessionHashes: [] },
      { userId, sessionHashes: ["not-a-hash"] },
      { userId, exceptSessionHash: "NOT-HEX" },
      { userId, exceptSessionHash: hash, extra: true },
      { exceptSessionHash: hash },
      "null",
    ];
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName("revocation-bad-body"));
    for (const body of bad) {
      const board = await stub.fetch(`https://board.internal${REVOKE_SESSIONS_PATH}`, {
        method: "POST",
        headers: { [INTERNAL_BOARD_ID_HEADER]: "revocation-bad-body" },
        body: JSON.stringify(body),
      });
      expect(board.status, JSON.stringify(body)).toBe(400);
      expect((await revokeOnPresence(body)).status, JSON.stringify(body)).toBe(400);
    }
    const wrongMethod = await stub.fetch(`https://board.internal${REVOKE_SESSIONS_PATH}`, { headers: { [INTERNAL_BOARD_ID_HEADER]: "revocation-bad-body" } });
    expect(wrongMethod.status).toBe(405);
  });

  it("is not reachable from the public routes", async () => {
    const owner = await account();
    for (const path of [REVOKE_SESSIONS_PATH, `/boards/x${REVOKE_SESSIONS_PATH}`]) {
      const response = await post(path, { userId: owner.id, sessionHashes: ["a".repeat(64)] }, owner.cookie);
      expect([404, 405]).toContain(response.status);
    }
  });
});

describe("headers a client sends on the upgrade", () => {
  it("never decide a socket's session or user: the Worker overwrites its internal headers", async () => {
    const victim = await account();
    const attacker = await account();
    const boardId = await boardWith(victim, attacker);
    const other = await anotherSession(attacker);
    const forged = {
      "x-foxban-session-hash": await hashOf(other),
      "x-foxban-user-id": victim.id,
      "x-foxban-is-admin": "true",
      "x-foxban-can-manage-columns": "true",
      "x-foxban-board-id": "somewhere-else",
    };
    const board = await openBoard(attacker.cookie, boardId, forged);
    const presence = await openPresence(attacker.cookie, forged);

    // Naming the forged session (and the forged user) closes nothing: the sockets belong to the attacker's own session.
    const wrong = { userId: victim.id, sessionHashes: [await hashOf(other), await hashOf(attacker.cookie)] };
    expect(await boardClient(env, boardId).revokeSessions(wrong, 5_000)).toBe(true);
    expect((await revokeOnPresence(wrong)).status).toBe(200);
    expect(await board.closeCode(300)).toBe("open");
    expect(await presence.closeCode(300)).toBe("open");

    // Naming the real session of the real user closes them, and the forged session's hash would not have.
    const right = { userId: attacker.id, sessionHashes: [await hashOf(attacker.cookie)] };
    expect(await boardClient(env, boardId).revokeSessions(right, 5_000)).toBe(true);
    expect((await revokeOnPresence(right)).status).toBe(200);
    expect(await board.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await presence.closeCode()).toBe(SESSION_REVOKED_CLOSE);
  });
});

describe("stripInternalHeaders", () => {
  it("drops every x-foxban-* header whatever its case, and nothing else", () => {
    const headers = new Headers({ cookie: "session=x", Upgrade: "websocket", "X-Foxban-Is-Admin": "true", "x-foxban-future-header": "1" });
    stripInternalHeaders(headers);
    expect([...headers.keys()].sort()).toEqual(["cookie", "upgrade"]);
  });
});

describe("an upgrade that outlives its session", () => {
  // The Worker re-reads the session row once the object has accepted a socket (`recheckSessionAfterUpgrade`). A
  // session deleted between `requireAuth` and the accept cannot be staged through `SELF.fetch`, so this drives the
  // recheck itself: the sockets are open, the row is deleted with no revocation sent (as if the sweep had already
  // passed this object), and `revokeIfSessionEnded` is what closes them.
  // The row id and the socket hash are the same value: the SHA-256 of the cookie value (ADR 0084).
  const sessionId = (cookie: string) => sha256Hex(cookie.slice(cookie.indexOf("=") + 1));
  const deleteRow = async (cookie: string) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sessionId(cookie)).run();

  it("closes the socket of a session whose row is gone, on the board and on presence, and only that session's", async () => {
    const owner = await account();
    const boardId = await boardWith(owner, await account());
    const a = owner.cookie;
    const b = await anotherSession(owner);
    const boardA = await openBoard(a, boardId);
    const boardB = await openBoard(b, boardId);
    const presenceA = await openPresence(a);
    const presenceB = await openPresence(b);

    await deleteRow(a);
    expect(await boardA.closeCode(300)).toBe("open");
    expect(await presenceA.closeCode(300)).toBe("open");

    await revokeIfSessionEnded(env, await sessionId(a), owner.id, boardId);
    await revokeIfSessionEnded(env, await sessionId(a), owner.id, null);
    expect(await boardA.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await presenceA.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    for (const survivor of [boardB, presenceB]) expect(await survivor.closeCode(300)).toBe("open");
  });

  it("closes nothing while the session row is live", async () => {
    const owner = await account();
    const boardId = await boardWith(owner, await account());
    const board = await openBoard(owner.cookie, boardId);
    const presence = await openPresence(owner.cookie);

    await revokeIfSessionEnded(env, await sessionId(owner.cookie), owner.id, boardId);
    await revokeIfSessionEnded(env, await sessionId(owner.cookie), owner.id, null);
    for (const socket of [board, presence]) expect(await socket.closeCode(300)).toBe("open");
  });

  it("treats an expired row as ended", async () => {
    const owner = await account();
    const boardId = await boardWith(owner, await account());
    const board = await openBoard(owner.cookie, boardId);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, await sessionId(owner.cookie)).run();

    await revokeIfSessionEnded(env, await sessionId(owner.cookie), owner.id, boardId);
    expect(await board.closeCode()).toBe(SESSION_REVOKED_CLOSE);
  });

  it("retries the revocation once when the object does not answer, then logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const flaky = { DB: env.DB, BOARD_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => (++calls === 1 ? new Response(null, { status: 503 }) : new Response("{}")) }) } } as unknown as Env;
    const owner = await account();
    await deleteRow(owner.cookie);
    await revokeIfSessionEnded(flaky, await sessionId(owner.cookie), owner.id, "some-board");
    expect(calls).toBe(2);
    expect(warn).not.toHaveBeenCalled();

    const down = { DB: env.DB, BOARD_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => ((calls += 1), new Response(null, { status: 503 })) }) } } as unknown as Env;
    calls = 0;
    await revokeIfSessionEnded(down, await sessionId(owner.cookie), owner.id, "some-board");
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("some-board"));
  });
});

describe("what the Durable Objects are given of the upgrade request", () => {
  it("upgradeHeaders drops the cookie, authorization and every x-foxban-* header, and keeps the handshake", () => {
    const request = new Request(`${ORIGIN}/boards/x/ws`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-key": "k",
        cookie: "session=the-bearer-secret",
        Authorization: "Bearer token",
        "X-Foxban-User-Id": "forged",
      },
    });
    const headers = upgradeHeaders(request);
    expect([...headers.keys()].sort()).toEqual(["sec-websocket-key", "upgrade"]);
    // The browser's own request is not changed.
    expect(request.headers.get("cookie")).toBe("session=the-bearer-secret");
  });

  it("boardClient.connect forwards no cookie, and sets the Worker's identity over the browser's", async () => {
    let seen: Request | undefined;
    const fake = { BOARD_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => ((seen = request), new Response("ok")) }) } } as unknown as Env;
    const browser = new Request(`${ORIGIN}/boards/b1/ws`, {
      headers: { upgrade: "websocket", cookie: "session=the-bearer-secret", authorization: "Bearer token", "x-foxban-user-id": "forged" },
    });
    await boardClient(fake, "b1").connect(browser, "real-user", true, "a".repeat(64));
    expect(seen!.headers.get("cookie")).toBeNull();
    expect(seen!.headers.get("authorization")).toBeNull();
    expect(seen!.headers.get("upgrade")).toBe("websocket");
    expect(seen!.headers.get(INTERNAL_USER_ID_HEADER)).toBe("real-user");
    expect(seen!.headers.get(INTERNAL_SESSION_HASH_HEADER)).toBe("a".repeat(64));
  });
});

describe("revoking across many boards", () => {
  /**
   * The helper's bindings, faked: a D1 that lists `boardIds` as the boards the user can open, and Durable Objects
   * that answer through `answer(id)` (id is null for the PresenceDO) after a short pause, counting every call and
   * the most that were in flight at once.
   */
  function fakeEnv(boardIds: string[], answer: (id: string | null, attempt: number) => boolean = () => true, readFailures = 0) {
    const calls = new Map<string | null, number>();
    /** Whether the presence object had been called when each board-list read began. */
    const presenceFirst: boolean[] = [];
    let reads = 0;
    const flight = { now: 0, max: 0, total: 0 };
    const respond = async (id: string | null) => {
      const attempt = (calls.get(id) ?? 0) + 1;
      calls.set(id, attempt);
      flight.total += 1;
      flight.max = Math.max(flight.max, ++flight.now);
      await scheduler.wait(5);
      flight.now -= 1;
      return new Response(null, { status: answer(id, attempt) ? 200 : 503 });
    };
    const statement = {
      first: async () => ({ email: "someone@example.test" }),
      all: async () => {
        presenceFirst.push(calls.has(null));
        if (reads++ < readFailures) throw new Error("D1 unavailable");
        return { results: boardIds.map((id) => ({ id })) };
      },
    };
    const fake = {
      DB: { prepare: () => ({ bind: () => statement }) },
      ADMIN_EMAILS: "",
      PRESENCE_DO: { idFromName: () => "global", get: () => ({ fetch: () => respond(null) }) },
      BOARD_DO: { idFromName: (name: string) => name, get: (id: string) => ({ fetch: () => respond(id) }) },
    } as unknown as Env;
    return { env: fake, calls, flight, presenceFirst };
  }

  async function run(fake: Env) {
    const scheduled: Promise<unknown>[] = [];
    revokeRealtimeSessions(fake, { waitUntil: (work) => void scheduled.push(work) }, "user-1", { sessionHashes: ["a".repeat(64)] });
    await Promise.all(scheduled);
  }

  const ids = (count: number) => Array.from({ length: count }, (_, index) => `b-${index}`);

  it("reaches every board and the presence object, 25 at a time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, calls, flight } = fakeEnv(ids(60));
    await run(fake);
    expect(calls.size).toBe(61);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
    expect(flight.max).toBe(25);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries an unanswered board once and logs the ids that still have no answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, calls } = fakeEnv(ids(40), (id, attempt) => id !== "b-3" && !(id === "b-7" && attempt === 1));
    await run(fake);
    expect(calls.get("b-3")).toBe(2);
    expect(calls.get("b-7")).toBe(2);
    expect(calls.get("b-8")).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("1 (b-3)");
    expect(line).not.toContain("b-7");
  });

  it("stops at the call cap, presence first, and logs the boards it did not reach", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, calls, flight } = fakeEnv(ids(600));
    await run(fake);
    expect(flight.total).toBe(500);
    expect(calls.has(null)).toBe(true);
    expect(calls.has("b-498")).toBe(true);
    expect(calls.has("b-499")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    // 101 boards (b-499 to b-599) were left; the line counts all of them and names the first 100.
    expect(line).toContain("101 (b-499, b-500");
    expect(line).toContain("b-598");
    expect(line).not.toContain("b-599");
  });

  it("asks the presence object even when the boards cannot be read, and says the board fan-out was skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, calls, presenceFirst } = fakeEnv(ids(5), () => true, Infinity);
    await run(fake);
    expect([...calls.keys()]).toEqual([null]);
    // Both reads (the one retry) saw presence already called: it does not wait for D1.
    expect(presenceFirst).toEqual([true, true]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("skipped the board fan-out for that user");
  });

  it("retries a failed board-list read once and then reaches the boards", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, calls } = fakeEnv(ids(3), () => true, 1);
    await run(fake);
    expect(calls.size).toBe(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops asking once the 25 s deadline passes and logs the boards it did not reach with the ones that failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The first board answer lands "26 s later": every batch after the first is past the deadline.
      const { env: fake, calls } = fakeEnv(ids(60), (id) => {
        if (id !== null) vi.setSystemTime(Date.now() + 26_000);
        return id !== "b-3";
      });
      await run(fake);
      expect(calls.has("b-24")).toBe(true);
      expect(calls.has("b-25")).toBe(false);
      expect(calls.get("b-3")).toBe(1);
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("no answer from 1 (b-3)");
      expect(lines[1]).toContain("did not reach 35 (b-25, b-26");
      expect(lines[1]).toContain("b-59");
      expect(lines[1]).toContain("25 s deadline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends the cap on first calls before any retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env: fake, flight } = fakeEnv(ids(600), () => false);
    await run(fake);
    expect(flight.total).toBe(500);
  });
});

describe("changing the password", () => {
  // Needs the POST /auth/password handler to call, after its successful batch:
  //   revokeRealtimeSessions(c.env, c.executionCtx, user.id, { exceptSessionHash: sessionHash });
  it("closes the account's other sessions' sockets and keeps the changing session's", async () => {
    const owner = await account();
    const peer = await account();
    const boardId = await boardWith(owner, peer);
    const a = owner.cookie;
    const b = await anotherSession(owner);
    const boardA = await openBoard(a, boardId);
    const boardB = await openBoard(b, boardId);
    const presenceA = await openPresence(a);
    const presenceB = await openPresence(b);
    const boardPeer = await openBoard(peer.cookie, boardId);

    const changed = await post("/auth/password", { currentPassword: PASSWORD, newPassword: "a different horse battery staple" }, b);
    expect(changed.status).toBe(200);

    expect(await boardA.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    expect(await presenceA.closeCode()).toBe(SESSION_REVOKED_CLOSE);
    for (const survivor of [boardB, presenceB, boardPeer]) expect(await survivor.closeCode(300)).toBe("open");
  });
});
