import {
  REALTIME_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ServerMessage,
} from "@foxban/shared";
import { SELF, applyD1Migrations, createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Auth and board membership driven through the real Worker: every request goes
 * in over HTTP with (or without) a session cookie, so what gets asserted is the
 * contract the browser and the curl suite see.
 *
 * D1 bindings in the test pool start empty, so the migrations are applied first.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
import worker, { reconcileAttachmentObjects } from "../src/index";
import { firstWorkspaceId } from "./first-workspace";
import { parseAvatarObjectKey } from "../src/attachment-lifecycle";
import { sha256Hex } from "../src/auth";
import { GitHubApiError, getBranch } from "../src/github";

const PASSWORD = "correct horse battery";
const ORIGIN = "https://foxban.test";

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response carried no Set-Cookie header");
  return header.split(";")[0]!;
}

function post(path: string, body: unknown, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

function del(path: string, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "DELETE",
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

/** Registers a fresh user and returns their session cookie. */
async function signup(email: string, name = "Test User"): Promise<string> {
  const response = await post("/auth/signup", { email, name, password: PASSWORD });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}
async function getUserId(cookie: string): Promise<string> {
  const res = await get("/me", cookie);
  expect(res.status).toBe(200);
  const body = await res.json<{ id: string }>();
  return body.id;
}

async function createBoard(cookie: string, name: string, key?: string): Promise<string> {
  const boardKey =
    key ??
    `B${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
      b.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 9)
      .toUpperCase()}`;
  const response = await post("/boards", { name, key: boardKey, workspaceId: await firstWorkspaceId(cookie) }, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ id: string; key: string }>()).id;
}
async function mintInvite(cookie: string): Promise<string> {
  const response = await post("/invites", {}, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

async function signupWithInvite(
  email: string,
  invite: string,
  name = "Test User",
): Promise<string> {
  const response = await post("/auth/signup", { email, name, password: PASSWORD, invite });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

describe("without a session", () => {
  it("rejects the authenticated routes", async () => {
    for (const path of ["/me", "/boards", "/boards/anything"]) {
      const response = await get(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    for (const path of ["/auth/email", "/auth/password"]) {
      const response = await post(path, {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a board socket before looking at the upgrade header", async () => {
    const response = await get("/boards/anything/ws", undefined, { Upgrade: "websocket" });
    expect(response.status).toBe(401);
  });
});

describe("signup and login", () => {
  it("creates the user, sets an http-only session cookie and identifies them", async () => {
    const response = await post("/auth/signup", {
      email: "  Signup@Foxban.test ",
      name: "Signup",
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    // Email is normalized before it ever reaches D1.
    expect(await response.json()).toMatchObject({ email: "signup@foxban.test", name: "Signup" });

    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^session=[0-9a-f]{64};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // ORIGIN is https, so the cookie must carry Secure (plain-http dev must not).
    expect(cookie).toContain("Secure");

    const me = await get("/me", sessionCookie(response));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "signup@foxban.test", name: "Signup" });
  });

  it("rejects short, weak, and predictable passwords, accepts non-patterned 8-char boundary, and rejects duplicate email", async () => {
    const short = await post("/auth/signup", {
      email: "short@foxban.test",
      name: "Short",
      password: "1234567",
    });
    expect(short.status).toBe(400);

    for (const weak of ["11111111", "abababab", "abcdefgh", "password1"]) {
      const res = await post("/auth/signup", {
        email: `weak-${weak}@foxban.test`,
        name: "Weak",
        password: weak,
      });
      expect(res.status).toBe(400);
    }

    // Object prototype names (constructor, __proto__, toString) are not falsely rejected
    let counter = 0;
    for (const validName of ["constructor", "__proto__9", "toString!"]) {
      counter++;
      const validRes = await post("/auth/signup", {
        email: `proto-user-${counter}@foxban.test`,
        name: "Proto User",
        password: validName,
      });
      expect(validRes.status).toBe(200);
    }

    const boundary = await post("/auth/signup", {
      email: "boundary8@foxban.test",
      name: "Boundary",
      password: "k9#m2$p1",
    });
    expect(boundary.status).toBe(200);

    await signup("dup@foxban.test");
    const again = await post("/auth/signup", {
      email: "dup@foxban.test",
      name: "Other",
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
  });

  it("logs in with the stored PBKDF2 hash and refuses anything else", async () => {
    await signup("login@foxban.test");

    const ok = await post("/auth/login", { email: "login@foxban.test", password: PASSWORD });
    expect(ok.status).toBe(200);
    const me = await get("/me", sessionCookie(ok));
    expect(await me.json()).toMatchObject({ email: "login@foxban.test" });

    const wrongPassword = await post("/auth/login", {
      email: "login@foxban.test",
      password: `${PASSWORD}!`,
    });
    expect(wrongPassword.status).toBe(401);

    const unknownUser = await post("/auth/login", {
      email: "nobody@foxban.test",
      password: PASSWORD,
    });
    expect(unknownUser.status).toBe(401);
    // Both failures look identical from the outside.
    expect(await unknownUser.json()).toEqual(await wrongPassword.json());
  });

  it("invalidates the session on logout", async () => {
    const cookie = await signup("logout@foxban.test");
    expect((await post("/auth/logout", {}, cookie)).status).toBe(200);
    expect((await get("/me", cookie)).status).toBe(401);
  });

  it("refuses a session whose expiry has passed", async () => {
    const cookie = await signup("expired@foxban.test");
    const sessionId = cookie.slice("session=".length);

    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, sessionId)
      .run();

    expect((await get("/me", cookie)).status).toBe(401);

    // Logging in again sweeps the dead row out of the table.
    const again = await post("/auth/login", { email: "expired@foxban.test", password: PASSWORD });
    expect(again.status).toBe(200);
    const stale = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    expect(stale).toBeNull();
  });
});

describe("boards and membership", () => {
  it("lists only the boards the caller belongs to", async () => {
    const admin = await signup("admin-mint@foxban.test");
    const ownerInvite = await mintInvite(admin);
    const owner = await signupWithInvite("owner@user.test", ownerInvite);
    const strangerInvite = await mintInvite(admin);
    const stranger = await signupWithInvite("stranger@user.test", strangerInvite);
    const boardId = await createBoard(owner, "Roadmap");

    const mine = await get("/boards", owner);
    expect(await mine.json()).toEqual([
      {
        id: boardId,
        name: "Roadmap",
        key: expect.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
        ownerId: expect.any(String),
        icon: "square-kanban",
        color: "amber",
        workspaceId: expect.stringMatching(/^personal_/),
        workspaceName: expect.stringMatching(/'s workspace$/),
        accessMode: "restricted",
        accessVersion: 0,
        capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
        viaWorkspaceAdmin: false,
      },
    ]);
    expect(await (await get("/boards", stranger)).json()).toEqual([]);
  });

  it("persists validated board icon and color through create, list, and update", async () => {
    const owner = await signup("appearance-owner@foxban.test");
    const created = await post(
      "/boards",
      { name: "Styled board", key: "STYLE1", icon: "fish", color: "blue", workspaceId: await firstWorkspaceId(owner) },
      owner,
    );
    expect(created.status).toBe(200);
    const board = await created.json<{
      id: string;
      name: string;
      key: string;
      icon: string;
      color: string;
    }>();
    expect(board).toMatchObject({ name: "Styled board", key: "STYLE1", icon: "fish", color: "blue", workspaceId: await firstWorkspaceId(owner) });

    const listed = await get("/boards", owner);
    const listedBoards = await listed.json<Array<{ id: string; icon: string; color: string }>>();
    expect(listedBoards.find((candidate) => candidate.id === board.id)).toMatchObject({
      id: board.id,
      icon: "fish",
      color: "blue",
    });

    const updated = await patch(
      `/boards/${board.id}`,
      { name: "Styled board", key: "STYLE1", icon: "star", color: "purple" },
      owner,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: board.id, icon: "star", color: "purple" });

    const stored = await env.DB.prepare("SELECT icon, color FROM boards WHERE id = ?")
      .bind(board.id)
      .first<{ icon: string; color: string }>();
    expect(stored).toEqual({ icon: "star", color: "purple" });

    expect(
      (
        await post(
          "/boards",
          { name: "Invalid icon", key: "BADICON", icon: "unknown", color: "blue", workspaceId: await firstWorkspaceId(owner) },
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await patch(
          `/boards/${board.id}`,
          { name: "Styled board", key: "STYLE1", icon: "star", color: "chartreuse" },
          owner,
        )
      ).status,
    ).toBe(400);
  });

  it("gates the board and its socket on membership, and opens both after an invite", async () => {
    const owner = await signup("host@foxban.test");
    const guestInvite = await mintInvite(owner);
    const guest = await signupWithInvite("guest@user.test", guestInvite);
    const boardId = await createBoard(owner, "Shared");

    const refused = await get(`/boards/${boardId}`, guest);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });
    expect((await get(`/boards/${boardId}/ws`, guest, { Upgrade: "websocket" })).status).toBe(403);

    const guestUserId = await getUserId(guest);
    const invite = await post(`/boards/${boardId}/members`, { userId: guestUserId }, guest);
    // A non-member cannot invite themselves in.
    expect(invite.status).toBe(403);

    expect(
      (await post(`/boards/${boardId}/members`, { userId: guestUserId }, owner)).status,
    ).toBe(200);
    // Re-inviting is a no-op rather than a duplicate-key failure.
    expect(
      (await post(`/boards/${boardId}/members`, { userId: guestUserId }, owner)).status,
    ).toBe(200);
    const allowed = await get(`/boards/${boardId}`, guest);
    expect(allowed.status).toBe(200);
    const socket = await get(
      `/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      guest,
      { Upgrade: "websocket" },
    );
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close();
  });

  it("safely removes a non-owner member, rejects unauthenticated/non-member callers, forbids removing owner, and is idempotent", async () => {
    const owner = await signup("removal-owner@foxban.test", "Removal Owner");
    const ownerId = await getUserId(owner);
    const boardId = await createBoard(owner, "Removal Board");

    const memberInvite = await mintInvite(owner);
    const member = await signupWithInvite("member-to-remove@user.test", memberInvite, "Member User");
    const memberId = await getUserId(member);

    const outsiderInvite = await mintInvite(owner);
    const outsider = await signupWithInvite("removal-outsider@user.test", outsiderInvite, "Outsider User");
    const outsiderId = await getUserId(outsider);

    // Add member to board
    const addRes = await post(`/boards/${boardId}/members`, { userId: memberId }, owner);
    expect(addRes.status).toBe(200);

    // Verify member has access to board REST route
    const memberBoardRes = await get(`/boards/${boardId}`, member);
    expect(memberBoardRes.status).toBe(200);

    // Member is NOT in candidates list before removal
    const candidatesBefore = await get(`/boards/${boardId}/membership-candidates`, owner);
    expect(candidatesBefore.status).toBe(200);
    const candsBeforeJson = await candidatesBefore.json<{ candidates: Array<{ id: string }> }>();
    expect(candsBeforeJson.candidates.some((c) => c.id === memberId)).toBe(false);

    // 1. Unauthenticated DELETE is rejected with 401
    const unauthDelete = await del(`/boards/${boardId}/members/${memberId}`);
    expect(unauthDelete.status).toBe(401);
    expect(await unauthDelete.json()).toEqual({ error: "unauthorized" });

    // 2. Non-member (outsider) DELETE is rejected with 403
    const outsiderDelete = await del(`/boards/${boardId}/members/${memberId}`, outsider);
    expect(outsiderDelete.status).toBe(403);
    expect(await outsiderDelete.json()).toEqual({ error: "forbidden" });

    // 3. Direct owner removal is forbidden with 403
    const ownerRemoveAttemptByOwner = await del(`/boards/${boardId}/members/${ownerId}`, owner);
    expect(ownerRemoveAttemptByOwner.status).toBe(403);
    expect(await ownerRemoveAttemptByOwner.json()).toEqual({ error: "board owner cannot be removed" });

    const ownerRemoveAttemptByMember = await del(`/boards/${boardId}/members/${ownerId}`, member);
    expect(ownerRemoveAttemptByMember.status).toBe(403);
    expect(await ownerRemoveAttemptByMember.json()).toEqual({ error: "board owner cannot be removed" });

    // 4. Direct self-removal by non-owner member returns distinct 403 and preserves membership
    const selfRemoveAttempt = await del(`/boards/${boardId}/members/${memberId}`, member);
    expect(selfRemoveAttempt.status).toBe(403);
    expect(await selfRemoveAttempt.json()).toEqual({ error: "cannot remove self from board" });

    // Verify member still has access to board REST route after attempted self-removal
    const postSelfRemoveAccess = await get(`/boards/${boardId}`, member);
    expect(postSelfRemoveAccess.status).toBe(200);

    // 5. Successful non-owner member removal
    const removeRes = await del(`/boards/${boardId}/members/${memberId}`, owner);
    expect(removeRes.status).toBe(200);
    expect(await removeRes.json()).toEqual({ ok: true });

    // 6. Idempotent missing-target success (subsequent call returns 200 { ok: true })
    const repeatRemoveRes = await del(`/boards/${boardId}/members/${memberId}`, owner);
    expect(repeatRemoveRes.status).toBe(200);
    expect(await repeatRemoveRes.json()).toEqual({ ok: true });

    const missingUserRemoveRes = await del(`/boards/${boardId}/members/${outsiderId}`, owner);
    expect(missingUserRemoveRes.status).toBe(200);
    expect(await missingUserRemoveRes.json()).toEqual({ ok: true });

    // 7. Removed member loses guarded REST access
    const postRemovalAccess = await get(`/boards/${boardId}`, member);
    expect(postRemovalAccess.status).toBe(403);
    expect(await postRemovalAccess.json()).toEqual({ error: "forbidden" });

    // Subsequent WS connection attempt is denied (without testing active socket closure)
    const postRemovalWs = await get(`/boards/${boardId}/ws`, member, { Upgrade: "websocket" });
    expect(postRemovalWs.status).toBe(403);

    // Removed member is omitted from board members list
    const membersListRes = await get(`/boards/${boardId}/members`, owner);
    expect(membersListRes.status).toBe(200);
    const membersJson = await membersListRes.json<{ members: Array<{ id: string }> }>();
    expect(membersJson.members.some((m) => m.id === memberId)).toBe(false);

    // 8. Removed member is not in the workspace's candidate list (they never were in the workspace), and an exact email finds them again
    const candidatesAfter = await get(`/boards/${boardId}/membership-candidates`, owner);
    expect(candidatesAfter.status).toBe(200);
    const candsAfterJson = await candidatesAfter.json<{ candidates: Array<{ id: string }> }>();
    expect(candsAfterJson.candidates.some((c) => c.id === memberId)).toBe(false);
    const lookup = await get(`/boards/${boardId}/membership-candidates?email=member-to-remove%40user.test`, owner);
    expect((await lookup.json<{ candidates: Array<{ id: string }> }>()).candidates.map((c) => c.id)).toEqual([memberId]);
  });
  it("normalizes board keys, rejects invalid keys, and rejects duplicate keys with 409", async () => {
    const owner = await signup("board-keys@foxban.test");

    // Lowercase and spaces trimmed and uppercased
    const res1 = await post("/boards", { name: "Game Board", key: "  game1  ", workspaceId: await firstWorkspaceId(owner) }, owner);
    expect(res1.status).toBe(200);
    const body1 = await res1.json<{ id: string; name: string; key: string; ownerId: string }>();
    expect(body1.key).toBe("GAME1");

    // Detail returns normalized key
    const detail = await get(`/boards/${body1.id}`, owner);
    expect(detail.status).toBe(200);
    expect((await detail.json<{ key: string }>()).key).toBe("GAME1");

    // List returns normalized key
    const list = await get("/boards", owner);
    expect(list.status).toBe(200);
    const boards = await list.json<Array<{ id: string; key: string }>>();
    const found = boards.find((b) => b.id === body1.id);
    expect(found?.key).toBe("GAME1");

    // Invalid format rejected (starts with digit, invalid chars, too short, too long)
    const invalidKeys = ["1GAME", "G", "GAME_1", "TOOLONGKEY123", "   "];
    for (const badKey of invalidKeys) {
      const badRes = await post("/boards", { name: "Invalid", key: badKey, workspaceId: await firstWorkspaceId(owner) }, owner);
      expect(badRes.status).toBe(400);
    }

    // Duplicate key (case-insensitive duplicate check)
    const dupRes = await post("/boards", { name: "Another Board", key: "game1", workspaceId: await firstWorkspaceId(owner) }, owner);
    expect(dupRes.status).toBe(409);
    expect(await dupRes.json()).toEqual({ error: "board key already exists" });

    // Assert duplicate did not insert a board or board_members row
    const dupBoard = await env.DB.prepare("SELECT COUNT(*) AS count FROM boards WHERE name = 'Another Board'").first<{ count: number }>();
    expect(dupBoard?.count).toBe(0);
    const dupMembers = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM board_members WHERE board_id NOT IN (SELECT id FROM boards)",
    ).first<{ count: number }>();
    expect(dupMembers?.count).toBe(0);
  });

  it("allows an admin outside board_members to list, view, modify, and connect to a board, while denying a non-member", async () => {
    const ownerResponse = await post("/auth/signup", {
      email: "board-owner@foxban.test",
      name: "Board Owner",
      password: PASSWORD,
    });
    expect(ownerResponse.status).toBe(200);
    const owner = sessionCookie(ownerResponse);
    const ownerId = (await ownerResponse.json<{ id: string }>()).id;

    const firstBoardId = await createBoard(owner, "First Admin Target");
    const secondBoardId = await createBoard(owner, "Second Admin Target");

    // Set deterministic created_at fixture values so ordering is reliable.
    await env.DB.prepare("UPDATE boards SET created_at = ? WHERE id = ?")
      .bind(1_700_000_000_000, firstBoardId)
      .run();
    await env.DB.prepare("UPDATE boards SET created_at = ? WHERE id = ?")
      .bind(1_700_000_001_000, secondBoardId)
      .run();

    const admin = await signup("other-admin@foxban.test", "Other Admin");
    const invite = await mintInvite(owner);
    const nonMember = await signupWithInvite("nonmember@user.test", invite, "Non Member");

    // The admin is not in board_members, so the default list leaves these boards out...
    const defaultAdminBoards = await (await get("/boards", admin)).json<{ id: string }[]>();
    expect(defaultAdminBoards.map((b) => b.id)).not.toContain(firstBoardId);
    expect(defaultAdminBoards.map((b) => b.id)).not.toContain(secondBoardId);
    // ...but reading the workspace they operate lists all its boards ordered by created_at.
    // Assert filtered admin results are exact ordered {id, name, ownerId} objects (duplicates/extra fields fail).
    const adminBoardsResponse = await get(`/boards?workspaceId=personal_${ownerId}`, admin);
    expect(adminBoardsResponse.status).toBe(200);
    const adminBoards = await adminBoardsResponse.json<{ id: string; name: string; key: string; ownerId: string }[]>();
    const filteredAdminBoards = adminBoards.filter(
      (b) => b.id === firstBoardId || b.id === secondBoardId,
    );
    expect(filteredAdminBoards).toEqual([
      {
        id: firstBoardId,
        name: "First Admin Target",
        key: expect.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
        ownerId,
        icon: "square-kanban",
        color: "amber",
        workspaceId: `personal_${ownerId}`,
        workspaceName: expect.stringMatching(/'s workspace$/),
        accessMode: "restricted",
        accessVersion: 0,
        capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
        viaWorkspaceAdmin: false,
      },
      {
        id: secondBoardId,
        name: "Second Admin Target",
        key: expect.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
        ownerId,
        icon: "square-kanban",
        color: "amber",
        workspaceId: `personal_${ownerId}`,
        workspaceName: expect.stringMatching(/'s workspace$/),
        accessMode: "restricted",
        accessVersion: 0,
        capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
        viaWorkspaceAdmin: false,
      },
    ]);

    // Admin can GET the board directly.
    const adminBoard = await get(`/boards/${firstBoardId}`, admin);
    expect(adminBoard.status).toBe(200);
    expect(await adminBoard.json()).toEqual({
      id: firstBoardId,
      name: "First Admin Target",
      key: expect.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
      ownerId,
      icon: "square-kanban",
      color: "amber",
      workspaceId: `personal_${ownerId}`,
      workspaceName: expect.stringMatching(/'s workspace$/),
      accessMode: "restricted",
      accessVersion: 0,
      capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
      viaWorkspaceAdmin: false,
    });

    // Admin GET of a missing board returns 403.
    const missingBoard = await get(`/boards/${crypto.randomUUID()}`, admin);
    expect(missingBoard.status).toBe(403);
    expect(await missingBoard.json()).toEqual({ error: "forbidden" });

    // Prove admin GET members succeeds on another owner's board without membership.
    const membersBefore = await get(`/boards/${firstBoardId}/members`, admin);
    expect(membersBefore.status).toBe(200);
    expect(await membersBefore.json()).toEqual({
      members: [
        { id: ownerId, email: "board-owner@foxban.test", name: "Board Owner", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: true },
      ],
    });

    // Prove admin POST add-member succeeds on another owner's board.
    const memberToAddInvite = await mintInvite(admin);
    const addedCookie = await signupWithInvite("added-by-admin@user.test", memberToAddInvite, "Added By Admin");
    const addedUserId = await getUserId(addedCookie);
    const addMemberResponse = await post(
      `/boards/${firstBoardId}/members`,
      { userId: addedUserId },
      admin,
    );
    expect(addMemberResponse.status).toBe(200);
    expect(await addMemberResponse.json()).toEqual({ ok: true });

    const membersAfter = await get(`/boards/${firstBoardId}/members`, admin);
    expect(membersAfter.status).toBe(200);
    expect(await membersAfter.json()).toEqual({
      members: [
        { id: expect.any(String), email: "added-by-admin@user.test", name: "Added By Admin", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: false },
        { id: ownerId, email: "board-owner@foxban.test", name: "Board Owner", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: true },
      ],
    });

    // Open the admin WebSocket and send one valid mutation, asserting its echo.
    const adminSocketResponse = await get(
      `/boards/${firstBoardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      admin,
      { Upgrade: "websocket" },
    );
    expect(adminSocketResponse.status).toBe(101);
    const adminSocket = adminSocketResponse.webSocket;
    if (!adminSocket) throw new Error("the Worker did not return a WebSocket");
    const frames: ServerMessage[] = [];
    adminSocket.addEventListener("message", (event: MessageEvent) => {
      frames.push(ServerMessageSchema.parse(JSON.parse(event.data as string)));
    });
    adminSocket.accept();
    await expect.poll(() => frames[0]?.type).toBe("snapshot");

    adminSocket.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "admin-col-mutation",
        id: "col-admin-1",
        title: "Admin Column",
        position: "a0",
      }),
    );
    await expect
      .poll(() =>
        frames.some(
          (frame) =>
            frame.type === "column.create" &&
            frame.mutationId === "admin-col-mutation" &&
            frame.id === "col-admin-1" &&
            frame.title === "Admin Column",
        ),
      )
      .toBe(true);
    adminSocket.close(1000, "test finished");

    // A separately invited non-admin non-member still sees an empty board list.
    const nonMemberBoards = await get("/boards", nonMember);
    expect(nonMemberBoards.status).toBe(200);
    expect(await nonMemberBoards.json()).toEqual([]);

    // The non-member gets 403 for both the board and its socket.
    const nonMemberBoard = await get(`/boards/${firstBoardId}`, nonMember);
    expect(nonMemberBoard.status).toBe(403);
    expect(await nonMemberBoard.json()).toEqual({ error: "forbidden" });

    const nonMemberSocket = await get(`/boards/${firstBoardId}/ws`, nonMember, {
      Upgrade: "websocket",
    });
    expect(nonMemberSocket.status).toBe(403);
  });

  it("still answers 426 for a member who is not upgrading when version matches", async () => {
    const owner = await signup("plain@foxban.test");
    const boardId = await createBoard(owner, "Plain");
    expect(
      (
        await get(
          `/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
          owner,
        )
      ).status,
    ).toBe(426);
  });

  it("rejects board ws with 409 when realtimeVersion is missing or mismatched after auth and membership", async () => {
    const owner = await signup("version-gate@foxban.test");
    const boardId = await createBoard(owner, "Version Gate");

    // Missing realtimeVersion query param
    const missingRes = await get(`/boards/${boardId}/ws`, owner, { Upgrade: "websocket" });
    expect(missingRes.status).toBe(409);
    expect(await missingRes.json()).toEqual({ error: "realtime client update required" });

    // Mismatched realtimeVersion query param
    const wrongRes = await get(`/boards/${boardId}/ws?realtimeVersion=999`, owner, {
      Upgrade: "websocket",
    });
    expect(wrongRes.status).toBe(409);
    expect(await wrongRes.json()).toEqual({ error: "realtime client update required" });

    // And the immediately previous protocol version: version 6 added fields a
    // strictly parsing older client cannot consume safely.
    const previousVersionRes = await get(`/boards/${boardId}/ws?realtimeVersion=5`, owner, {
      Upgrade: "websocket",
    });
    expect(previousVersionRes.status).toBe(409);
    expect(await previousVersionRes.json()).toEqual({ error: "realtime client update required" });

    // Version 10 removed `subtask.complete` and the workflow migration field, so a
    // version 9 client that still sends them must reload.
    const version9Res = await get(`/boards/${boardId}/ws?realtimeVersion=9`, owner, {
      Upgrade: "websocket",
    });
    expect(version9Res.status).toBe(409);
    expect(await version9Res.json()).toEqual({ error: "realtime client update required" });

    // Version 12 added the `positions.rebalanced` frame, which a version 11 client cannot parse (ADR 0076).
    const version11Res = await get(`/boards/${boardId}/ws?realtimeVersion=11`, owner, {
      Upgrade: "websocket",
    });
    expect(version11Res.status).toBe(409);
    expect(await version11Res.json()).toEqual({ error: "realtime client update required" });

    // Version 13 dropped `comments` from the snapshot, which a version 12 client still expects (ADR 0078).
    const version12Res = await get(`/boards/${boardId}/ws?realtimeVersion=12`, owner, {
      Upgrade: "websocket",
    });
    expect(version12Res.status).toBe(409);
    expect(await version12Res.json()).toEqual({ error: "realtime client update required" });

    // Precedence: unauthenticated caller gets 401 even with wrong or missing version
    const unauthWrong = await get(`/boards/${boardId}/ws?realtimeVersion=999`, undefined, {
      Upgrade: "websocket",
    });
    expect(unauthWrong.status).toBe(401);

    // Precedence: non-member gets 403 even with wrong or missing version
    const guestInvite = await mintInvite(owner);
    const nonMember = await signupWithInvite("non-member-version@user.test", guestInvite);
    const nonMemberWrong = await get(`/boards/${boardId}/ws?realtimeVersion=999`, nonMember, {
      Upgrade: "websocket",
    });
    expect(nonMemberWrong.status).toBe(403);
  });

  it("attributes card activity to the authenticated user, not a spoofed header, and serves it per card to members only", async () => {
    const signupResponse = await post("/auth/signup", {
      email: "socket-actor@foxban.test",
      name: "Socket Actor",
      password: PASSWORD,
    });
    expect(signupResponse.status).toBe(200);
    const cookie = sessionCookie(signupResponse);
    const userId = (await signupResponse.json<{ id: string }>()).id;
    const boardId = await createBoard(cookie, "Actor attribution");

    const response = await get(
      `/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      cookie,
      {
        Upgrade: "websocket",
        "x-foxban-user-id": "spoofed-user",
      },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("the Worker did not return a WebSocket");
    const frames: ServerMessage[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      frames.push(ServerMessageSchema.parse(JSON.parse(event.data as string)));
    });
    socket.accept();
    await expect.poll(() => frames[0]?.type).toBe("snapshot");

    socket.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "actor-column",
        id: "column-1",
        title: "Todo",
        position: "a0",
      }),
    );
    await expect
      .poll(() => frames.some((frame) => frame.type === "column.create"))
      .toBe(true);
    socket.send(
      JSON.stringify({
        type: "card.create",
        mutationId: "actor-card",
        id: "card-1",
        columnId: "column-1",
        title: "Audit me",
        position: "a0",
      }),
    );
    await expect
      .poll(() =>
        frames.some(
          (frame) => frame.type === "activity.recorded" && frame.mutationId === "actor-card",
        ),
      )
      .toBe(true);
    const activity = frames.find(
      (frame) => frame.type === "activity.recorded" && frame.mutationId === "actor-card",
    );
    expect(activity).toMatchObject({
      type: "activity.recorded",
      activities: [
        {
          cardId: "card-1",
          actorId: userId,
          detail: { type: "card.created" },
        },
      ],
    });

    socket.send(
      JSON.stringify({
        type: "comment.create",
        mutationId: "actor-comment",
        id: "comment-1",
        cardId: "card-1",
        authorId: userId,
        parentCommentId: null,
        body: "Noted",
        createdAt: Date.now(),
      }),
    );
    await expect.poll(() => frames.some((frame) => frame.type === "comment.create")).toBe(true);

    // The snapshot carries no history (ADR 0073) and no comments (ADR 0078): a card's own reads do, for members only.
    const history = await get(`/boards/${boardId}/cards/card-1/activity`, cookie);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ activities: [{ cardId: "card-1", actorId: userId, detail: { type: "card.created" } }] });
    const comments = await get(`/boards/${boardId}/cards/card-1/comments`, cookie);
    expect(comments.status).toBe(200);
    expect(await comments.json()).toMatchObject({ comments: [{ id: "comment-1", cardId: "card-1", authorId: userId, body: "Noted", deleted: false }] });
    const reconnected = await get(`/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, cookie, { Upgrade: "websocket" });
    const snapshot = await new Promise<Record<string, unknown>>((resolve) => {
      reconnected.webSocket!.addEventListener("message", (event: MessageEvent) => resolve(JSON.parse(event.data as string)), { once: true });
      reconnected.webSocket!.accept();
    });
    expect(snapshot).toMatchObject({ type: "snapshot", cards: [{ id: "card-1" }] });
    expect(snapshot).not.toHaveProperty("activities");
    expect(snapshot).not.toHaveProperty("comments");
    expect(snapshot).toMatchObject({ commentCounts: { "card-1": 1 } });
    reconnected.webSocket!.close(1000, "test finished");
    const stranger = await signupWithInvite("activity-stranger@user.test", await mintInvite(cookie));
    expect((await get(`/boards/${boardId}/cards/card-1/activity`, stranger)).status).toBe(403);
    expect((await get(`/boards/${boardId}/cards/card-1/activity`)).status).toBe(401);
    expect((await get(`/boards/${boardId}/cards/card-1/comments`, stranger)).status).toBe(403);
    expect((await get(`/boards/${boardId}/cards/card-1/comments`)).status).toBe(401);
    socket.close(1000, "test finished");
  });

  it("404s an invite for a userId nobody registered", async () => {
    const owner = await signup("inviter@foxban.test");
    const boardId = await createBoard(owner, "Invites");
    const response = await post(
      `/boards/${boardId}/members`,
      { userId: crypto.randomUUID() },
      owner,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user not found" });
  });

  it("lists the board's members by name, to members only", async () => {
    const owner = await signup("zoe@foxban.test", "Zoe");
    const guestInvite = await mintInvite(owner);
    const guest = await signupWithInvite("adam@user.test", guestInvite, "Adam");
    const strangerInvite = await mintInvite(owner);
    const stranger = await signupWithInvite("nobody@user.test", strangerInvite, "Nobody");
    const boardId = await createBoard(owner, "Members");

    expect((await get(`/boards/${boardId}/members`, stranger)).status).toBe(403);
    expect((await get(`/boards/${boardId}/members`)).status).toBe(401);

    const adamId = await getUserId(guest);
    await post(`/boards/${boardId}/members`, { userId: adamId }, owner);

    const response = await get(`/boards/${boardId}/members`, guest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: [
        { id: expect.any(String), email: "adam@user.test", name: "Adam", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: false },
        { id: expect.any(String), email: "zoe@foxban.test", name: "Zoe", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: true },
      ],
    });
  });

  it("returns membership candidates excluding members, sorted by name then email, guarded by requireAuth and requireMember", async () => {
    const owner = await signup("owner-cand@foxban.test", "Owner Cand");
    const invite1 = await mintInvite(owner);
    const alice = await signupWithInvite("alice@user.test", invite1, "Alice Candidate");
    const invite2 = await mintInvite(owner);
    await signupWithInvite("bob.z@user.test", invite2, "Bob SameName");
    const invite3 = await mintInvite(owner);
    await signupWithInvite("bob.a@user.test", invite3, "Bob SameName");
    const invite4 = await mintInvite(owner);
    const stranger = await signupWithInvite("stranger-cand@user.test", invite4, "Stranger Cand");

    const boardId = await createBoard(owner, "Candidate Filtering Board");
    // The list is the board's workspace: these three are in it, the stranger is not (ADR 0072).
    const workspaceId = await firstWorkspaceId(owner);
    await env.DB.prepare(
      `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
       SELECT ?,id,'member',0,0 FROM users WHERE email IN ('alice@user.test','bob.z@user.test','bob.a@user.test')`,
    ).bind(workspaceId).run();

    // 1. Unauthenticated request rejected with 401
    const unauthRes = await get(`/boards/${boardId}/membership-candidates`);
    expect(unauthRes.status).toBe(401);
    expect(await unauthRes.json()).toEqual({ error: "unauthorized" });

    // 2. Non-member request rejected with 403
    const strangerRes = await get(`/boards/${boardId}/membership-candidates`, stranger);
    expect(strangerRes.status).toBe(403);
    expect(await strangerRes.json()).toEqual({ error: "forbidden" });

    // 3. Member / owner receives candidates excluding board owner
    const initialRes = await get(`/boards/${boardId}/membership-candidates`, owner);
    expect(initialRes.status).toBe(200);
    const initialBody = await initialRes.json<{ candidates: Array<{ id: string; email: string; name: string; githubLogin: string | null }> }>();

    // Owner must NOT be among candidates
    const ownerId = await getUserId(owner);
    expect(initialBody.candidates.some((c) => c.id === ownerId)).toBe(false);

    // Candidate objects expose ONLY public identity fields { id, email, name, githubLogin }
    for (const candidate of initialBody.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["avatarVersion", "email", "githubLogin", "id", "name"]);
      expect(typeof candidate.id).toBe("string");
      expect(typeof candidate.email).toBe("string");
      expect(typeof candidate.name).toBe("string");
    }

    // Find our specific test users in the candidates list and verify deterministic sorting (name ASC, email ASC)
    // Only the workspace's people are listed: no other account, whoever else is registered.
    expect(initialBody.candidates.map((c) => ({ name: c.name, email: c.email }))).toEqual([
      { name: "Alice Candidate", email: "alice@user.test" },
      { name: "Bob SameName", email: "bob.a@user.test" },
      { name: "Bob SameName", email: "bob.z@user.test" },
    ]);

    // 4. Adding a user by userId removes them from candidates and grants board access
    const aliceId = await getUserId(alice);
    // Alice cannot view board before addition
    expect((await get(`/boards/${boardId}`, alice)).status).toBe(403);

    const addAliceRes = await post(`/boards/${boardId}/members`, { userId: aliceId }, owner);
    expect(addAliceRes.status).toBe(200);
    expect(await addAliceRes.json()).toEqual({ ok: true });

    // Alice now has board access
    const aliceBoardRes = await get(`/boards/${boardId}`, alice);
    expect(aliceBoardRes.status).toBe(200);
    expect(await aliceBoardRes.json()).toMatchObject({ id: boardId });

    // Alice is now absent from membership candidates
    const afterAddRes = await get(`/boards/${boardId}/membership-candidates`, owner);
    expect(afterAddRes.status).toBe(200);
    const afterAddBody = await afterAddRes.json<{ candidates: Array<{ id: string }> }>();
    expect(afterAddBody.candidates.some((c) => c.id === aliceId)).toBe(false);
  });

  it("finds a person outside the workspace only by their exact email, and never lists them", async () => {
    const owner = await signup("owner-lookup@foxban.test", "Owner Lookup");
    const outsider = await signupWithInvite("outsider-lookup@user.test", await mintInvite(owner), "Outsider Lookup");
    const outsiderId = await getUserId(outsider);
    const boardId = await createBoard(owner, "Lookup Board");
    const candidates = async (query: string, who = owner) => {
      const response = await get(`/boards/${boardId}/membership-candidates${query}`, who);
      expect(response.status).toBe(200);
      return (await response.json<{ candidates: Array<{ id: string; email: string }> }>()).candidates;
    };

    // Not in the list, though they are registered.
    expect((await candidates("")).map((c) => c.email)).not.toContain("outsider-lookup@user.test");

    // The exact address finds exactly that account, whatever its case or padding, with the public identity fields only.
    for (const typed of ["outsider-lookup@user.test", "Outsider-Lookup@User.Test", " outsider-lookup@user.test "]) {
      const found = await candidates(`?email=${encodeURIComponent(typed)}`);
      expect(found).toEqual([{ id: outsiderId, email: "outsider-lookup@user.test", name: "Outsider Lookup", githubLogin: null, avatarVersion: null }]);
    }

    // A partial address, a bare domain, a wildcard and an unknown address find nothing.
    for (const typed of ["outsider-lookup", "outsider-lookup@", "@user.test", "outsider-lookup@user", "%@user.test", "*@user.test", "nobody-at-all@user.test", ""]) {
      expect(await candidates(`?email=${encodeURIComponent(typed)}`), typed).toEqual([]);
    }

    // Who holds a grant already is not offered again, and the lookup is as guarded as the list.
    expect((await post(`/boards/${boardId}/members`, { userId: outsiderId }, owner)).status).toBe(200);
    expect(await candidates("?email=outsider-lookup%40user.test")).toEqual([]);
    expect((await get(`/boards/${boardId}/membership-candidates?email=owner-lookup%40foxban.test`)).status).toBe(401);
    const stranger = await signupWithInvite("lookup-stranger@user.test", await mintInvite(owner), "Lookup Stranger");
    expect((await get(`/boards/${boardId}/membership-candidates?email=owner-lookup%40foxban.test`, stranger)).status).toBe(403);
  });
});

/** The instance GitHub App as GitHub's manifest conversion returns it (ADR 0064). */
const GITHUB_APP = {
  id: 424242,
  slug: "foxban-test",
  client_id: "Iv1.fakeclientid",
  client_secret: "fake-client-secret-4b8e",
  webhook_secret: "fake-webhook-secret-9c1d",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n",
};

/**
 * GitHub at github.example / api.github.example. A test adds to `accounts`: an OAuth
 * `code` mapped to what `GET /user` answers for the person who approved it; any other
 * code is refused the way GitHub does (200 with `error`). The token exchange only
 * succeeds for the App's own client id and secret. `emails` is the same for
 * `GET /user/emails`; a code with no entry gets what an App without the "Email addresses:
 * read" permission gets (403). Other requests pass through.
 */
function fakeGitHub() {
  const accounts: Record<string, unknown> = {};
  const emails: Record<string, unknown> = {};
  const original = globalThis.fetch;
  const tokenRequests: Array<Record<string, string>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://api.github.example" && url.pathname === "/app-manifests/good-code/conversions") {
      return Response.json(GITHUB_APP, { status: 201 });
    }
    if (url.origin === "https://github.example" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      tokenRequests.push(body);
      const approved =
        body.client_id === GITHUB_APP.client_id &&
        body.client_secret === GITHUB_APP.client_secret &&
        Object.hasOwn(accounts, body.code ?? "");
      return Response.json(approved ? { access_token: `ghu_${body.code}`, token_type: "bearer" } : { error: "bad_verification_code" });
    }
    if (url.origin === "https://api.github.example" && url.pathname === "/user") {
      const code = new Headers(init?.headers).get("authorization")?.replace("Bearer ghu_", "") ?? "";
      return Object.hasOwn(accounts, code) ? Response.json(accounts[code]) : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (url.origin === "https://api.github.example" && url.pathname === "/user/emails") {
      const code = new Headers(init?.headers).get("authorization")?.replace("Bearer ghu_", "") ?? "";
      return Object.hasOwn(emails, code) ? Response.json(emails[code]) : Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    return original(input, init);
  }) as typeof fetch;
  return { accounts, emails, tokenRequests, restore: () => void (globalThis.fetch = original) };
}

/** An Admin presses "Create GitHub App" (needs `fakeGitHub` active): the instance now has the App whose client id and secret Profile linking uses. */
async function createGitHubApp(admin: string): Promise<void> {
  const start = await (await post("/github-app/manifest", {}, admin)).json<{ url: string }>();
  const state = new URL(start.url).searchParams.get("state")!;
  const done = await SELF.fetch(`${ORIGIN}/auth/github-app/manifest/callback?code=good-code&state=${state}`, {
    headers: { cookie: `${admin}; github_app_manifest_state=${state}` },
    redirect: "manual",
  });
  expect(done.headers.get("location")).toContain("githubApp=created");
}

/** What "Connect GitHub" calls (ADR 0081): the current password, if the account has one, in exchange for the GitHub URL. */
function startGitHubLink(cookie: string, password?: string, extra?: HeadersInit): Promise<Response> {
  return post("/auth/github/link", password === undefined ? {} : { currentPassword: password }, cookie, extra);
}

/** The state of the GitHub URL `POST /auth/github/link` answered. */
async function linkState(start: Response): Promise<string> {
  return new URL((await start.json<{ url: string }>()).url).searchParams.get("state")!;
}

/** The callback GitHub sends the browser back to, carrying `state` in both the query and the cookie. */
function githubLinkCallback(cookie: string, code: string, state: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/auth/github/callback?code=${code}&state=${state}`, {
    headers: { cookie: `${cookie}; github_oauth_state=${state}` },
    redirect: "manual",
  });
}

/** The browser round trip for "Connect GitHub": GitHub approves `code` and sends the browser back. Returns where the callback redirected. */
async function connectGitHub(cookie: string, code: string, password: string | undefined = PASSWORD): Promise<string> {
  const start = await startGitHubLink(cookie, password);
  expect(start.status).toBe(200);
  const callback = await githubLinkCallback(cookie, code, await linkState(start));
  expect(callback.status).toBe(302);
  return callback.headers.get("location")!;
}

/**
 * What "Set a password" does first for an account with none (ADR 0081): the same round trip as a link, to the same callback,
 * where GitHub approves `code`. Returns where the callback redirected.
 */
async function reauthWithGitHub(cookie: string, code: string): Promise<string> {
  const start = await post("/auth/github/reauth", {}, cookie);
  expect(start.status).toBe(200);
  const callback = await githubLinkCallback(cookie, code, await linkState(start));
  expect(callback.status).toBe(302);
  return callback.headers.get("location")!;
}

/** The GitHub confirmation (`github_reauth_until`) the session `cookie` holds, or null. */
async function storedReauth(cookie: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT github_reauth_until AS until FROM sessions WHERE id = ?")
    .bind(cookie.slice("session=".length))
    .first<{ until: number | null }>();
  return row!.until;
}

/** The stored link state of the session `cookie` holds. */
async function storedLinkState(cookie: string): Promise<{ hash: string | null; expiresAt: number | null } | null> {
  return env.DB.prepare("SELECT github_link_state_hash AS hash, github_link_expires_at AS expiresAt FROM sessions WHERE id = ?")
    .bind(cookie.slice("session=".length))
    .first();
}

describe("profile", () => {
  let github: ReturnType<typeof fakeGitHub>;
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_app");
    // The pool shares D1 across the file, and every test here reuses the same GitHub ids.
    await env.DB.exec("UPDATE users SET github_login = NULL, github_user_id = NULL");
    github = fakeGitHub();
  });
  afterEach(() => github.restore());

  it("is off until an Admin has created the instance GitHub App", async () => {
    const cookie = await signup("gh-noapp@foxban.test", "Gh No App");
    const response = await startGitHubLink(cookie, PASSWORD);
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await storedLinkState(cookie)).toEqual({ hash: null, expiresAt: null });
  });

  it("starts the link with the instance App's client id and a state bound to the response cookie and the session", async () => {
    const cookie = await signup("gh-start@foxban.test", "Gh Start");
    await createGitHubApp(cookie);

    const response = await startGitHubLink(cookie, PASSWORD);
    expect(response.status).toBe(200);

    const location = new URL((await response.json<{ url: string }>()).url);
    expect(location.origin).toBe("https://github.example");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(GITHUB_APP.client_id);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/github/callback",
    );
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();

    // The state travels in an httpOnly cookie too: that pairing is the CSRF check.
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie.startsWith("github_oauth_state=")).toBe(true);
    expect(setCookie.split(";")[0]!.slice("github_oauth_state=".length)).toBe(state);

    // And the server keeps only its hash, with an expiry ten minutes out, against this session.
    const stored = (await storedLinkState(cookie))!;
    expect(stored.hash).toBe(await sha256Hex(state!));
    expect(stored.hash).not.toBe(state);
    expect(stored.expiresAt!).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(stored.expiresAt!).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

    expect((await post("/auth/github/link", {})).status).toBe(401);
    // Nothing starts a link by navigation any more.
    expect((await SELF.fetch(`${ORIGIN}/auth/github/start`, { headers: { cookie }, redirect: "manual" })).status).not.toBe(302);
  });

  it("falls back to the request origin when APP_ORIGIN and MCP_API_ORIGIN are unset", async () => {
    const cookie = await signup("gh-noorigin@foxban.test", "Gh No Origin");
    const bare = { ...env, APP_ORIGIN: "", MCP_API_ORIGIN: undefined } as unknown as typeof env;
    await createGitHubApp(cookie);

    const start = await worker.fetch!(
      new Request(`${ORIGIN}/auth/github/link`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD }) }),
      bare,
      createExecutionContext(),
    );
    expect(new URL((await start.json<{ url: string }>()).url).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);

    const callback = await worker.fetch!(new Request(`${ORIGIN}/auth/github/callback?code=x&state=wrong`, { headers: { cookie: `${cookie}; github_oauth_state=right` } }), bare, createExecutionContext());
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/profile?github=error`);

    // The MCP host check compares against the request's own host, so it passes
    // that far (401 for the missing credential) and still rejects a mismatched Host.
    const mcp = await worker.fetch!(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), bare, createExecutionContext());
    expect(mcp.status).toBe(401);
    const hostile = await worker.fetch!(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }), bare, createExecutionContext());
    expect(hostile.status).toBe(403);
  });

  it("refuses a callback whose state does not match, and writes nothing", async () => {
    const cookie = await signup("gh-state@foxban.test", "Gh State");

    for (const query of ["?code=x&state=wrong", "?code=x"]) {
      const response = await SELF.fetch(`${ORIGIN}/auth/github/callback${query}`, {
        headers: { cookie: `${cookie}; github_oauth_state=right` },
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://app.example/profile?github=error");
    }

    expect(await (await get("/me", cookie)).json()).toMatchObject({ githubLogin: null });
  });

  it("links the GitHub account the App's sign-in approved, signing the exchange with the App's own credentials", async () => {
    const cookie = await signup("gh-link@foxban.test", "Gh Link");
    await createGitHubApp(cookie);
    github.accounts.octo = { id: 583231, login: "octocat" };

    expect(await connectGitHub(cookie, "octo")).toBe("https://app.example/profile");

    expect(await (await get("/me", cookie)).json()).toMatchObject({ githubLogin: "octocat" });
    expect(github.tokenRequests).toEqual([
      {
        client_id: GITHUB_APP.client_id,
        client_secret: GITHUB_APP.client_secret,
        code: "octo",
        redirect_uri: "https://app.example/auth/github/callback",
      },
    ]);
  });

  it("writes nothing when GitHub refuses the code or answers with something unusable", async () => {
    const cookie = await signup("gh-bad@foxban.test", "Gh Bad");
    await createGitHubApp(cookie);
    github.accounts.noid = { login: "octocat" };
    github.accounts.textid = { id: "583231", login: "octocat" };
    github.accounts.badlogin = { id: 583231, login: "not a login!" };

    for (const code of ["refused", "noid", "textid", "badlogin"]) {
      expect(await connectGitHub(cookie, code)).toBe("https://app.example/profile?github=error");
    }
    expect(await (await get("/me", cookie)).json()).toMatchObject({ githubLogin: null });

    // The App was removed between the start and the callback.
    github.accounts.octo = { id: 583231, login: "octocat" };
    const state = await linkState(await startGitHubLink(cookie, PASSWORD));
    await env.DB.exec("DELETE FROM github_app");
    const callback = await githubLinkCallback(cookie, "octo", state);
    expect(callback.headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await (await get("/me", cookie)).json()).toMatchObject({ githubLogin: null });
  });

  it("keeps one foxban account per GitHub account, by GitHub's id and not the login name", async () => {
    const first = await signup("gh-first@foxban.test", "Gh First");
    const second = await signup("gh-second@foxban.test", "Gh Second");
    await createGitHubApp(first);
    // The same GitHub account (one id) as it was approved before and after a rename.
    github.accounts.before = { id: 583231, login: "octocat" };
    github.accounts.after = { id: 583231, login: "octocat-renamed" };

    expect(await connectGitHub(first, "before")).toBe("https://app.example/profile");
    expect(await connectGitHub(second, "after")).toBe("https://app.example/profile?github=taken");
    expect(await (await get("/me", second)).json()).toMatchObject({ githubLogin: null });
    expect(await (await get("/me", first)).json()).toMatchObject({ githubLogin: "octocat" });

    // The owner linking again is not a clash: it follows the rename.
    expect(await connectGitHub(first, "after")).toBe("https://app.example/profile");
    expect(await (await get("/me", first)).json()).toMatchObject({ githubLogin: "octocat-renamed" });
  });

  it("frees the GitHub account for someone else once its owner disconnects", async () => {
    const first = await signup("gh-free-1@foxban.test", "Gh Free One");
    const second = await signup("gh-free-2@foxban.test", "Gh Free Two");
    await createGitHubApp(first);
    github.accounts.octo = { id: 583231, login: "octocat" };

    await connectGitHub(first, "octo");
    expect((await patch("/me", { githubLogin: null }, first)).status).toBe(200);

    expect(await connectGitHub(second, "octo")).toBe("https://app.example/profile");
    expect(await (await get("/me", second)).json()).toMatchObject({ githubLogin: "octocat" });
  });

  it("surfaces a verified login on /me and members, and only ever disconnects", async () => {
    const owner = await signup("gh-owner@foxban.test", "Gh Owner");
    const guest = await signup("gh-guest@foxban.test", "Gh Guest");

    await createGitHubApp(owner);
    github.accounts.octo = { id: 583231, login: "octocat" };
    await connectGitHub(owner, "octo");
    expect(await (await get("/me", owner)).json()).toMatchObject({ githubLogin: "octocat" });

    const boardId = await createBoard(owner, "Avatars");
    const ghGuestId = await getUserId(guest);
    await post(`/boards/${boardId}/members`, { userId: ghGuestId }, owner);

    const members = await get(`/boards/${boardId}/members`, guest);
    expect(await members.json()).toEqual({
      members: [
        { id: expect.any(String), email: "gh-guest@foxban.test", name: "Gh Guest", githubLogin: null, avatarVersion: null, explicitRole: "member", workspaceRole: null, isAdmin: true },
        {
          id: expect.any(String),
          email: "gh-owner@foxban.test",
          name: "Gh Owner",
          githubLogin: "octocat",
          avatarVersion: null,
          explicitRole: "member",
          workspaceRole: null,
          isAdmin: true,
        },
      ],
    });
    // A typed username is no longer a thing PATCH accepts.
    expect((await patch("/me", { githubLogin: "someone-else" }, owner)).status).toBe(400);

    const cleared = await patch("/me", { githubLogin: null }, owner);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ githubLogin: null });
    expect(await (await get("/me", owner)).json()).toMatchObject({ githubLogin: null });
  });

  it("updates display name with trimming, mirrors on /me and board members, and preserves session", async () => {
    const admin = await signup("admin-name@foxban.test", "Admin Name");
    const invite = await mintInvite(admin);
    const cookie = await signupWithInvite("user-name@user.test", invite, "Old Name");

    const update = await patch("/me", { name: "  Trimmed Name  " }, cookie);
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      email: "user-name@user.test",
      name: "Trimmed Name",
    });

    const me = await get("/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      email: "user-name@user.test",
      name: "Trimmed Name",
    });

    const boardId = await createBoard(admin, "Name Mirror Board");
    const userNameId = await getUserId(cookie);
    await post(`/boards/${boardId}/members`, { userId: userNameId }, admin);

    const members = await get(`/boards/${boardId}/members`, cookie);
    expect(members.status).toBe(200);
    expect(await members.json()).toEqual({
      members: expect.arrayContaining([
        expect.objectContaining({
          email: "user-name@user.test",
          name: "Trimmed Name",
        }),
      ]),
    });
  });
  it("updates timezone override, validates IANA timezone, allows null reset, and preserves session", async () => {
    const admin = await signup("admin-tz@foxban.test", "Admin Tz");
    const invite = await mintInvite(admin);
    const cookie = await signupWithInvite("user-tz@user.test", invite, "Tz User");

    // Default signup user has null timezone
    const initialMe = await get("/me", cookie);
    expect(initialMe.status).toBe(200);
    expect(await initialMe.json()).toMatchObject({ timezone: null });

    // Invalid IANA timezone is rejected with 400
    const invalidTz = await patch("/me", { timezone: "Invalid/Not_A_Real_Timezone" }, cookie);
    expect(invalidTz.status).toBe(400);

    // Valid IANA timezone override saves and returns in PATCH and subsequent GET /me
    const setTz = await patch("/me", { timezone: "Asia/Tokyo" }, cookie);
    expect(setTz.status).toBe(200);
    expect(await setTz.json()).toMatchObject({
      email: "user-tz@user.test",
      name: "Tz User",
      timezone: "Asia/Tokyo",
    });

    const updatedMe = await get("/me", cookie);
    expect(updatedMe.status).toBe(200);
    expect(await updatedMe.json()).toMatchObject({ timezone: "Asia/Tokyo" });

    // Resetting timezone to null (automatic) succeeds
    const resetTz = await patch("/me", { timezone: null }, cookie);
    expect(resetTz.status).toBe(200);
    expect(await resetTz.json()).toMatchObject({ timezone: null });

    const clearedMe = await get("/me", cookie);
    expect(clearedMe.status).toBe(200);
    expect(await clearedMe.json()).toMatchObject({ timezone: null });
  });


  it("changes email with correct password, normalizes case and whitespace, and updates login", async () => {
    const admin = await signup("admin-email@foxban.test", "Admin Email");
    const invite = await mintInvite(admin);
    const cookie = await signupWithInvite("original-email@user.test", invite, "Email User");

    const response = await post(
      "/auth/email",
      { email: "  Updated-Email@User.Test  ", currentPassword: PASSWORD },
      cookie,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      email: "updated-email@user.test",
      name: "Email User",
      githubLogin: null,
      avatarVersion: null,
      timezone: null,
      hasPassword: true,
      isAdmin: false,
    });

    const me = await get("/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "updated-email@user.test" });

    const oldLogin = await post("/auth/login", {
      email: "original-email@user.test",
      password: PASSWORD,
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await post("/auth/login", {
      email: "updated-email@user.test",
      password: PASSWORD,
    });
    expect(newLogin.status).toBe(200);
  });

  it("rejects unauthorized, duplicate, and admin-transition email changes", async () => {
    const admin = await signup("admin-rejections@foxban.test", "Admin Rejections");
    const invite1 = await mintInvite(admin);
    const invite2 = await mintInvite(admin);
    const userCookie = await signupWithInvite("user-rej@user.test", invite1, "User Rej");
    const dupCookie = await signupWithInvite("dup-target@user.test", invite2, "Dup Target");
    expect(dupCookie).toBeTruthy();

    const wrongWithDup = await post(
      "/auth/email",
      { email: "dup-target@user.test", currentPassword: "wrong password" },
      userCookie,
    );
    expect(wrongWithDup.status).toBe(401);
    expect(await wrongWithDup.json()).toEqual({ error: "invalid credentials" });

    const wrongWithAdmin = await post(
      "/auth/email",
      { email: "new-admin@foxban.test", currentPassword: "wrong password" },
      userCookie,
    );
    expect(wrongWithAdmin.status).toBe(401);
    expect(await wrongWithAdmin.json()).toEqual({ error: "invalid credentials" });

    expect(await (await get("/me", userCookie)).json()).toMatchObject({
      email: "user-rej@user.test",
    });

    const duplicate = await post(
      "/auth/email",
      { email: "dup-target@user.test", currentPassword: PASSWORD },
      userCookie,
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "email already registered" });
    expect(await (await get("/me", userCookie)).json()).toMatchObject({
      email: "user-rej@user.test",
    });

    const demote = await post(
      "/auth/email",
      { email: "demoted@user.test", currentPassword: PASSWORD },
      admin,
    );
    expect(demote.status).toBe(403);
    expect(await demote.json()).toEqual({ error: "email cannot change administrator access" });
    expect(await (await get("/me", admin)).json()).toMatchObject({
      email: "admin-rejections@foxban.test",
      isAdmin: true,
    });
    expect((await post("/auth/login", { email: "admin-rejections@foxban.test", password: PASSWORD })).status).toBe(200);
    expect((await get("/invites", admin)).status).toBe(200);

    // Only a listed address is an admin address, so this one is listed: the change would be a promotion.
    env.ADMIN_EMAILS += ",promoted@foxban.test";
    const promote = await post(
      "/auth/email",
      { email: "promoted@foxban.test", currentPassword: PASSWORD },
      userCookie,
    );
    expect(promote.status).toBe(403);
    expect(await promote.json()).toEqual({ error: "email cannot change administrator access" });
    expect(await (await get("/me", userCookie)).json()).toMatchObject({
      email: "user-rej@user.test",
      isAdmin: false,
    });
    expect((await post("/auth/login", { email: "user-rej@user.test", password: PASSWORD })).status).toBe(200);
    expect((await get("/invites", userCookie)).status).toBe(403);
  });

  it("verifies current password, preserves active session, revokes concurrent sessions, and updates login credentials", async () => {
    const admin = await signup("admin-pwd@foxban.test", "Admin Pwd");
    const invite = await mintInvite(admin);
    const session1 = await signupWithInvite("user-pwd@user.test", invite, "Pwd User");

    const loginRes = await post("/auth/login", {
      email: "user-pwd@user.test",
      password: PASSWORD,
    });
    expect(loginRes.status).toBe(200);
    const session2 = sessionCookie(loginRes);
    expect(session1).not.toBe(session2);

    const wrong = await post(
      "/auth/password",
      { currentPassword: "wrong password", newPassword: "new-password-1234" },
      session1,
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid credentials" });
    const weakRotated = await post(
      "/auth/password",
      { currentPassword: PASSWORD, newPassword: "11111111" },
      session1,
    );
    expect(weakRotated.status).toBe(400);

    // Rejected replacement does not mutate password hash or revoke sessions
    expect((await post("/auth/login", { email: "user-pwd@user.test", password: PASSWORD })).status).toBe(200);
    expect((await get("/me", session1)).status).toBe(200);
    expect((await get("/me", session2)).status).toBe(200);

    const NEW_PASSWORD = "brand-new-password";
    const rotated = await post(
      "/auth/password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      session1,
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ ok: true });

    const me1 = await get("/me", session1);
    expect(me1.status).toBe(200);
    expect(await me1.json()).toMatchObject({ email: "user-pwd@user.test" });

    const me2 = await get("/me", session2);
    expect(me2.status).toBe(401);
    expect(await me2.json()).toEqual({ error: "unauthorized" });

    const oldLogin = await post("/auth/login", {
      email: "user-pwd@user.test",
      password: PASSWORD,
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await post("/auth/login", {
      email: "user-pwd@user.test",
      password: NEW_PASSWORD,
    });
    expect(newLogin.status).toBe(200);
  });

  it("rejects an old-password login paused across password rotation without minting a session", async () => {
    const email = "login-rotation@foxban.test";
    const cookie = await signup(email);
    let release!: () => void;
    let read!: () => void;
    const paused = new Promise<void>((resolve) => { read = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM users WHERE email = ?")) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  const row = await bound.first();
                  read();
                  await resume;
                  return row;
                },
              };
            },
          };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending = worker.fetch!(new Request(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }), { ...env, DB: db }, createExecutionContext());
    await paused;
    try {
      const rotated = await post("/auth/password", {
        currentPassword: PASSWORD, newPassword: "new horse battery staple",
      }, cookie);
      expect(rotated.status).toBe(200);
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const userId = await getUserId(cookie);
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
      .bind(userId).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
    expect((await post("/auth/login", { email, password: "new horse battery staple" })).status).toBe(200);
  });

  it("caps login attempts on one account across many IPs, above the per-IP limit", async () => {
    const victim = "spread-victim@foxban.test";
    await signup(victim, "Spread Victim");
    const attempt = (email: string, ip: string) =>
      SELF.fetch(`${ORIGIN}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ email, password: "wrong-password" }),
      });
    // Nine tries from each of six IPs: every IP stays under its own 10, the account passes its 50.
    const statuses: number[] = [];
    for (let ip = 0; ip < 6; ip++) {
      for (let i = 0; i < 9; i++) statuses.push((await attempt(victim, `203.0.113.${ip + 1}`)).status);
    }
    expect(statuses.slice(0, 50).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(50).every((status) => status === 429)).toBe(true);
    // A fresh IP is refused for that account only.
    expect((await attempt(victim, "203.0.113.99")).status).toBe(429);
    expect((await attempt("someone-else@foxban.test", "203.0.113.99")).status).toBe(401);
  });

  it("enforces rate limits on email and password changes while requireAuth takes precedence", async () => {
    const admin = await signup("admin-rate@foxban.test", "Admin Rate");
    const invite = await mintInvite(admin);
    const cookie = await signupWithInvite("user-rate@user.test", invite, "Rate User");

    const emailIp = "198.51.100.11";
    for (let i = 0; i < 10; i++) {
      const res = await post(
        "/auth/email",
        { email: "user-rate@user.test", currentPassword: "wrong-password" },
        cookie,
        { "CF-Connecting-IP": emailIp },
      );
      expect(res.status).not.toBe(429);
    }
    const emailThrottled = await post(
      "/auth/email",
      { email: "user-rate@user.test", currentPassword: "wrong-password" },
      cookie,
      { "CF-Connecting-IP": emailIp },
    );
    expect(emailThrottled.status).toBe(429);
    expect(await emailThrottled.json()).toEqual({ error: "too many requests" });

    const emailUnauth = await post(
      "/auth/email",
      {},
      undefined,
      { "CF-Connecting-IP": emailIp },
    );
    expect(emailUnauth.status).toBe(401);
    expect(await emailUnauth.json()).toEqual({ error: "unauthorized" });

    const pwdIp = "198.51.100.12";
    for (let i = 0; i < 10; i++) {
      const res = await post(
        "/auth/password",
        { currentPassword: "wrong-password", newPassword: "some-new-password" },
        cookie,
        { "CF-Connecting-IP": pwdIp },
      );
      expect(res.status).not.toBe(429);
    }
    const pwdThrottled = await post(
      "/auth/password",
      { currentPassword: "wrong-password", newPassword: "some-new-password" },
      cookie,
      { "CF-Connecting-IP": pwdIp },
    );
    expect(pwdThrottled.status).toBe(429);
    expect(await pwdThrottled.json()).toEqual({ error: "too many requests" });

    const pwdUnauth = await post(
      "/auth/password",
      {},
      undefined,
      { "CF-Connecting-IP": pwdIp },
    );
    expect(pwdUnauth.status).toBe(401);
    expect(await pwdUnauth.json()).toEqual({ error: "unauthorized" });
  });
});
/**
 * The browser round trip for "Log in with GitHub", from a signed-out browser: GitHub approves `code` and
 * sends the browser back, with the cookies the start set. `invite` is what the signup page puts on the
 * start link, and `workspaceInvite` (`<workspaceId>.<token>`) the workspace invitation either page holds.
 * Returns the callback's response.
 */
async function logInWithGitHub(code: string, headers?: HeadersInit, invite?: string, workspaceInvite?: string): Promise<Response> {
  const params = new URLSearchParams();
  if (invite !== undefined) params.set("invite", invite);
  if (workspaceInvite !== undefined) params.set("workspaceInvite", workspaceInvite);
  const query = params.size > 0 ? `?${params}` : "";
  const start = await SELF.fetch(`${ORIGIN}/auth/github/login/start${query}`, { headers, redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = start.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
  return SELF.fetch(`${ORIGIN}/auth/github/login/callback?code=${code}&state=${state}`, {
    headers: { ...headers, cookie },
    redirect: "manual",
  });
}

/** One of the e-mail addresses `GET /user/emails` lists. */
const githubEmail = (email: string, flags: { primary?: boolean; verified?: boolean } = {}) => ({
  email,
  primary: flags.primary ?? true,
  verified: flags.verified ?? true,
  visibility: null,
});

/** The session cookie a response sets, or null: the callback also clears its state cookie, so it is not the first one. */
function signedInCookie(response: Response): string | null {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith("session=") && !cookie.startsWith("session=;"));
  return header?.split(";")[0] ?? null;
}

describe("log in with GitHub", () => {
  let github: ReturnType<typeof fakeGitHub>;
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_app");
    // The pool shares D1 across the file, and every test here reuses the same GitHub ids.
    await env.DB.exec("UPDATE users SET github_login = NULL, github_user_id = NULL");
    github = fakeGitHub();
  });
  afterEach(() => github.restore());

  /** An Admin has created the instance GitHub App, and `email` has linked the GitHub account that `code` approves. */
  async function linkedUser(email: string, code: string, account: { id: number; login: string }): Promise<string> {
    const cookie = await signup(email, "Gh Login");
    if (!(await env.DB.prepare("SELECT 1 FROM github_app").first())) await createGitHubApp(cookie);
    github.accounts[code] = account;
    expect(await connectGitHub(cookie, code)).toBe("https://app.example/profile");
    return cookie;
  }

  it("signs a linked GitHub account in with a normal session, signing the exchange with the App's own credentials", async () => {
    const linked = await linkedUser("gh-login@foxban.test", "octo", { id: 583231, login: "octocat" });
    const userId = await getUserId(linked);

    const start = await SELF.fetch(`${ORIGIN}/auth/github/login/start`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://github.example");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(GITHUB_APP.client_id);
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.example/auth/github/login/callback");
    // The state travels in an httpOnly cookie of its own, so it cannot be mixed up with the Profile link's.
    const state = location.searchParams.get("state")!;
    expect(start.headers.get("set-cookie")!.split(";")[0]).toBe(`github_login_state=${state}`);

    github.tokenRequests.length = 0;
    const callback = await SELF.fetch(`${ORIGIN}/auth/github/login/callback?code=octo&state=${state}`, {
      headers: { cookie: `github_login_state=${state}` },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example/");
    expect(github.tokenRequests).toEqual([
      {
        client_id: GITHUB_APP.client_id,
        client_secret: GITHUB_APP.client_secret,
        code: "octo",
        redirect_uri: "https://app.example/auth/github/login/callback",
      },
    ]);

    const session = signedInCookie(callback)!;
    expect(await (await get("/me", session)).json()).toMatchObject({ id: userId, email: "gh-login@foxban.test", githubLogin: "octocat" });
  });

  it("matches by GitHub's numeric id: a renamed account still signs in, and a new owner of its old login name does not", async () => {
    const linked = await linkedUser("gh-rename@foxban.test", "before", { id: 583231, login: "octocat" });
    const userId = await getUserId(linked);

    // The owner renames on GitHub, and someone else takes the name they freed.
    github.accounts.renamed = { id: 583231, login: "octocat-renamed" };
    github.accounts.newowner = { id: 900001, login: "octocat" };
    github.emails.newowner = [githubEmail("new-owner@example.test")];

    const squatter = await logInWithGitHub("newowner");
    expect(squatter.headers.get("location")).toBe("https://app.example/login?github=unlinked");
    expect(signedInCookie(squatter)).toBeNull();

    const owner = await logInWithGitHub("renamed");
    expect(owner.headers.get("location")).toBe("https://app.example/");
    // Signing in follows the rename, so the avatar stays the owner's.
    expect(await (await get("/me", signedInCookie(owner)!)).json()).toMatchObject({ id: userId, githubLogin: "octocat-renamed" });
  });

  describe("a workspace invitation the login page holds", () => {
    const joinPage = "https://app.example/join-workspace/personal_5c1d-2e#invite=tok_en-9";
    const continuation = "personal_5c1d-2e.tok_en-9";
    const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));

    it("is carried across the round trip, and sends the person to the join page once signed in", async () => {
      await linkedUser("gh-join@foxban.test", "octo", { id: 583231, login: "octocat" });

      const start = await SELF.fetch(`${ORIGIN}/auth/github/login/start?workspaceInvite=${continuation}`, { redirect: "manual" });
      // An httpOnly cookie of its own, so the invitation is not readable by scripts or put in GitHub's URL.
      expect(cookieOf(start, "github_login_workspace_invite")).toMatch(/^github_login_workspace_invite=personal_5c1d-2e\.tok_en-9;.*HttpOnly/i);
      expect(new URL(start.headers.get("location")!).search).not.toContain("tok_en-9");

      const callback = await logInWithGitHub("octo", undefined, undefined, continuation);
      expect(callback.headers.get("location")).toBe(joinPage);
      expect(signedInCookie(callback)).not.toBeNull();
      // It is single use: the callback clears it.
      expect(cookieOf(callback, "github_login_workspace_invite")).toMatch(/^github_login_workspace_invite=;/);
      expect((await logInWithGitHub("octo")).headers.get("location")).toBe("https://app.example/");
    });

    it("also reaches the join page after a GitHub sign-up with an invite", async () => {
      const admin = await signup(`gh-join-admin-${crypto.randomUUID()}@foxban.test`);
      await createGitHubApp(admin);
      github.accounts.joiner = { id: 710090, login: "joiner" };
      github.emails.joiner = [githubEmail("joiner@example.test")];

      const callback = await logInWithGitHub("joiner", undefined, await mintInvite(admin), continuation);
      expect(callback.headers.get("location")).toBe(joinPage);
      expect(signedInCookie(callback)).not.toBeNull();
    });

    it("is kept on the login page's address when the round trip fails, so a retry still has it", async () => {
      await linkedUser("gh-join-fail@foxban.test", "octo", { id: 583231, login: "octocat" });
      const start = await SELF.fetch(`${ORIGIN}/auth/github/login/start?workspaceInvite=${continuation}`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cancelled = await SELF.fetch(`${ORIGIN}/auth/github/login/callback?error=access_denied&state=${state}`, {
        headers: { cookie: `github_login_state=${state}; github_login_workspace_invite=${continuation}` },
        redirect: "manual",
      });
      expect(cancelled.headers.get("location")).toBe(`https://app.example/login?github=cancelled#workspaceInvite=${continuation}`);

      await env.DB.exec("DELETE FROM github_app");
      const unavailable = await SELF.fetch(`${ORIGIN}/auth/github/login/start?workspaceInvite=${continuation}`, { redirect: "manual" });
      expect(unavailable.headers.get("location")).toBe(`https://app.example/login?github=unavailable#workspaceInvite=${continuation}`);
    });

    it("never turns anything but a workspace id and a token into a redirect", async () => {
      await linkedUser("gh-join-forged@foxban.test", "octo", { id: 583231, login: "octocat" });
      const forged = ["https://evil.example/x", "//evil.example.x", "a/../../b.token", "ws.", ".token", "ws.tok en", `${"w".repeat(65)}.token`, "ws.token.more"];

      for (const value of forged) {
        // Refused at the start: nothing is stored.
        const refused = await SELF.fetch(`${ORIGIN}/auth/github/login/start?workspaceInvite=${encodeURIComponent(value)}`, { redirect: "manual" });
        expect(cookieOf(refused, "github_login_workspace_invite")).toBeUndefined();

        // And a cookie forged without the start is refused at the callback.
        const state = new URL(refused.headers.get("location")!).searchParams.get("state")!;
        const callback = await SELF.fetch(`${ORIGIN}/auth/github/login/callback?code=octo&state=${state}`, {
          headers: { cookie: `github_login_state=${state}; github_login_workspace_invite=${encodeURIComponent(value)}` },
          redirect: "manual",
        });
        expect(callback.headers.get("location")).toBe("https://app.example/");
      }
    });
  });

  it("sends a cancelled or failed sign-in back to the login page with the reason, and never starts a session", async () => {
    // No App yet (an Admin creates it, ADR 0064): the button leads to a message, not a broken page.
    const off = await SELF.fetch(`${ORIGIN}/auth/github/login/start`, { redirect: "manual" });
    expect(off.headers.get("location")).toBe("https://app.example/login?github=unavailable");
    expect(off.headers.get("set-cookie")).toBeNull();

    await linkedUser("gh-fail@foxban.test", "octo", { id: 583231, login: "octocat" });
    github.accounts.noid = { login: "octocat" };
    const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>())!.count;
    const sessionsBefore = await sessionCount();
    const start = await SELF.fetch(`${ORIGIN}/auth/github/login/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = (query: string, cookie = `github_login_state=${state}`) =>
      SELF.fetch(`${ORIGIN}/auth/github/login/callback${query}`, { headers: { cookie }, redirect: "manual" });
    const outcomes: Array<[string, Response]> = [
      // GitHub sends this when the person presses Cancel on its approval page.
      ["cancelled", await callback(`?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=${state}`)],
      ["error", await callback(`?error=redirect_uri_mismatch&state=${state}`)],
      ["error", await callback("?code=octo&state=wrong")],
      ["error", await callback("?code=octo")],
      ["error", await callback(`?code=octo&state=${state}`, "")],
      ["error", await callback(`?state=${state}`)],
      ["error", await callback(`?code=refused&state=${state}`)],
      ["error", await callback(`?code=noid&state=${state}`)],
    ];
    for (const [reason, response] of outcomes) {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://app.example/login?github=${reason}`);
      expect(signedInCookie(response)).toBeNull();
    }

    // The App was removed between the start and the callback.
    await env.DB.exec("DELETE FROM github_app");
    expect((await callback(`?code=octo&state=${state}`)).headers.get("location")).toBe("https://app.example/login?github=error");
    expect(await sessionCount()).toBe(sessionsBefore);
  });

  it("is revoked with the other sessions when the password changes", async () => {
    const passwordSession = await linkedUser("gh-revoke@foxban.test", "octo", { id: 583231, login: "octocat" });
    const githubSession = signedInCookie(await logInWithGitHub("octo"))!;
    expect((await get("/me", githubSession)).status).toBe(200);

    const changed = await post("/auth/password", { currentPassword: PASSWORD, newPassword: "new horse battery staple" }, passwordSession);
    expect(changed.status).toBe(200);

    expect((await get("/me", githubSession)).status).toBe(401);
    expect((await get("/me", passwordSession)).status).toBe(200);
  });

  it("is rate limited per client IP like the other auth routes, at both ends", async () => {
    await linkedUser("gh-rate@foxban.test", "octo", { id: 583231, login: "octocat" });

    for (const path of ["/auth/github/login/start", "/auth/github/login/callback?code=octo&state=wrong"]) {
      const headers = { "CF-Connecting-IP": path.endsWith("start") ? "198.51.100.21" : "198.51.100.22" };
      for (let attempt = 0; attempt < 10; attempt++) {
        expect((await SELF.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" })).status).toBe(302);
      }
      const throttled = await SELF.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
      expect(throttled.status).toBe(429);
      expect(await throttled.json()).toEqual({ error: "too many requests" });
    }
  });
});

describe("sign up with GitHub", () => {
  let github: ReturnType<typeof fakeGitHub>;
  let admin: string;
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_app");
    // The pool shares D1 across the file, and every test here reuses the same GitHub ids.
    await env.DB.exec("UPDATE users SET github_login = NULL, github_user_id = NULL");
    github = fakeGitHub();
    admin = await signup(`gh-signup-admin-${crypto.randomUUID()}@foxban.test`);
    await createGitHubApp(admin);
  });
  afterEach(() => github.restore());

  /** `code` is the approval of GitHub account `account`, which has the e-mail addresses `emails`. */
  function approves(code: string, account: { id: number; login: string }, ...emails: ReturnType<typeof githubEmail>[]) {
    github.accounts[code] = account;
    github.emails[code] = emails;
  }

  async function inviteRow(token: string): Promise<{ usedBy: string | null; usedAt: number | null }> {
    const { invites } = await (await get("/invites", admin)).json<{ invites: Array<{ token: string; usedBy: string | null; usedAt: number | null }> }>();
    return invites.find((invite) => invite.token === token)!;
  }

  it("creates the account and spends the invite when an unknown GitHub account arrives with a valid invite", async () => {
    const invite = await mintInvite(admin);
    // The account keeps the primary address, whatever order GitHub lists them in.
    approves("newbie", { id: 710001, login: "newbie" }, githubEmail("other@example.test", { primary: false }), githubEmail("Newbie@Example.test"));

    const callback = await logInWithGitHub("newbie", undefined, invite);
    expect(callback.headers.get("location")).toBe("https://app.example/");
    const session = signedInCookie(callback)!;
    const me = await (await get("/me", session)).json<{ id: string }>();
    expect(me).toMatchObject({ email: "newbie@example.test", name: "newbie", githubLogin: "newbie", isAdmin: false });
    expect(await inviteRow(invite)).toMatchObject({ usedBy: me.id });

    // The account is keyed by GitHub's id from now on: signing in again finds it, with no invite.
    const again = await logInWithGitHub("newbie");
    expect(again.headers.get("location")).toBe("https://app.example/");
    expect(await (await get("/me", signedInCookie(again)!)).json()).toMatchObject({ id: me.id });
  });

  it("refuses an unknown GitHub account without a valid invite, the same whether it is missing, unknown or spent", async () => {
    const spent = await mintInvite(admin);
    approves("first", { id: 710010, login: "first-comer" }, githubEmail("first-comer@example.test"));
    expect(signedInCookie(await logInWithGitHub("first", undefined, spent))).not.toBeNull();

    const unspent = await mintInvite(admin);
    approves("second", { id: 710011, login: "second-comer" }, githubEmail("second-comer@example.test"));
    for (const invite of [undefined, "no-such-token", spent]) {
      const refused = await logInWithGitHub("second", undefined, invite);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("location")).toBe("https://app.example/login?github=unlinked");
      expect(signedInCookie(refused)).toBeNull();
    }
    expect(await inviteRow(unspent)).toMatchObject({ usedBy: null });

    // Nothing was created by the refusals: the same GitHub account can still sign up, and spends the invite.
    const signedUp = await logInWithGitHub("second", undefined, unspent);
    expect(signedInCookie(signedUp)).not.toBeNull();
    expect((await inviteRow(unspent)).usedBy).not.toBeNull();
  });

  it("never links an existing account by e-mail: the person is told to sign in with their password and link GitHub in Profile", async () => {
    const existing = await signupWithInvite("owner-of-address@example.test", await mintInvite(admin), "Existing");
    const existingId = await getUserId(existing);
    const invite = await mintInvite(admin);
    // Any verified address matches, not only the primary one, and case does not matter.
    approves("clash", { id: 710020, login: "clasher" }, githubEmail("elsewhere@example.test"), githubEmail("Owner-Of-Address@Example.test", { primary: false }));

    // With or without an invite: someone who already has an account does not need one.
    for (const attempt of [invite, undefined]) {
      const callback = await logInWithGitHub("clash", undefined, attempt);
      expect(callback.headers.get("location")).toBe("https://app.example/login?github=exists");
      expect(signedInCookie(callback)).toBeNull();
    }
    expect(await (await get("/me", existing)).json()).toMatchObject({ id: existingId, githubLogin: null });
    expect(await inviteRow(invite)).toMatchObject({ usedBy: null });

    // The way the message points works: link in Profile, and GitHub sign-in finds that account.
    expect(await connectGitHub(existing, "clash")).toBe("https://app.example/profile");
    const linked = await logInWithGitHub("clash");
    expect(await (await get("/me", signedInCookie(linked)!)).json()).toMatchObject({ id: existingId, githubLogin: "clasher" });
  });

  it("compares verified addresses only: an unverified address that matches an account blocks nothing and is not kept", async () => {
    await signupWithInvite("claimed-but-unverified@example.test", await mintInvite(admin), "Existing");
    const invite = await mintInvite(admin);
    approves(
      "unverified",
      { id: 710030, login: "unverified-claim" },
      githubEmail("claimed-but-unverified@example.test", { verified: false }),
      githubEmail("really-mine@example.test", { primary: false }),
    );

    const callback = await logInWithGitHub("unverified", undefined, invite);
    expect(callback.headers.get("location")).toBe("https://app.example/");
    expect(await (await get("/me", signedInCookie(callback)!)).json()).toMatchObject({ email: "really-mine@example.test" });
  });

  it("never makes a GitHub account an Admin, even when its GitHub address is on the admin list, and still needs the invite", async () => {
    // These addresses are on the admin list, as exact entries.
    env.ADMIN_EMAILS += ",boss@foxban.test,boss-again@foxban.test";
    approves("boss", { id: 710040, login: "boss-login" }, githubEmail("boss@foxban.test"));
    const callback = await logInWithGitHub("boss", undefined, await mintInvite(admin));
    const session = signedInCookie(callback)!;
    expect(await (await get("/me", session)).json()).toMatchObject({
      email: "710040+boss-login@users.noreply.github.com",
      githubLogin: "boss-login",
      isAdmin: false,
    });
    expect((await get("/invites", session)).status).toBe(403);

    // No admin shortcut around the invite, as email signup has for an admin address.
    approves("boss-again", { id: 710041, login: "boss-again" }, githubEmail("boss-again@foxban.test"));
    const refused = await logInWithGitHub("boss-again");
    expect(refused.headers.get("location")).toBe("https://app.example/login?github=unlinked");
    expect(signedInCookie(refused)).toBeNull();
  });

  it("refuses, and creates nothing, when even the no-reply address would be an Admin's", async () => {
    const configured = env.ADMIN_EMAILS;
    env.ADMIN_EMAILS = `${configured}, doomed@foxban.test, 710042+doomed@users.noreply.github.com`;
    try {
      const invite = await mintInvite(admin);
      // The address on GitHub is on the list, and so is the no-reply fallback it would be given instead.
      approves("doomed", { id: 710042, login: "doomed" }, githubEmail("doomed@foxban.test"));
      const refused = await logInWithGitHub("doomed", undefined, invite);
      expect(refused.headers.get("location")).toBe("https://app.example/login?github=error");
      expect(signedInCookie(refused)).toBeNull();
      expect(await inviteRow(invite)).toMatchObject({ usedBy: null, usedAt: null });
      expect(await env.DB.prepare("SELECT 1 FROM users WHERE github_user_id = 710042").first()).toBeNull();
    } finally {
      env.ADMIN_EMAILS = configured;
    }
  });

  it("gives an account with no verified GitHub address the no-reply address, and no password that signs in", async () => {
    approves("quiet", { id: 710050, login: "quiet-one" }, githubEmail("unverified@example.test", { verified: false }));
    const callback = await logInWithGitHub("quiet", undefined, await mintInvite(admin));
    const email = "710050+quiet-one@users.noreply.github.com";
    expect(await (await get("/me", signedInCookie(callback)!)).json()).toMatchObject({ email });

    // Accounts still have a password column; this one has nothing that matches it.
    for (const password of [PASSWORD, "*", ""]) {
      expect((await post("/auth/login", { email, password: password || "x" })).status).toBe(401);
    }
  });

  it("fails closed when GitHub will not list the addresses, spending nothing", async () => {
    const invite = await mintInvite(admin);
    // No `emails` entry: what an App without "Email addresses: read" gets.
    github.accounts.blind = { id: 710060, login: "blind" };
    const refused = await logInWithGitHub("blind", undefined, invite);
    expect(refused.headers.get("location")).toBe("https://app.example/login?github=error");
    expect(signedInCookie(refused)).toBeNull();
    expect(await inviteRow(invite)).toMatchObject({ usedBy: null });

    github.emails.blind = { message: "not a list" };
    expect((await logInWithGitHub("blind", undefined, invite)).headers.get("location")).toBe("https://app.example/login?github=error");
    expect(await inviteRow(invite)).toMatchObject({ usedBy: null });
  });

  it("spends the invite and creates the account together or not at all", async () => {
    // Email signup checks nothing about the address, so this one is taken before the GitHub account arrives.
    await signupWithInvite("710070+racer@users.noreply.github.com", await mintInvite(admin));
    const invite = await mintInvite(admin);
    approves("racer", { id: 710070, login: "racer" });

    const refused = await logInWithGitHub("racer", undefined, invite);
    expect(refused.headers.get("location")).toBe("https://app.example/login?github=error");
    expect(signedInCookie(refused)).toBeNull();
    expect(await inviteRow(invite)).toMatchObject({ usedBy: null, usedAt: null });
  });

  it("leaves an invite alone when the GitHub account is already known, and does not carry one into the next attempt", async () => {
    approves("known", { id: 710080, login: "known-one" }, githubEmail("known-one@example.test"));
    expect(signedInCookie(await logInWithGitHub("known", undefined, await mintInvite(admin)))).not.toBeNull();

    const unused = await mintInvite(admin);
    const signedIn = await logInWithGitHub("known", undefined, unused);
    expect(signedIn.headers.get("location")).toBe("https://app.example/");
    expect(await inviteRow(unused)).toMatchObject({ usedBy: null });

    // The invite travels in a cookie of its own; a start without one clears what an abandoned attempt left.
    const abandoned = await SELF.fetch(`${ORIGIN}/auth/github/login/start?invite=${unused}`, { redirect: "manual" });
    expect(abandoned.headers.getSetCookie().some((cookie) => cookie.startsWith(`github_login_invite=${unused};`))).toBe(true);
    const restarted = await SELF.fetch(`${ORIGIN}/auth/github/login/start`, { headers: { cookie: `github_login_invite=${unused}` }, redirect: "manual" });
    expect(restarted.headers.getSetCookie().some((cookie) => cookie.startsWith("github_login_invite=;"))).toBe(true);
  });
});

describe("GitHub-only accounts", () => {
  const NEW_PASSWORD = "first-ever-password";
  const PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
  let github: ReturnType<typeof fakeGitHub>;
  let admin: string;
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_app");
    // The pool shares D1 across the file, and every test here reuses the same GitHub ids.
    await env.DB.exec("UPDATE users SET github_login = NULL, github_user_id = NULL");
    github = fakeGitHub();
    admin = await signup(`gh-only-admin-${crypto.randomUUID()}@foxban.test`);
    await createGitHubApp(admin);
  });
  afterEach(() => github.restore());

  /** Someone who signed up with GitHub (`code` approves `account`): no password. Returns their session cookie and e-mail. */
  async function githubOnly(code: string, account: { id: number; login: string }): Promise<{ cookie: string; email: string }> {
    const email = `${account.login}@example.test`;
    github.accounts[code] = account;
    github.emails[code] = [githubEmail(email)];
    const cookie = signedInCookie(await logInWithGitHub(code, undefined, await mintInvite(admin)));
    expect(cookie).not.toBeNull();
    return { cookie: cookie!, email };
  }

  it("says in /me, login and signup whether the account has a password", async () => {
    const solo = await githubOnly("solo", { id: 720001, login: "solo" });
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: false });

    const signedUp = await post("/auth/signup", { email: "flagged@foxban.test", name: "Flagged", password: PASSWORD });
    expect(await signedUp.json()).toMatchObject({ hasPassword: true });
    expect(await (await get("/me", sessionCookie(signedUp))).json()).toMatchObject({ hasPassword: true });
    const login = await post("/auth/login", { email: "flagged@foxban.test", password: PASSWORD });
    expect(await login.json()).toMatchObject({ hasPassword: true });
  });

  it("refuses password login with the normal generic 401, whatever is typed", async () => {
    const solo = await githubOnly("solo", { id: 720002, login: "solo-login" });
    const unknown = await post("/auth/login", { email: "nobody-at-all@example.test", password: PASSWORD });
    for (const password of [PASSWORD, "*", "x"]) {
      const response = await post("/auth/login", { email: solo.email, password });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(await unknown.clone().json());
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("sets a password without a current one once GitHub has confirmed the account, rotating like a change: this session stays, the others go, and the password signs in", async () => {
    const solo = await githubOnly("solo", { id: 720003, login: "solo-set" });
    const otherSession = signedInCookie(await logInWithGitHub("solo"))!;
    expect((await get("/me", otherSession)).status).toBe(200);

    expect(await reauthWithGitHub(solo.cookie, "solo")).toBe("https://app.example/profile?github=reauthed");
    const set = await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true });

    expect((await get("/me", otherSession)).status).toBe(401);
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: true });
    const login = await post("/auth/login", { email: solo.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ hasPassword: true });
    // GitHub still signs in too.
    expect(signedInCookie(await logInWithGitHub("solo"))).not.toBeNull();
  });

  it("validates the new password like a change, and a refusal leaves the account without one", async () => {
    const solo = await githubOnly("solo", { id: 720004, login: "solo-weak" });
    const otherSession = signedInCookie(await logInWithGitHub("solo"))!;

    expect((await post("/auth/password", { newPassword: "11111111" }, solo.cookie)).status).toBe(400);
    expect((await post("/auth/password", {}, solo.cookie)).status).toBe(400);

    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: false });
    expect((await get("/me", otherSession)).status).toBe(200);
  });

  it("asks for the current password once there is one, answering the generic 401 when it is missing or wrong", async () => {
    const solo = await githubOnly("solo", { id: 720005, login: "solo-twice" });
    await reauthWithGitHub(solo.cookie, "solo");
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(200);

    for (const body of [{ newPassword: "second-password-try" }, { currentPassword: "wrong password", newPassword: "second-password-try" }]) {
      const response = await post("/auth/password", body, solo.cookie);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid credentials" });
    }
    expect((await post("/auth/login", { email: solo.email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await post("/auth/login", { email: solo.email, password: "second-password-try" })).status).toBe(401);

    // And an account that always had a password never gets to skip it.
    const classic = await signup("always-had-one@foxban.test");
    expect((await post("/auth/password", { newPassword: "second-password-try" }, classic)).status).toBe(401);
    expect((await post("/auth/login", { email: "always-had-one@foxban.test", password: PASSWORD })).status).toBe(200);
  });

  it("lets only one of two simultaneous first passwords win", async () => {
    const solo = await githubOnly("solo", { id: 720006, login: "solo-race" });
    await reauthWithGitHub(solo.cookie, "solo");
    const passwords = ["race-password-one", "race-password-two"];
    const results = await Promise.all(passwords.map((newPassword) => post("/auth/password", { newPassword }, solo.cookie)));

    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    const winner = passwords[results.findIndex((response) => response.status === 200)]!;
    const loser = passwords.find((password) => password !== winner)!;
    expect((await post("/auth/login", { email: solo.email, password: winner })).status).toBe(200);
    expect((await post("/auth/login", { email: solo.email, password: loser })).status).toBe(401);
  });

  it("refuses to disconnect GitHub until a password is set, changing nothing, and then allows it", async () => {
    const solo = await githubOnly("solo", { id: 720007, login: "solo-keep" });

    for (const body of [{ githubLogin: null }, { name: "Renamed", githubLogin: null }]) {
      const refused = await patch("/me", body, solo.cookie);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "set a password before disconnecting GitHub", code: PASSWORD_REQUIRED });
    }
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ name: "solo-keep", githubLogin: "solo-keep" });
    expect(signedInCookie(await logInWithGitHub("solo"))).not.toBeNull();
    // Only the disconnect is refused.
    expect((await patch("/me", { name: "Renamed" }, solo.cookie)).status).toBe(200);

    await reauthWithGitHub(solo.cookie, "solo");
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(200);
    const disconnected = await patch("/me", { githubLogin: null }, solo.cookie);
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({ githubLogin: null, hasPassword: true });
    expect((await post("/auth/login", { email: solo.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("refuses an email change until a password is set, before looking at the address, and then allows it", async () => {
    const solo = await githubOnly("solo", { id: 720008, login: "solo-mail" });
    const taken = "taken-by-someone@example.test";
    await signupWithInvite(taken, await mintInvite(admin));

    // A taken address and an admin address get the same answer as a free one: no password to prove, nothing to probe.
    for (const email of ["free-address@example.test", taken, "boss@foxban.test"]) {
      const refused = await post("/auth/email", { email, currentPassword: PASSWORD }, solo.cookie);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "set a password before changing your email", code: PASSWORD_REQUIRED });
    }
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ email: solo.email });

    await reauthWithGitHub(solo.cookie, "solo");
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(200);
    const changed = await post("/auth/email", { email: "free-address@example.test", currentPassword: NEW_PASSWORD }, solo.cookie);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ email: "free-address@example.test", hasPassword: true });
  });

  it("refuses a first password on the session alone: a stolen session cannot start the chain of set password, disconnect GitHub, link its own (ADR 0081)", async () => {
    const solo = await githubOnly("solo", { id: 720011, login: "solo-chain" });
    const otherSession = signedInCookie(await logInWithGitHub("solo"))!;

    const refused = await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "confirm with GitHub first", code: "GITHUB_REAUTH_REQUIRED" });

    // Nothing changed: no password, the other session still works, and so does the disconnect refusal that guarded the chain's second step.
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: false, githubLogin: "solo-chain" });
    expect((await get("/me", otherSession)).status).toBe(200);
    expect((await post("/auth/login", { email: solo.email, password: NEW_PASSWORD })).status).toBe(401);
    expect((await patch("/me", { githubLogin: null }, solo.cookie)).status).toBe(403);
  });

  it("writes no confirmation when GitHub approves a different account, so the first password stays refused", async () => {
    const solo = await githubOnly("solo", { id: 720012, login: "solo-mismatch" });
    github.accounts.thief = { id: 720013, login: "thief" };

    expect(await reauthWithGitHub(solo.cookie, "thief")).toBe("https://app.example/profile?github=reauth-error");
    expect(await storedReauth(solo.cookie)).toBeNull();
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(401);
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: false, githubLogin: "solo-mismatch" });
  });

  it("answers reauth-error when GitHub reports an error on a stored reauth state, not the generic error", async () => {
    const solo = await githubOnly("solo", { id: 720090, login: "solo-denied" });
    const start = await post("/auth/github/reauth", {}, solo.cookie);
    expect(start.status).toBe(200);
    const state = await linkState(start);

    const callback = await SELF.fetch(`${ORIGIN}/auth/github/callback?error=access_denied&state=${state}`, {
      headers: { cookie: `${solo.cookie}; github_oauth_state=${state}` },
      redirect: "manual",
    });
    expect(callback.headers.get("location")).toBe("https://app.example/profile?github=reauth-error");
    expect(await storedReauth(solo.cookie)).toBeNull();
  });

  it("accepts the confirmation once, for the session that earned it", async () => {
    const solo = await githubOnly("solo", { id: 720014, login: "solo-once" });
    const otherSession = signedInCookie(await logInWithGitHub("solo"))!;

    expect(await reauthWithGitHub(solo.cookie, "solo")).toBe("https://app.example/profile?github=reauthed");
    expect(await storedReauth(solo.cookie)).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await storedReauth(solo.cookie)).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    // Another session of the same account has not confirmed anything.
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, otherSession)).status).toBe(401);

    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(200);
    expect(await storedReauth(solo.cookie)).toBeNull();
    // Spent: a second attempt without a new confirmation is refused, and now it needs the current password too.
    expect((await post("/auth/password", { newPassword: "second-password-try" }, solo.cookie)).status).toBe(401);
    expect((await post("/auth/login", { email: solo.email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await post("/auth/login", { email: solo.email, password: "second-password-try" })).status).toBe(401);
  });

  it("lets the confirmation run out after ten minutes", async () => {
    const solo = await githubOnly("solo", { id: 720015, login: "solo-late" });
    await reauthWithGitHub(solo.cookie, "solo");
    await env.DB.prepare("UPDATE sessions SET github_reauth_until = ? WHERE id = ?").bind(Date.now() - 1, solo.cookie.slice("session=".length)).run();

    const refused = await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "GITHUB_REAUTH_REQUIRED" });
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ hasPassword: false });

    // A fresh confirmation works again.
    await reauthWithGitHub(solo.cookie, "solo");
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(200);
  });

  it("keeps the two purposes apart: a reauth state never links, and a link state never confirms", async () => {
    // A reauth for an account whose GitHub slot is empty: nothing to match, and it must not fill the slot.
    const solo = await githubOnly("solo", { id: 720016, login: "solo-empty" });
    await env.DB.prepare("UPDATE users SET github_login = NULL, github_user_id = NULL WHERE email = ?").bind(solo.email).run();
    expect(await reauthWithGitHub(solo.cookie, "solo")).toBe("https://app.example/profile?github=reauth-error");
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ githubLogin: null });
    expect(await storedReauth(solo.cookie)).toBeNull();
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, solo.cookie)).status).toBe(401);

    // A reauth that approves the right account follows no rename either: it is not a link.
    const owner = await githubOnly("owner", { id: 720017, login: "owner-before" });
    github.accounts.renamed = { id: 720017, login: "owner-after" };
    expect(await reauthWithGitHub(owner.cookie, "renamed")).toBe("https://app.example/profile?github=reauthed");
    expect(await (await get("/me", owner.cookie)).json()).toMatchObject({ githubLogin: "owner-before" });

    // A link state, completed by the owner's own GitHub account, links (follows the rename) and confirms nothing.
    const linker = await githubOnly("linker", { id: 720018, login: "linker-before" });
    github.accounts.linkerRenamed = { id: 720018, login: "linker-after" };
    expect(await connectGitHub(linker.cookie, "linkerRenamed", undefined)).toBe("https://app.example/profile");
    expect(await (await get("/me", linker.cookie)).json()).toMatchObject({ githubLogin: "linker-after" });
    expect(await storedReauth(linker.cookie)).toBeNull();
    expect((await post("/auth/password", { newPassword: NEW_PASSWORD }, linker.cookie)).status).toBe(401);

    // And a state is spent by one callback whichever purpose it carries.
    const start = await post("/auth/github/reauth", {}, owner.cookie);
    const state = await linkState(start);
    expect((await githubLinkCallback(owner.cookie, "renamed", state)).headers.get("location")).toBe("https://app.example/profile?github=reauthed");
    expect((await githubLinkCallback(owner.cookie, "renamed", state)).headers.get("location")).toBe("https://app.example/profile?github=error");
  });

  it("starts a reauthorization only for an account with no password, and only for a signed-in one", async () => {
    expect((await post("/auth/github/reauth", {})).status).toBe(401);

    const classic = await signup("has-a-password@foxban.test");
    const refused = await post("/auth/github/reauth", {}, classic);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "this account already has a password" });
    expect(await storedLinkState(classic)).toEqual({ hash: null, expiresAt: null });

    const solo = await githubOnly("solo", { id: 720019, login: "solo-start" });
    const start = await post("/auth/github/reauth", {}, solo.cookie);
    expect(start.status).toBe(200);
    const url = new URL((await start.json<{ url: string }>()).url);
    expect(url.origin).toBe("https://github.example");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/auth/github/callback");
    // The server keeps only a hash of the state, with the purpose it was started for.
    const stored = await env.DB.prepare("SELECT github_link_state_hash AS hash, github_link_purpose AS purpose FROM sessions WHERE id = ?")
      .bind(solo.cookie.slice("session=".length))
      .first();
    expect(stored).toEqual({ hash: await sha256Hex(url.searchParams.get("state")!), purpose: "reauth" });
  });

  it("cannot link a different GitHub account over its own, so the owner's GitHub login keeps working (ADR 0081)", async () => {
    const solo = await githubOnly("solo", { id: 720009, login: "solo-owner" });
    github.accounts.intruder = { id: 720010, login: "intruder" };
    github.emails.intruder = [];

    // No password to prove, so the link starts; the callback refuses to replace the id.
    expect(await connectGitHub(solo.cookie, "intruder", undefined)).toBe("https://app.example/profile?github=error");
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ githubLogin: "solo-owner" });
    const signedIn = signedInCookie(await logInWithGitHub("solo"));
    expect(await (await get("/me", signedIn!)).json()).toMatchObject({ email: solo.email });
    // The intruder's GitHub account signs in to nothing.
    const refused = await logInWithGitHub("intruder");
    expect(refused.headers.get("location")).toBe("https://app.example/login?github=unlinked");
    expect(signedInCookie(refused)).toBeNull();

    // The same account again is no clash: it follows a rename.
    github.accounts.renamed = { id: 720009, login: "solo-renamed" };
    expect(await connectGitHub(solo.cookie, "renamed", undefined)).toBe("https://app.example/profile");
    expect(await (await get("/me", solo.cookie)).json()).toMatchObject({ githubLogin: "solo-renamed" });
  });
});

describe("linking GitHub proves the account first (ADR 0081)", () => {
  let github: ReturnType<typeof fakeGitHub>;
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_app");
    // The pool shares D1 across the file, and every test here reuses the same GitHub ids.
    await env.DB.exec("UPDATE users SET github_login = NULL, github_user_id = NULL");
    github = fakeGitHub();
    await createGitHubApp(await signup(`gh-link-admin-${crypto.randomUUID()}@foxban.test`));
  });
  afterEach(() => github.restore());

  const githubIdOf = async (cookie: string) =>
    (await env.DB.prepare("SELECT github_user_id AS id FROM users WHERE id = ?").bind(await getUserId(cookie)).first<{ id: number | null }>())!.id;

  it("starts only with the current password, and stores no state for a refusal", async () => {
    const cookie = await signup("gh-pw@foxban.test", "Gh Pw");
    github.accounts.octo = { id: 730001, login: "octocat" };

    for (const password of [undefined, "wrong password", ""]) {
      const refused = await startGitHubLink(cookie, password);
      expect(refused.status).toBe(password === "" ? 400 : 401);
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(await storedLinkState(cookie)).toEqual({ hash: null, expiresAt: null });
    }
    // A callback has nothing to spend, even with a matching cookie and query.
    expect((await githubLinkCallback(cookie, "octo", "made-up-state")).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(cookie)).toBeNull();

    const start = await startGitHubLink(cookie, PASSWORD);
    expect(start.status).toBe(200);
    expect((await githubLinkCallback(cookie, "octo", await linkState(start))).headers.get("location")).toBe("https://app.example/profile");
    expect(await githubIdOf(cookie)).toBe(730001);
    expect(await storedLinkState(cookie)).toEqual({ hash: null, expiresAt: null });
  });

  it("answers 429 past the account's limit, as the password routes do", async () => {
    const cookie = await signup("gh-limit@foxban.test", "Gh Limit");
    const limited = { ...env, ACCOUNT_RATE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as typeof env;
    const response = await worker.fetch!(
      new Request(`${ORIGIN}/auth/github/link`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify({ currentPassword: PASSWORD }),
      }),
      limited,
      createExecutionContext(),
    );
    expect(response.status).toBe(429);
    expect(await storedLinkState(cookie)).toEqual({ hash: null, expiresAt: null });
  });

  it("refuses a state the browser made up, or one stored for another session, and writes no link", async () => {
    const owner = await signup("gh-forge@foxban.test", "Gh Forge");
    const attacker = sessionCookie(await post("/auth/login", { email: "gh-forge@foxban.test", password: PASSWORD }));
    github.accounts.attacker = { id: 730002, login: "attacker" };

    // Never called /auth/github/link: the cookie and the query agree, and that is all the attacker can arrange.
    expect((await githubLinkCallback(attacker, "attacker", "forged")).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(github.tokenRequests).toEqual([]);

    // The owner's own session started a link; another session of theirs cannot finish it, and cannot spend it.
    const state = await linkState(await startGitHubLink(owner, PASSWORD));
    expect((await githubLinkCallback(attacker, "attacker", state)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await storedLinkState(owner)).toMatchObject({ hash: await sha256Hex(state) });
    expect(await githubIdOf(owner)).toBeNull();

    // A state that is right but whose cookie is not (the double-submit pairing) fails too, and spends the stored one.
    const wrongCookie = await SELF.fetch(`${ORIGIN}/auth/github/callback?code=attacker&state=${state}`, {
      headers: { cookie: `${owner}; github_oauth_state=other` },
      redirect: "manual",
    });
    expect(wrongCookie.headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await storedLinkState(owner)).toEqual({ hash: null, expiresAt: null });
    expect(github.tokenRequests).toEqual([]);
  });

  it("spends the stored state once, whatever the callback does, and refuses it after it expires", async () => {
    const cookie = await signup("gh-once@foxban.test", "Gh Once");
    github.accounts.octo = { id: 730003, login: "octocat" };

    // A callback that fails at GitHub still spends it: the same state cannot be tried again with a good code.
    const failed = await linkState(await startGitHubLink(cookie, PASSWORD));
    expect((await githubLinkCallback(cookie, "refused", failed)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect((await githubLinkCallback(cookie, "octo", failed)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(cookie)).toBeNull();

    // A state that worked cannot be replayed.
    const used = await linkState(await startGitHubLink(cookie, PASSWORD));
    expect((await githubLinkCallback(cookie, "octo", used)).headers.get("location")).toBe("https://app.example/profile");
    github.accounts.other = { id: 730004, login: "other" };
    expect((await githubLinkCallback(cookie, "other", used)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(cookie)).toBe(730003);
    await patch("/me", { githubLogin: null }, cookie);

    // Past its ten minutes it is refused, and cleared.
    const stale = await linkState(await startGitHubLink(cookie, PASSWORD));
    await env.DB.prepare("UPDATE sessions SET github_link_expires_at = ? WHERE id = ?").bind(Date.now() - 1, cookie.slice("session=".length)).run();
    expect((await githubLinkCallback(cookie, "octo", stale)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(cookie)).toBeNull();
    expect(await storedLinkState(cookie)).toEqual({ hash: null, expiresAt: null });

    // A newer start replaces an older one: only the latest state works.
    const first = await linkState(await startGitHubLink(cookie, PASSWORD));
    const second = await linkState(await startGitHubLink(cookie, PASSWORD));
    expect((await githubLinkCallback(cookie, "octo", first)).headers.get("location")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(cookie)).toBeNull();
    // ...and a failed attempt spent the second one too, so it starts again.
    expect((await githubLinkCallback(cookie, "octo", second)).headers.get("location")).toBe("https://app.example/profile?github=error");
  });

  it("does not let a stolen session link its own GitHub account to sign back in after the owner changes the password", async () => {
    const stolen = await signup("gh-stolen@foxban.test", "Gh Stolen");
    const owner = sessionCookie(await post("/auth/login", { email: "gh-stolen@foxban.test", password: PASSWORD }));
    github.accounts.attacker = { id: 730005, login: "attacker" };
    github.emails.attacker = [];

    // The thief has the cookie and not the password: both ways to start or fake a link are closed.
    expect((await startGitHubLink(stolen)).status).toBe(401);
    expect((await startGitHubLink(stolen, "guess")).status).toBe(401);
    expect((await githubLinkCallback(stolen, "attacker", "forged")).headers.get("location")).toBe("https://app.example/profile?github=error");

    expect((await post("/auth/password", { currentPassword: PASSWORD, newPassword: "a brand new passphrase" }, owner)).status).toBe(200);
    expect((await get("/me", stolen)).status).toBe(401);

    const attempt = await logInWithGitHub("attacker");
    expect(attempt.headers.get("location")).toBe("https://app.example/login?github=unlinked");
    expect(signedInCookie(attempt)).toBeNull();
    expect(await githubIdOf(owner)).toBeNull();
  });

  it("keeps a linked account's id: a start with the password still cannot replace it, and a different account's id is a clash", async () => {
    const owner = await signup("gh-keep@foxban.test", "Gh Keep");
    const other = await signup("gh-keep-other@foxban.test", "Gh Keep Other");
    github.accounts.mine = { id: 730006, login: "mine" };
    github.accounts.theirs = { id: 730007, login: "theirs" };

    expect(await connectGitHub(owner, "mine")).toBe("https://app.example/profile");
    expect(await connectGitHub(owner, "theirs")).toBe("https://app.example/profile?github=error");
    expect(await githubIdOf(owner)).toBe(730006);
    expect(await connectGitHub(other, "mine")).toBe("https://app.example/profile?github=taken");
    expect(signedInCookie(await logInWithGitHub("mine"))).not.toBeNull();
  });
});

describe("board deletion", () => {
  it("enforces authentication and authorization on DELETE /boards/:id", async () => {
    const owner = await signup("board-del-owner@foxban.test", "Owner");
    const boardId = await createBoard(owner, "Delete Auth Board");
    const invite1 = await mintInvite(owner);
    const member = await signupWithInvite("board-del-member@user.test", invite1, "Member");
    const invite2 = await mintInvite(owner);
    const stranger = await signupWithInvite("board-del-stranger@user.test", invite2, "Stranger");
    const admin = await signup("board-del-admin@foxban.test", "Admin");
    // Add member to board
    const memberId = await getUserId(member);
    const addRes = await post(`/boards/${boardId}/members`, { userId: memberId }, owner);
    expect(addRes.status).toBe(200);

    // 1. Unauthenticated DELETE returns 401
    const unauth = await del(`/boards/${boardId}`);
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "unauthorized" });

    // 2. Invited non-owner returns 403 and board remains listed
    const memberDel = await del(`/boards/${boardId}`, member);
    expect(memberDel.status).toBe(403);
    expect(await memberDel.json()).toEqual({ error: "forbidden" });

    const memberList = await get("/boards", member);
    expect(memberList.status).toBe(200);
    const memberBoards = await memberList.json<{ id: string }[]>();
    expect(memberBoards.some((b) => b.id === boardId)).toBe(true);

    // 3. Stranger returns 403 and board remains listed for owner
    const strangerDel = await del(`/boards/${boardId}`, stranger);
    expect(strangerDel.status).toBe(403);
    expect(await strangerDel.json()).toEqual({ error: "forbidden" });

    const ownerList = await get("/boards", owner);
    expect(ownerList.status).toBe(200);
    const ownerBoards = await ownerList.json<{ id: string }[]>();
    expect(ownerBoards.some((b) => b.id === boardId)).toBe(true);

    // 4. An admin outside board_members deletes another user's board successfully
    const adminDel = await del(`/boards/${boardId}`, admin);
    expect(adminDel.status).toBe(200);
    expect(await adminDel.json()).toEqual({ ok: true });

    // 5. Afterward owner/member/admin board lists omit it
    const ownerListAfter = await get("/boards", owner);
    const memberListAfter = await get("/boards", member);
    const adminListAfter = await get("/boards", admin);
    expect((await ownerListAfter.json<{ id: string }[]>()).some((b) => b.id === boardId)).toBe(false);
    expect((await memberListAfter.json<{ id: string }[]>()).some((b) => b.id === boardId)).toBe(false);
    expect((await adminListAfter.json<{ id: string }[]>()).some((b) => b.id === boardId)).toBe(false);

    // 6. Direct GET /boards/:id is refused (403 for ordinary user, 403 for admin since requireMember handles it)
    const directGetOwner = await get(`/boards/${boardId}`, owner);
    expect(directGetOwner.status).toBe(403);
    const directGetAdmin = await get(`/boards/${boardId}`, admin);
    expect(directGetAdmin.status).toBe(403);

    // 7. Missing id returns 404
    const missingId = crypto.randomUUID();
    const missingDel = await del(`/boards/${missingId}`, admin);
    expect(missingDel.status).toBe(404);
    expect(await missingDel.json()).toEqual({ error: "board not found" });

    // 8. Second delete on deleted board returns 404 and does not recreate data
    const secondDel = await del(`/boards/${boardId}`, admin);
    expect(secondDel.status).toBe(404);
    expect(await secondDel.json()).toEqual({ error: "board not found" });

    const boardsCount = await env.DB.prepare("SELECT COUNT(*) as count FROM boards WHERE id = ?").bind(boardId).first<{ count: number }>();
    expect(boardsCount?.count).toBe(0);
    const membersCount = await env.DB.prepare("SELECT COUNT(*) as count FROM board_members WHERE board_id = ?").bind(boardId).first<{ count: number }>();
    expect(membersCount?.count).toBe(0);
  });
});

describe("column management authorization", () => {
  it("limits all structure mutations to this board's owner and outside admins without restricting card collaboration", async () => {
    const admin = await signup("column-rights-admin@foxban.test");
    const owner = await signupWithInvite("column-rights-owner@user.test", await mintInvite(admin));
    const member = await signupWithInvite("column-rights-member@user.test", await mintInvite(admin));
    const stranger = await signupWithInvite("column-rights-stranger@user.test", await mintInvite(admin));
    const ownerUser = await (await get("/me", owner)).json<{ id: string; isAdmin: boolean }>();
    const memberUser = await (await get("/me", member)).json<{ id: string; isAdmin: boolean }>();
    const adminUser = await (await get("/me", admin)).json<{ id: string; isAdmin: boolean }>();
    expect(ownerUser.isAdmin).toBe(false);
    expect(memberUser.isAdmin).toBe(false);
    expect(adminUser.isAdmin).toBe(true);
    const board = await createBoard(owner, "Column rights");
    const otherBoard = await createBoard(member, "Member's own board");
    expect((await post(`/boards/${board}/members`, { userId: memberUser.id }, owner)).status).toBe(200);
    const membership = await env.DB.prepare("SELECT user_id AS id FROM board_members WHERE board_id = ?").bind(board).all<{ id: string }>();
    expect(membership.results.map(({ id }) => id).sort()).toEqual([ownerUser.id, memberUser.id].sort());
    const route = `/boards/${board}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`;
    expect((await get(route, stranger, { Upgrade: "websocket" })).status).toBe(403);

    const sockets: WebSocket[] = [];
    async function connect(cookie: string, headers: Record<string, string> = {}, boardId = board) {
      const response = await get(`/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, cookie, { Upgrade: "websocket", ...headers });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      sockets.push(socket);
      const queue: ServerMessage[] = [];
      const waiters: Array<(message: ServerMessage) => void> = [];
      socket.addEventListener("message", (event: MessageEvent) => {
        const message = ServerMessageSchema.parse(JSON.parse(event.data as string));
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      });
      socket.accept();
      return {
        send(message: unknown) { socket.send(JSON.stringify(message)); },
        next(): Promise<ServerMessage> {
          const queued = queue.shift();
          return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
        },
      };
    }
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    try {
      const manager = await connect(owner);
      expect((await manager.next()).type).toBe("snapshot");
      const outside = await connect(admin);
      await outside.next();
      const collaborator = await connect(member, {
        "x-foxban-user-id": ownerUser.id,
        "x-foxban-board-id": otherBoard,
        "x-foxban-can-manage-columns": "true",
      });
      await collaborator.next();
      const seed = { type: "column.create", mutationId: "seed", id: "todo", title: "Todo", position: "a0" };
      manager.send(seed);
      expect(await manager.next()).toEqual(seed);
      expect(await outside.next()).toEqual(seed);
      expect(await collaborator.next()).toEqual(seed);
      const done = { ...seed, mutationId: "done", id: "done", title: "Done", position: "a1" };
      manager.send(done);
      expect(await manager.next()).toEqual(done);
      expect(await outside.next()).toEqual(done);
      expect(await collaborator.next()).toEqual(done);
      for (const [index, actor] of [manager, outside].entries()) {
        for (const mutation of [
          { type: "column.create", id: `managed-${index}`, title: "Managed", position: "a2" },
          { type: "column.rename", id: `managed-${index}`, title: "Renamed" },
          { type: "column.move", id: `managed-${index}`, position: "Zz" },
          { type: "column.delete", id: `managed-${index}` },
        ]) {
          const message = { ...mutation, mutationId: crypto.randomUUID() };
          actor.send(message);
          expect(await manager.next()).toEqual(message);
          expect(await outside.next()).toEqual(message);
          expect(await collaborator.next()).toEqual(message);
          const probe = await connect(owner);
          const snapshot = await probe.next();
          expect(snapshot.type).toBe("snapshot");
          if (snapshot.type !== "snapshot") throw new Error("expected snapshot");
          const column = snapshot.columns.find(({ id }) => id === mutation.id);
          if (mutation.type === "column.delete") expect(column).toBeUndefined();
          else expect(column).toMatchObject(
            mutation.type === "column.move" ? { position: "Zz" } : { title: mutation.title },
          );
        }
      }
      const other = await connect(member, {}, otherBoard);
      const otherBaseline = await other.next();
      const seedCard = { type: "card.create", mutationId: "seed-card", id: "card", columnId: "todo", title: "Active", position: "a0" };
      collaborator.send(seedCard);
      for (const peer of [manager, outside, collaborator]) {
        expect(await peer.next()).toEqual(seedCard);
        expect(await peer.next()).toMatchObject({ type: "card.numbered", mutationId: "seed-card" });
        expect(await peer.next()).toMatchObject({
          type: "activity.recorded", mutationId: "seed-card",
          activities: [expect.objectContaining({ actorId: memberUser.id })],
        });
      }
      const denied = [
        { type: "column.create", id: "denied", title: "Denied", position: "a2" },
        { type: "column.rename", id: "todo", title: "Denied" },
        { type: "column.move", id: "todo", position: "a3" },
        { type: "column.delete", id: "todo" },
      ];
      for (const [index, mutation] of denied.entries()) {
        const before = await (await connect(owner)).next();
        const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
        const message = { ...mutation, mutationId: `denied-${index}` };
        collaborator.send(message);
        expect(await collaborator.next()).toEqual({
          type: "error", mutationId: message.mutationId,
          message: "Only the board owner or an admin can change columns.",
        });
        expect(await (await connect(owner)).next()).toEqual(before);
        expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarm);
        // This accepted card's complete tail is an ordered barrier. Inspect every
        // peer frame, rather than discarding frames while seeking the barrier.
        const barrier = { type: "card.create", mutationId: `barrier-${index}`, id: `barrier-${index}`, columnId: "done", title: `Barrier ${index}`, position: `a${index}` };
        collaborator.send(barrier);
        for (const peer of [manager, outside, collaborator]) {
          const frames = [await peer.next(), await peer.next(), await peer.next()];
          expect(frames).toEqual([
            barrier,
            expect.objectContaining({ type: "card.numbered", mutationId: barrier.mutationId }),
            expect.objectContaining({ type: "activity.recorded", mutationId: barrier.mutationId,
              activities: [expect.objectContaining({ actorId: memberUser.id })] }),
          ]);
        }
      }
      for (const extra of [{ canManageColumns: true }, { userId: ownerUser.id }, { boardId: otherBoard }]) {
        collaborator.send({ ...denied[0], mutationId: "strict-denial", ...extra });
        expect(await collaborator.next()).toMatchObject({ type: "error", mutationId: "strict-denial" });
      }
      for (const mutation of [
        { type: "card.update", mutationId: "edit-card", id: "card", title: "Member edited" },
        { type: "card.move", mutationId: "move-card", id: "card", columnId: "done", position: "a9" },
      ]) {
        collaborator.send(mutation);
        for (const peer of [manager, outside, collaborator]) {
          expect(await peer.next()).toEqual(mutation);
          expect(await peer.next()).toMatchObject({ type: "activity.recorded", mutationId: mutation.mutationId });
        }
      }
      const persisted = await (await connect(member)).next();
      expect(persisted).toMatchObject({
        columns: [{ id: "todo", title: "Todo", position: "a0" }, { id: "done", title: "Done", position: "a1" }],
        cards: expect.arrayContaining([expect.objectContaining({ id: "card", title: "Member edited", columnId: "done", position: "a9" })]),
        archivedCards: [],
      });
      expect(await (await connect(member, {}, otherBoard)).next()).toEqual(otherBaseline);
    } finally {
      for (const socket of sockets) socket.close(1000, "test finished");
    }
  });
});

describe("board metadata editing", () => {
  it("enforces authentication, authorization, validation, duplicate prevention, and observable updates on PATCH /boards/:id", async () => {
    const admin = await signup("board-patch-admin@foxban.test", "Admin");
    const owner = await signupWithInvite(
      "board-patch-owner@user.test", await mintInvite(admin), "Owner",
    );
    const invite1 = await mintInvite(admin);
    const member = await signupWithInvite("board-patch-member@user.test", invite1, "Member");
    const invite2 = await mintInvite(admin);
    const stranger = await signupWithInvite("board-patch-stranger@user.test", invite2, "Stranger");
    expect(await (await get("/me", owner)).json()).toMatchObject({ isAdmin: false });
    expect(await (await get("/me", member)).json()).toMatchObject({ isAdmin: false });
    expect(await (await get("/me", admin)).json()).toMatchObject({ isAdmin: true });

    // Create two boards with known initial keys
    const targetBoardId = await createBoard(owner, "Original Target Board", "TARGET1");
    await createBoard(owner, "Other Existing Board", "EXISTING1");

    // Add member to target board
    const patchMemberId = await getUserId(member);
    const addRes = await post(`/boards/${targetBoardId}/members`, { userId: patchMemberId }, owner);
    expect(addRes.status).toBe(200);

    // 1. Unauthenticated PATCH returns 401
    const unauth = await patch(`/boards/${targetBoardId}`, { name: "New Name", key: "NEWKEY1" });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "unauthorized" });

    // 2. Missing board returns 404 for authorized users
    const missingId = crypto.randomUUID();
    const missingOwner = await patch(`/boards/${missingId}`, { name: "Ghost", key: "GHOST1" }, owner);
    expect(missingOwner.status).toBe(404);
    expect(await missingOwner.json()).toEqual({ error: "board not found" });

    const missingAdmin = await patch(`/boards/${missingId}`, { name: "Ghost", key: "GHOST1" }, admin);
    expect(missingAdmin.status).toBe(404);
    expect(await missingAdmin.json()).toEqual({ error: "board not found" });

    // 3. Ordinary member returns 403 and leaves board unchanged
    const memberPatch = await patch(`/boards/${targetBoardId}`, { name: "Hacked by Member", key: "MEMBER1" }, member);
    expect(memberPatch.status).toBe(403);
    expect(await memberPatch.json()).toEqual({ error: "forbidden" });
    expect(await (await get(`/boards/${targetBoardId}`, owner)).json()).toMatchObject({
      name: "Original Target Board", key: "TARGET1",
    });

    // 4. Stranger (non-member) returns 403 and leaves board unchanged
    const strangerPatch = await patch(`/boards/${targetBoardId}`, { name: "Hacked by Stranger", key: "STRANGER1" }, stranger);
    expect(strangerPatch.status).toBe(403);
    expect(await strangerPatch.json()).toEqual({ error: "forbidden" });
    expect(await (await get(`/boards/${targetBoardId}`, owner)).json()).toMatchObject({
      name: "Original Target Board", key: "TARGET1",
    });

    // 5. Validation failures return 400 and leave board unchanged
    // Invalid blank name, whitespace-only name, too-long name (>200 chars)
    const invalidNames = ["", "   ", "A".repeat(201)];
    for (const badName of invalidNames) {
      const badNameRes = await patch(`/boards/${targetBoardId}`, { name: badName, key: "VALID1" }, owner);
      expect(badNameRes.status).toBe(400);
    }

    // Invalid keys: starts with digit, too short (1 char), invalid chars, too long (>10 chars), whitespace-only
    const invalidKeys = ["1START", "T", "BAD_KEY", "TOOLONGKEY12", "   "];
    for (const badKey of invalidKeys) {
      const badKeyRes = await patch(`/boards/${targetBoardId}`, { name: "Valid Name", key: badKey }, owner);
      expect(badKeyRes.status).toBe(400);
    }

    // 6. Duplicate normalized key returns exact 409 and leaves BOTH original fields unchanged
    // Existing board has key "EXISTING1". Try to update targetBoardId with "existing1" and lowercase/spaced variations
    const dupPatch = await patch(
      `/boards/${targetBoardId}`,
      { name: "Attempted Name Change", key: "  existing1  " },
      owner,
    );
    expect(dupPatch.status).toBe(409);
    expect(await dupPatch.json()).toEqual({ error: "board key already exists" });

    // Verify both original fields remain unchanged in D1
    const rowAfterDup = await env.DB.prepare(
      "SELECT id, name, board_key AS key, owner_id AS ownerId FROM boards WHERE id = ?",
    )
      .bind(targetBoardId)
      .first<{ id: string; name: string; key: string; ownerId: string }>();
    expect(rowAfterDup?.name).toBe("Original Target Board");
    expect(rowAfterDup?.key).toBe("TARGET1");

    // 7. Owner can atomically change name and key with normalization
    const ownerSuccess = await patch(
      `/boards/${targetBoardId}`,
      { name: "  Owner Updated Name  ", key: "  renamed1  " },
      owner,
    );
    expect(ownerSuccess.status).toBe(200);
    expect(await ownerSuccess.json()).toEqual({
      id: targetBoardId,
      name: "Owner Updated Name",
      key: "RENAMED1",
      ownerId: expect.any(String),
      icon: "square-kanban",
      color: "amber",
      workspaceId: expect.stringMatching(/^personal_/),
      workspaceName: expect.stringMatching(/'s workspace$/),
      accessMode: "restricted",
      // The explicit board-member add earlier in this test consumed generation 0:
      // a successful membership change advances the board's policy version, which
      // is what keeps D1 and the board's own generation in lockstep.
      accessVersion: 1,
      capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
      viaWorkspaceAdmin: false,
    });

    // Observable reads after owner update:
    // Direct GET /boards/:id for member reflects updated values
    const memberGetAfterOwner = await get(`/boards/${targetBoardId}`, member);
    expect(memberGetAfterOwner.status).toBe(200);
    expect(await memberGetAfterOwner.json()).toMatchObject({
      id: targetBoardId,
      name: "Owner Updated Name",
      key: "RENAMED1",
    });

    // List GET /boards for owner reflects updated values
    const ownerList = await get("/boards", owner);
    expect(ownerList.status).toBe(200);
    const ownerBoards = await ownerList.json<Array<{ id: string; name: string; key: string }>>();
    const updatedInList = ownerBoards.find((b) => b.id === targetBoardId);
    expect(updatedInList).toEqual(
      expect.objectContaining({
        id: targetBoardId,
        name: "Owner Updated Name",
        key: "RENAMED1",
      }),
    );

    // 8. Admin outside board_members can atomically change name and key
    const adminSuccess = await patch(
      `/boards/${targetBoardId}`,
      { name: "Admin Renamed Board", key: "ADMINMOD1" },
      admin,
    );
    expect(adminSuccess.status).toBe(200);
    expect(await adminSuccess.json()).toEqual({
      id: targetBoardId,
      name: "Admin Renamed Board",
      key: "ADMINMOD1",
      ownerId: expect.any(String),
      icon: "square-kanban",
      color: "amber",
      workspaceId: expect.stringMatching(/^personal_/),
      workspaceName: expect.stringMatching(/'s workspace$/),
      accessMode: "restricted",
      accessVersion: 1,
      capabilities: { canManageBoard: true, canManageColumns: true, canManageMembers: true },
      viaWorkspaceAdmin: false,
    });

    // List GET /boards for admin, reading the workspace they operate, reflects updated values
    const { workspaceId: operatedWorkspaceId } = await (await get(`/boards/${targetBoardId}`, admin)).json<{ workspaceId: string }>();
    const adminList = await get(`/boards?workspaceId=${operatedWorkspaceId}`, admin);
    expect(adminList.status).toBe(200);
    const adminBoards = await adminList.json<Array<{ id: string; name: string; key: string }>>();
    const updatedInAdminList = adminBoards.find((b) => b.id === targetBoardId);
    expect(updatedInAdminList).toEqual(
      expect.objectContaining({
        id: targetBoardId,
        name: "Admin Renamed Board",
        key: "ADMINMOD1",
      }),
    );

    // Direct GET /boards/:id for owner reflects admin's update
    const ownerGetAfterAdmin = await get(`/boards/${targetBoardId}`, owner);
    expect(ownerGetAfterAdmin.status).toBe(200);
    expect(await ownerGetAfterAdmin.json()).toMatchObject({
      id: targetBoardId,
      name: "Admin Renamed Board",
      key: "ADMINMOD1",
    });
  });
});

describe("inherited management boundaries", () => {
  /**
   * A Private board inside a shared workspace, where `actor` is a plain workspace
   * member and holds the explicit manager grant the route's capability read accepts.
   * (A workspace admin keeps management of a Private board without any grant, so
   * the race below needs someone whose only authority is the grant.)
   */
  async function restrictedBoardWithManager() {
    const owner = await signup(`mgmt-owner-${crypto.randomUUID()}@foxban.test`, "Mgmt Owner");
    const actor = await signupWithInvite(
      `mgmt-manager-${crypto.randomUUID()}@user.test`,
      await mintInvite(owner),
      "Mgmt Manager",
    );
    const created = await post("/workspaces", { name: "Shared home" }, owner);
    expect(created.status).toBe(201);
    const workspaceId = (await created.json<{ workspace: { id: string } }>()).workspace.id;
    const invitation = await post(`/workspaces/${workspaceId}/invites`, { role: "member" }, owner);
    const { token } = await invitation.json<{ token: string }>();
    expect(
      (
        await post(
          `/workspaces/${workspaceId}/invites/accept`,
          { token, operationId: crypto.randomUUID() },
          actor,
        )
      ).status,
    ).toBe(200);
    const board = await post(
      "/boards",
      {
        name: "Restricted board",
        key: `R${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        workspaceId,
        accessMode: "restricted",
      },
      owner,
    );
    expect(board.status).toBe(200);
    const row = await board.json<{ id: string; key: string }>();
    const actorId = await getUserId(actor);
    await env.DB.prepare(`INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`)
      .bind(row.id, actorId)
      .run();
    return { owner, actor, actorId, workspaceId, boardId: row.id, boardKey: row.key };
  }

  /**
   * Revokes the explicit grant once the authorized board read has answered, so the
   * request goes on holding a capability the protected write may no longer use — the
   * race the write's own predicate, and only that predicate, can catch.
   */
  function revokeAfterBoardRead(revoke: () => Promise<unknown>): () => void {
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    // @ts-expect-error test stubbing
    env.DB.prepare = (query: string) => {
      const stmt = originalPrepare(query);
      if (
        !armed ||
        !(query.includes("wm.role AS workspaceRole") && query.includes("JOIN workspaces ON workspaces.id=boards.workspace_id"))
      ) {
        return stmt;
      }
      return {
        ...stmt,
        bind(...params: unknown[]) {
          const bound = stmt.bind(...params);
          const readRow = bound.first.bind(bound) as () => Promise<unknown>;
          return {
            ...bound,
            async first() {
              const row = await readRow();
              if (armed) {
                armed = false;
                await revoke();
              }
              return row;
            },
          };
        },
      };
    };
    return () => {
      env.DB.prepare = originalPrepare;
    };
  }

  it("refuses a metadata write whose explicit grant is revoked while the capability read is out", async () => {
    const { actor, actorId, boardId, boardKey } = await restrictedBoardWithManager();
    const restore = revokeAfterBoardRead(() =>
      env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?")
        .bind(boardId, actorId)
        .run(),
    );
    try {
      const refused = await patch(
        `/boards/${boardId}`,
        { name: "Renamed by a revoked manager", key: boardKey },
        actor,
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "forbidden" });
    } finally {
      restore();
    }
    // A plain workspace member inherits nothing on a Private board, so the write
    // predicate refused the actor the earlier capability read had accepted.
    expect(
      (await env.DB.prepare("SELECT name FROM boards WHERE id=?").bind(boardId).first<{ name: string }>())
        ?.name,
    ).toBe("Restricted board");
  });

  it("answers pending board metadata with a retry while list reads stay coherent", async () => {
    const owner = await signup(`pending-owner-${crypto.randomUUID()}@foxban.test`, "Pending Owner");
    const boardKey = `P${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const boardId = await createBoard(owner, "Pending board", boardKey);
    expect((await get(`/boards/by-key/${boardKey}`, owner)).status).toBe(200);

    await env.DB.prepare("UPDATE boards SET pending_access_operation_id=? WHERE id=?")
      .bind("pending-op", boardId)
      .run();

    // The protected metadata reads report the fence instead of a fresh timestamp that
    // the reconnect planner would take for a released boundary.
    const pending = await get(`/boards/by-key/${boardKey}`, owner);
    expect(pending.status).toBe(503);
    expect(pending.headers.get("retry-after")).toBe("2");
    expect(await pending.json()).toMatchObject({ code: "access_change_pending" });
    expect((await get(`/boards/${boardId}`, owner)).status).toBe(503);

    // Lists and counts stay coherent: the board is still there for the viewer who has it.
    const list = await get("/boards", owner);
    expect(list.status).toBe(200);
    expect((await list.json<Array<{ id: string }>>()).map((row) => row.id)).toContain(boardId);
    const workspaces = await get("/workspaces", owner);
    const entry = (
      await workspaces.json<{ workspaces: Array<{ boardCount: number }> }>()
    ).workspaces.find((workspace) => workspace.boardCount > 0);
    expect(entry?.boardCount).toBe(1);

    await env.DB.prepare("UPDATE boards SET pending_access_operation_id=NULL WHERE id=?")
      .bind(boardId)
      .run();
    const released = await get(`/boards/by-key/${boardKey}`, owner);
    expect(released.status).toBe(200);
    expect(await released.json()).not.toHaveProperty("pendingAccessChange");
  });
});

describe("user avatar endpoints and lifecycle", () => {
  const PNG_1X1 = Uint8Array.of(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
    0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  );

  async function uploadAvatar(cookie: string, body: Uint8Array | ArrayBuffer, contentType = "image/png"): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/me/avatar`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        cookie,
      },
      body,
    });
  }

  it("rejects unauthenticated avatar requests", async () => {
    const unauthPost = await uploadAvatar("", PNG_1X1);
    expect(unauthPost.status).toBe(401);

    const unauthDelete = await del("/me/avatar");
    expect(unauthDelete.status).toBe(401);

    const unauthGet = await get(`/users/${crypto.randomUUID()}/avatar/${crypto.randomUUID()}`);
    expect(unauthGet.status).toBe(401);
  });

  it("rejects unsupported MIME types, empty payloads, and oversized avatars", async () => {
    const cookie = await signup("avatar-validation@foxban.test", "Avatar User");

    // Unsupported MIME type
    const textRes = await uploadAvatar(cookie, new TextEncoder().encode("not an image"), "text/plain");
    expect(textRes.status).toBe(415);

    // Empty body
    const emptyRes = await uploadAvatar(cookie, new Uint8Array(0), "image/png");
    expect(emptyRes.status).toBe(400);

    // Oversized body (>10 MiB)
    const bigBody = new Uint8Array(10 * 1024 * 1024 + 1);
    const bigRes = await uploadAvatar(cookie, bigBody, "image/png");
    expect(bigRes.status).toBe(413);
  });

  it("refuses an avatar whose content-length is over the limit before reading the body", async () => {
    const cookie = await signup("avatar-declared-length@foxban.test", "Declared Length");
    // A one-byte body: only the declared length can trigger the 413.
    const res = await SELF.fetch(`${ORIGIN}/me/avatar`, {
      method: "POST",
      headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1), cookie },
      body: new Uint8Array(1),
    });
    expect(res.status).toBe(413);
  });

  it("uploads an avatar, projects avatarVersion on /me and members, serves immutable binary with nosniff, replaces it, and supports idempotent delete", async () => {
    const userCookie = await signup("avatar-lifecycle@foxban.test", "Lifecycle User");
    const userId = await getUserId(userCookie);

    // Initial user has avatarVersion: null
    const initialMe = await (await get("/me", userCookie)).json<{ avatarVersion: string | null }>();
    expect(initialMe.avatarVersion).toBeNull();

    // 1. Upload valid PNG
    const uploadRes = await uploadAvatar(userCookie, PNG_1X1, "image/png");
    expect(uploadRes.status).toBe(200);
    const updatedMe = await uploadRes.json<{ avatarVersion: string | null }>();
    expect(updatedMe.avatarVersion).toBeTruthy();
    const version1 = updatedMe.avatarVersion!;

    // R2 has object at avatars/{userId}/{version1}
    const r2Key1 = `avatars/${userId}/${version1}`;
    const storedObject1 = await env.ATTACHMENTS.get(r2Key1);
    expect(storedObject1).not.toBeNull();
    expect(storedObject1?.httpMetadata?.contentType).toBe("image/png");

    // /me reflects avatarVersion
    const meAfterUpload = await (await get("/me", userCookie)).json<{ avatarVersion: string | null }>();
    expect(meAfterUpload.avatarVersion).toBe(version1);

    // Board members list reflects avatarVersion and isAdmin
    const boardId = await createBoard(userCookie, "Avatar Board");
    const membersRes = await get(`/boards/${boardId}/members`, userCookie);
    expect(membersRes.status).toBe(200);
    const membersData = await membersRes.json<{ members: Array<{ id: string; avatarVersion: string | null; isAdmin: boolean }> }>();
    const memberRow = membersData.members.find((m) => m.id === userId);
    expect(memberRow?.avatarVersion).toBe(version1);
    expect(memberRow?.isAdmin).toBe(true);

    // Candidates projection reflects avatarVersion
    const otherOwner = await signup("candidate-board-owner@foxban.test");
    const candBoardId = await createBoard(otherOwner, "Cand Board");
    // Candidates are the board's workspace members, so the avatar's owner joins that workspace.
    await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'member',0,0)")
      .bind(await firstWorkspaceId(otherOwner), userId)
      .run();
    const candRes = await get(`/boards/${candBoardId}/membership-candidates`, otherOwner);
    expect(candRes.status).toBe(200);
    const candData = await candRes.json<{ candidates: Array<{ id: string; avatarVersion: string | null }> }>();
    const candidateRow = candData.candidates.find((c) => c.id === userId);
    expect(candidateRow?.avatarVersion).toBe(version1);

    // 2. GET /users/:userId/avatar/:version serves the image with correct caching & security headers
    const serveRes = await get(`/users/${userId}/avatar/${version1}`, userCookie);
    expect(serveRes.status).toBe(200);
    expect(serveRes.headers.get("content-type")).toBe("image/png");
    expect(serveRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(serveRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const servedBytes = new Uint8Array(await serveRes.arrayBuffer());
    expect(servedBytes).toEqual(PNG_1X1);

    // GET with wrong/stale version returns 404
    const staleRes = await get(`/users/${userId}/avatar/stale-version-id`, userCookie);
    expect(staleRes.status).toBe(404);

    // 3. Upload replacement avatar: deletes prior R2 object and updates users.avatar_version
    const WEBP_BYTES = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    const replaceRes = await uploadAvatar(userCookie, WEBP_BYTES, "image/webp");
    expect(replaceRes.status).toBe(200);
    const replacedMe = await replaceRes.json<{ avatarVersion: string | null }>();
    expect(replacedMe.avatarVersion).toBeTruthy();
    expect(replacedMe.avatarVersion).not.toBe(version1);
    const version2 = replacedMe.avatarVersion!;

    // Prior object deleted, new object present
    expect(await env.ATTACHMENTS.get(r2Key1)).toBeNull();
    const r2Key2 = `avatars/${userId}/${version2}`;
    expect(await env.ATTACHMENTS.get(r2Key2)).not.toBeNull();

    // Old version GET returns 404
    const oldGet = await get(`/users/${userId}/avatar/${version1}`, userCookie);
    expect(oldGet.status).toBe(404);
    // New version GET returns 200
    const newGet = await get(`/users/${userId}/avatar/${version2}`, userCookie);
    expect(newGet.status).toBe(200);
    expect(newGet.headers.get("content-type")).toBe("image/webp");

    // 4. DELETE /me/avatar deletes R2 object and resets avatarVersion to null
    const deleteRes = await del("/me/avatar", userCookie);
    expect(deleteRes.status).toBe(200);
    const deletedMe = await deleteRes.json<{ avatarVersion: string | null }>();
    expect(deletedMe.avatarVersion).toBeNull();
    expect(await env.ATTACHMENTS.get(r2Key2)).toBeNull();

    // Idempotent DELETE when already null returns 200 with null avatarVersion
    const repeatDelete = await del("/me/avatar", userCookie);
    expect(repeatDelete.status).toBe(200);
    const repeatDeletedMe = await repeatDelete.json<{ avatarVersion: string | null }>();
    expect(repeatDeletedMe.avatarVersion).toBeNull();
  });

  it("cleans up new R2 object if D1 update fails (compensation on failure)", async () => {
    const cookie = await signup("avatar-fail@foxban.test", "Fail User");
    const userId = await getUserId(cookie);

    // Intentionally corrupt D1 to simulate a database failure (e.g. invalid query or missing column)
    // In SQLite/D1, dropping a column or putting an invalid schema state forces the UPDATE to throw
    // We can simulate this by temporarily altering table or passing an impossible operation,
    // or testing the plan's exact rule: "If D1 update fails, delete the newly written key and return 500"
    // When we corrupt the users table definition:
    await env.DB.prepare("DROP INDEX IF EXISTS idx_users_email").run();
    // Add a CHECK constraint that always fails on avatar_version update
    await env.DB.prepare("CREATE TRIGGER fail_avatar_update BEFORE UPDATE OF avatar_version ON users BEGIN SELECT RAISE(FAIL, 'simulated d1 failure'); END;").run();

    try {
      const failRes = await uploadAvatar(cookie, PNG_1X1, "image/png");
      // Expect 500 per approved plan ("If D1 update fails, delete the newly written key and return 500")
      // Atomic CAS multi-statement batch returns 409 on conflict/failure
      expect(failRes.status).toBe(409);

      // Ensure the newly written avatar object in R2 was cleaned up (compensated)
      const listed = await env.ATTACHMENTS.list({ prefix: `avatars/${userId}/` });
      expect(listed.objects.length).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_avatar_update").run();
    }
  });

  it("retains committed avatar if prior R2 object deletion fails, and returns authoritative user if DELETE CAS loses race", async () => {
    const cookie = await signup("avatar-resilience@foxban.test", "Resilience User");
    const userId = await getUserId(cookie);

    // 1. Upload initial avatar
    const res1 = await uploadAvatar(cookie, PNG_1X1, "image/png");
    expect(res1.status).toBe(200);
    const body1 = await res1.json<{ avatarVersion: string }>();
    const version1 = body1.avatarVersion;

    // Spy or intercept R2 delete to throw during replace
    const originalDelete = env.ATTACHMENTS.delete.bind(env.ATTACHMENTS);
    let deleteCalled = false;
    env.ATTACHMENTS.delete = async (key: string) => {
      if (key === `avatars/${userId}/${version1}`) {
        deleteCalled = true;
        throw new Error("simulated R2 prior key delete failure");
      }
      return originalDelete(key);
    };

    try {
      // 2. Upload replacement: even though prior key delete fails, upload succeeds and D1 commits new version
      const WEBP_BYTES = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
      const res2 = await uploadAvatar(cookie, WEBP_BYTES, "image/webp");
      expect(res2.status).toBe(200);
      const body2 = await res2.json<{ avatarVersion: string }>();
      const version2 = body2.avatarVersion;
      expect(version2).not.toBe(version1);
      expect(deleteCalled).toBe(true);

      // Verify the new version is live in D1 and R2
      const userRow = await env.DB.prepare("SELECT avatar_version AS avatarVersion FROM users WHERE id = ?")
        .bind(userId)
        .first<{ avatarVersion: string }>();
      expect(userRow?.avatarVersion).toBe(version2);
      expect(await env.ATTACHMENTS.get(`avatars/${userId}/${version2}`)).not.toBeNull();

      // 3. DELETE CAS concurrency: simulate a concurrent upload that won the race.
      // In DELETE /me/avatar, requireAuth resolves user with version2.
      // If a concurrent upload commits right before CAS runs, CAS changes 0 rows.
      // The handler must fetch and return the authoritative current user row with concurrentVersion.
      const concurrentVersion = crypto.randomUUID();
      const originalPrepare = env.DB.prepare.bind(env.DB);

      // Intercept the CAS UPDATE query to update avatar_version in D1 to concurrentVersion
      // and report 0 changes, exactly simulating the race loss:
      // @ts-expect-error test stubbing
      env.DB.prepare = (query: string) => {
        const stmt = originalPrepare(query);
        if (query.includes("UPDATE users SET avatar_version = NULL WHERE id = ? AND avatar_version = ?")) {
          return {
            ...stmt,
            bind(...params: unknown[]) {
              const bound = stmt.bind(...params);
              return {
                ...bound,
                async run() {
                  // Concurrently set avatar_version in real D1 to concurrentVersion
                  await originalPrepare("UPDATE users SET avatar_version = ? WHERE id = ?")
                    .bind(concurrentVersion, userId)
                    .run();
                  // Report 0 changes for the CAS UPDATE
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }
        return stmt;
      };

      try {
        const delRes = await del("/me/avatar", cookie);
        expect(delRes.status).toBe(200);
        const delBody = await delRes.json<{ avatarVersion: string | null }>();
        expect(delBody.avatarVersion).toBe(concurrentVersion);
      } finally {
        env.DB.prepare = originalPrepare;
      }
    } finally {
      env.ATTACHMENTS.delete = originalDelete;
    }
  });
  it("expired avatar lease causes atomic CAS failure with unchanged avatar_version and sweeper invalidates lease before R2 deletion", async () => {
    const cookie = await signup("avatar-expired-lease@foxban.test", "Expired Lease User");
    const userId = await getUserId(cookie);

    // Verify initial avatar_version is null
    const initialUser = await env.DB.prepare("SELECT avatar_version AS avatarVersion FROM users WHERE id = ?")
      .bind(userId)
      .first<{ avatarVersion: string | null }>();
    expect(initialUser?.avatarVersion).toBeNull();

    // 1. Simulate lease expiry before CAS during POST /me/avatar
    // When ATTACHMENTS.put is called, we expire the active lease in avatar_leases
    const originalPut = env.ATTACHMENTS.put.bind(env.ATTACHMENTS);
    let expiredLeaseVersion: string | null = null;
    env.ATTACHMENTS.put = async (
      key: string,
      value: Parameters<R2Bucket["put"]>[1],
      options?: Parameters<R2Bucket["put"]>[2],
    ) => {
      const parsed = parseAvatarObjectKey(key);
      if (parsed && parsed.userId === userId) {
        expiredLeaseVersion = parsed.avatarVersion;
        // Expire the lease immediately so subsequent renew and CAS fail
        await env.DB.prepare(
          "UPDATE avatar_leases SET expires_at = ? WHERE user_id = ? AND version = ?",
        )
          .bind(Date.now() - 1000, userId, parsed.avatarVersion)
          .run();
      }
      return originalPut(key, value, options);
    };

    try {
      const res = await uploadAvatar(cookie, PNG_1X1, "image/png");
      expect(res.status).toBe(409);

      // avatar_version must remain unchanged (null)
      const userAfterFail = await env.DB.prepare("SELECT avatar_version AS avatarVersion FROM users WHERE id = ?")
        .bind(userId)
        .first<{ avatarVersion: string | null }>();
      expect(userAfterFail?.avatarVersion).toBeNull();

      // The uncommitted R2 object was deleted (compensated)
      expect(expiredLeaseVersion).not.toBeNull();
      const r2Obj = await env.ATTACHMENTS.get(`avatars/${userId}/${expiredLeaseVersion}`);
      expect(r2Obj).toBeNull();
    } finally {
      env.ATTACHMENTS.put = originalPut;
    }

    // 2. Sweeper invalidates expired lease BEFORE deleting the R2 object
    const orphanVersion = crypto.randomUUID();
    const orphanKey = `avatars/${userId}/${orphanVersion}`;
    await env.ATTACHMENTS.put(orphanKey, PNG_1X1);

    // Insert an expired lease for this orphan
    const pastTime = Date.now() - 10_000;
    await env.DB.prepare(
      "INSERT INTO avatar_leases(user_id, version, expires_at) VALUES (?, ?, ?)",
    )
      .bind(userId, orphanVersion, pastTime)
      .run();

    // Track that the lease is invalidated in D1 before R2 deletion happens
    let leaseExistsAtDeleteTime: boolean | null = null;
    const originalDelete = env.ATTACHMENTS.delete.bind(env.ATTACHMENTS);
    env.ATTACHMENTS.delete = async (key: string) => {
      if (key === orphanKey) {
        const leaseRow = await env.DB.prepare(
          "SELECT 1 FROM avatar_leases WHERE user_id = ? AND version = ?",
        )
          .bind(userId, orphanVersion)
          .first();
        leaseExistsAtDeleteTime = leaseRow !== null;
      }
      return originalDelete(key);
    };

    try {
      await reconcileAttachmentObjects(env);

      // Sweeper must have deleted the expired lease BEFORE deleting the R2 object
      expect(leaseExistsAtDeleteTime).toBe(false);
      // R2 object was deleted
      expect(await env.ATTACHMENTS.get(orphanKey)).toBeNull();
      // User's avatar_version remains unchanged
      const finalUser = await env.DB.prepare("SELECT avatar_version AS avatarVersion FROM users WHERE id = ?")
        .bind(userId)
        .first<{ avatarVersion: string | null }>();
      expect(finalUser?.avatarVersion).toBeNull();
    } finally {
      env.ATTACHMENTS.delete = originalDelete;
    }
  });
});

describe("board-by-key route GET /boards/by-key/:key", () => {
  it("resolves board by human key with member/admin authorization and rejects unauthenticated/non-member requests", async () => {
    const owner = await signup("key-owner@foxban.test", "Key Owner");
    const member = await signup("key-member@foxban.test", "Key Member");
    const strangerInvite = await mintInvite(owner);
    const stranger = await signupWithInvite("key-stranger@user.test", strangerInvite, "Key Stranger");
    const admin = await signup("admin-board-key@foxban.test", "Key Admin");

    const boardKey = "DEMOKEY1";
    const boardId = await createBoard(owner, "Key Route Board", boardKey);
    const memberId = await getUserId(member);
    await post(`/boards/${boardId}/members`, { userId: memberId }, owner);

    // 1. Unauthenticated request rejected with 401
    const unauthRes = await get(`/boards/by-key/${boardKey}`);
    expect(unauthRes.status).toBe(401);

    // 2. Stranger (non-member) receives 403 (enumeration resistant)
    const strangerRes = await get(`/boards/by-key/${boardKey}`, stranger);
    expect(strangerRes.status).toBe(403);
    expect(await strangerRes.json()).toEqual({ error: "forbidden" });

    // 3. Nonexistent board key returns 403 (enumeration resistant)
    const nonexistentRes = await get("/boards/by-key/NONEXIST1", owner);
    expect(nonexistentRes.status).toBe(403);
    expect(await nonexistentRes.json()).toEqual({ error: "forbidden" });

    // 4. Invalid board key format fails validation with 400
    const invalidFormatRes = await get("/boards/by-key/1INVALID", owner);
    expect(invalidFormatRes.status).toBe(400);

    // 5. Board owner resolves canonical board row
    const ownerRes = await get(`/boards/by-key/${boardKey}`, owner);
    expect(ownerRes.status).toBe(200);
    expect(await ownerRes.json()).toMatchObject({
      id: boardId,
      name: "Key Route Board",
      key: boardKey,
    });

    // 6. Board member resolves canonical board row
    const memberRes = await get(`/boards/by-key/${boardKey}`, member);
    expect(memberRes.status).toBe(200);
    expect(await memberRes.json()).toMatchObject({
      id: boardId,
      name: "Key Route Board",
      key: boardKey,
    });

    // 7. Admin (non-member) resolves canonical board row
    const adminRes = await get(`/boards/by-key/${boardKey}`, admin);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toMatchObject({
      id: boardId,
      name: "Key Route Board",
      key: boardKey,
    });
  });
});

describe("GitHub response bounds", () => {
  const API = "https://api.github.test";

  /** A `git/ref` answer carrying `padBytes` of extra payload GitHub's real answers never do. */
  function branchBody(padBytes: number): string {
    return JSON.stringify({ ref: "refs/heads/feature", object: { sha: "abc123", url: "https://api.github.test/x" }, pad: "x".repeat(padBytes) });
  }

  async function withFetch<T>(body: string, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("parses a response under the size bound", async () => {
    const branch = await withFetch(branchBody(1024 * 1024), () => getBranch(API, "token", "o", "r", "feature"));
    expect(branch).toMatchObject({ name: "feature", sha: "abc123" });
  });

  it("refuses a response above its size bound as a 502", async () => {
    const error = await withFetch(branchBody(3 * 1024 * 1024), () => getBranch(API, "token", "o", "r", "feature")).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(502);
    expect((error as GitHubApiError).message).toBe("GitHub response exceeded the size limit");
  });

  it("refuses a successful non-JSON body as a malformed 502 instead of returning a string", async () => {
    const error = await withFetch("<html>not json</html>", () => getBranch(API, "token", "o", "r", "feature")).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(502);
    expect((error as GitHubApiError).message).toBe("malformed response from GitHub");
  });
});
