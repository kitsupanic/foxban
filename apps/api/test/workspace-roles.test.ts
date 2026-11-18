import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { scheduler } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { REALTIME_PROTOCOL_VERSION, WorkspaceRoleSchema } from "@foxban/shared";
import { ACCESS_CHANGE_ABORT, runAccessChange } from "../src/access-changes";
import type { SessionUser } from "../src/auth";
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
const patch = (path: string, body: unknown, session?: string) => request(path, "PATCH", body, session);
const del = (path: string, body: unknown, session?: string) => request(path, "DELETE", body, session);

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

/** A signup on `@foxban.test` is an instance Admin (admin-signups.ts) (an Operator), which would mask a workspace role. */
let operator: string;
beforeAll(async () => {
  operator = await signup(`operator-${crypto.randomUUID()}@foxban.test`);
});

/** An ordinary account: it holds no power except through the workspaces it is put in. */
async function person(): Promise<Person> {
  const minted = await post("/invites", {}, operator);
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

const setRole = (by: Person, workspaceId: string, who: Person, role: "admin" | "member") =>
  patch(`/workspaces/${workspaceId}/members/${who.id}`, { role, operationId: crypto.randomUUID() }, by.cookie);
const removeMember = (by: Person, workspaceId: string, who: Person) =>
  del(`/workspaces/${workspaceId}/members/${who.id}`, { operationId: crypto.randomUUID() }, by.cookie);

async function roleOf(workspaceId: string, who: Person): Promise<string | null> {
  return (
    (
      await env.DB.prepare(`SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?`)
        .bind(workspaceId, who.id)
        .first<{ role: string }>()
    )?.role ?? null
  );
}

async function adminCount(workspaceId: string): Promise<number> {
  return (
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND role='admin'`)
        .bind(workspaceId)
        .first<{ n: number }>()
    )?.n ?? -1
  );
}

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted" = "workspace") {
  const response = await post(
    "/boards",
    {
      name: "Roles board",
      key: `R${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      workspaceId,
      accessMode,
    },
    by.cookie,
  );
  expect(response.status).toBe(200);
  return response.json<{ id: string; capabilities: { canManageBoard: boolean } }>();
}

describe("workspace admins and members", () => {
  it("has no owner role: the creator of a workspace is its admin", async () => {
    expect(WorkspaceRoleSchema.options).toEqual(["admin", "member"]);
    const creator = await person();
    const created = await post("/workspaces", { name: "Fresh" }, creator.cookie);
    expect(created.status).toBe(201);
    const { workspace } = await created.json<{ workspace: { id: string; role: string } }>();
    expect(workspace.role).toBe("admin");
    expect(await roleOf(workspace.id, creator)).toBe("admin");
    const members = await (await get(`/workspaces/${workspace.id}/members`, creator.cookie)).json<{
      members: Array<{ userId: string; role: string }>;
    }>();
    expect(members.members).toEqual([expect.objectContaining({ userId: creator.id, role: "admin" })]);
  });

  it("lets an admin make a member an admin, and an admin a member, the creator included", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer);

    // Member to admin.
    const promoted = await setRole(creator, workspace, peer, "admin");
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ state: "completed", outcome: "committed" });
    expect(await roleOf(workspace, peer)).toBe("admin");

    // The new admin demotes the creator: nothing about the creator is special.
    const demoted = await setRole(peer, workspace, creator, "member");
    expect(demoted.status).toBe(200);
    expect(await roleOf(workspace, creator)).toBe("member");
    // The former creator has lost the admin's powers, the peer holds them.
    expect((await patch(`/workspaces/${workspace}`, { name: "Not mine" }, creator.cookie)).status).toBe(403);
    expect((await patch(`/workspaces/${workspace}`, { name: "Peer's" }, peer.cookie)).status).toBe(200);

    // And back: an admin can hand the creator the role again, and demote the peer.
    expect((await setRole(peer, workspace, creator, "admin")).status).toBe(200);
    expect((await setRole(creator, workspace, peer, "member")).status).toBe(200);
    expect([await roleOf(workspace, creator), await roleOf(workspace, peer)]).toEqual(["admin", "member"]);
  });

  it("gives an admin who did not create the workspace every power the creator has", async () => {
    const creator = await person();
    const peer = await person();
    const newcomer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer, "admin");
    const board = await createBoard(creator, workspace, "workspace");

    // Settings, invitations, adding and removing members, board management.
    expect((await patch(`/workspaces/${workspace}`, { name: "Renamed by peer" }, peer.cookie)).status).toBe(200);
    expect((await post(`/workspaces/${workspace}/invites`, { role: "member" }, peer.cookie)).status).toBe(201);
    expect((await get(`/workspaces/${workspace}/invites`, peer.cookie)).status).toBe(200);
    const candidates = await get(`/workspaces/${workspace}/membership-candidates`, peer.cookie);
    expect(candidates.status).toBe(200);
    await add(peer, workspace, newcomer);
    const asPeer = await (await get(`/boards/${board.id}`, peer.cookie)).json<{ capabilities: { canManageBoard: boolean } }>();
    expect(asPeer.capabilities.canManageBoard).toBe(true);
    expect(
      (await patch(`/boards/${board.id}`, { name: "Renamed", key: "RENAMED", icon: "rocket", color: "teal" }, peer.cookie)).status,
    ).toBe(200);
    // The creator can be removed by the admin who did not create the workspace.
    expect((await removeMember(peer, workspace, creator)).status).toBe(200);
    expect(await roleOf(workspace, creator)).toBeNull();

    // A plain member gets none of it.
    expect((await patch(`/workspaces/${workspace}`, { name: "Nope" }, newcomer.cookie)).status).toBe(403);
    expect((await post(`/workspaces/${workspace}/invites`, { role: "member" }, newcomer.cookie)).status).toBe(403);
    expect((await get(`/workspaces/${workspace}/membership-candidates`, newcomer.cookie)).status).toBe(403);
    expect((await setRole(newcomer, workspace, peer, "member")).status).toBe(403);
    expect((await removeMember(newcomer, workspace, peer)).status).toBe(403);
    const asMember = await (await get(`/boards/${board.id}`, newcomer.cookie)).json<{ capabilities: { canManageBoard: boolean } }>();
    expect(asMember.capabilities.canManageBoard).toBe(false);
  });

  it("applies the same rule to the board's live connection: a promoted admin manages columns, a member does not", async () => {
    const creator = await person();
    const peer = await person();
    const member = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, member);
    const board = await createBoard(creator, workspace, "workspace");
    // The peer joins as a member and is promoted later. Each mutation opens its own
    // connection, so what is tested is the role in force at that moment.
    await add(creator, workspace, peer);

    async function mutate(who: Person, title: string): Promise<{ type: string; message?: string }> {
      const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
        headers: { Upgrade: "websocket", cookie: who.cookie },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      const frames: Array<{ type: string; mutationId?: string; message?: string }> = [];
      const waiting: Array<() => void> = [];
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
        waiting.shift()?.();
      });
      socket.accept();
      try {
        const mutationId = crypto.randomUUID();
        socket.send(JSON.stringify({ type: "column.create", mutationId, id: crypto.randomUUID(), title, position: "a0" }));
        for (;;) {
          const answer = frames.find((frame) => frame.mutationId === mutationId);
          if (answer) return answer;
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
      } finally {
        socket.close(1000, "test finished");
      }
    }

    expect(await mutate(peer, "Before")).toMatchObject({ type: "error", message: expect.stringMatching(/owner or an admin/) });
    expect((await setRole(creator, workspace, peer, "admin")).status).toBe(200);
    expect(await mutate(peer, "After promotion")).toMatchObject({ type: "column.create" });
    expect(await mutate(member, "Member")).toMatchObject({ type: "error", message: expect.stringMatching(/owner or an admin/) });
    // Demoted again, the same person is refused again.
    expect((await setRole(creator, workspace, peer, "member")).status).toBe(200);
    expect(await mutate(peer, "After demotion")).toMatchObject({ type: "error" });
  });

  it("drops a demoted admin's open connections, because role changes go through the access-change journal", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer, "admin");
    const board = await createBoard(creator, workspace, "workspace");
    const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
      headers: { Upgrade: "websocket", cookie: peer.cookie },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));

    const demoted = await setRole(creator, workspace, peer, "member");
    expect(await demoted.json()).toMatchObject({ outcome: "committed" });
    expect(await Promise.race([closed, scheduler.wait(5_000).then(() => "still open" as const)])).toBe(4010);
    const journaled = await env.DB.prepare(`SELECT kind,phase,outcome FROM access_change_operations WHERE kind='workspace-member-role' ORDER BY created_at DESC LIMIT 1`).first();
    expect(journaled).toEqual({ kind: "workspace-member-role", phase: "completed", outcome: "committed" });
  });

  it("does not accept an owner role anywhere a role is chosen", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer);
    expect((await setRole(creator, workspace, peer, "owner" as never)).status).toBe(400);
    expect((await post(`/workspaces/${workspace}/invites`, { role: "owner" }, creator.cookie)).status).toBe(400);
    expect(await roleOf(workspace, peer)).toBe("member");
  });
});

describe("leaving a workspace", () => {
  async function openBoardSocket(cookie: string, boardId: string) {
    const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
      headers: { Upgrade: "websocket", cookie },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    return { socket, closed };
  }

  it("lets a plain member leave, and ends their access to Workspace boards on open connections", async () => {
    const creator = await person();
    const leaver = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, leaver);
    const board = await createBoard(creator, workspace, "workspace");
    expect((await get(`/boards/${board.id}`, leaver.cookie)).status).toBe(200);
    const { socket, closed } = await openBoardSocket(leaver.cookie, board.id);

    const left = await removeMember(leaver, workspace, leaver);
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ state: "completed", outcome: "committed" });
    expect(await roleOf(workspace, leaver)).toBeNull();

    // The connection that was open is dropped as part of the change, not at its
    // next message, and every way back in is closed.
    const outcome = await Promise.race([closed, scheduler.wait(5_000).then(() => "still open" as const)]);
    expect(outcome).toBe(4010);
    socket.close();
    expect((await get(`/boards/${board.id}`, leaver.cookie)).status).toBe(403);
    expect(
      (await SELF.fetch(`${ORIGIN}/boards/${board.id}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, { headers: { Upgrade: "websocket", cookie: leaver.cookie } })).status,
    ).toBe(403);
    expect(await (await get(`/boards?workspaceId=${workspace}`, leaver.cookie)).json()).toEqual([]);
    expect((await get(`/workspaces/${workspace}/members`, leaver.cookie)).status).toBe(403);
    // The workspace and its board carry on for the people still in it.
    expect((await get(`/boards/${board.id}`, creator.cookie)).status).toBe(200);
    // Leaving again, or leaving what you never joined, is refused.
    expect((await removeMember(leaver, workspace, leaver)).status).toBe(403);
    const stranger = await person();
    expect((await removeMember(stranger, workspace, stranger)).status).toBe(403);
  });

  it("does not let a member remove anyone else", async () => {
    const creator = await person();
    const member = await person();
    const other = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, member);
    await add(creator, workspace, other);
    expect((await removeMember(member, workspace, other)).status).toBe(403);
    expect((await removeMember(member, workspace, creator)).status).toBe(403);
    expect(await roleOf(workspace, other)).toBe("member");
    expect(await roleOf(workspace, creator)).toBe("admin");
  });

  it("keeps a member's explicit board grants when they leave", async () => {
    const creator = await person();
    const leaver = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, leaver);
    const board = await createBoard(creator, workspace, "restricted");
    expect((await post(`/boards/${board.id}/members`, { userId: leaver.id }, creator.cookie)).status).toBe(200);
    expect((await removeMember(leaver, workspace, leaver)).status).toBe(200);
    // Now only a guest of that one board, as the Members page promises.
    expect((await get(`/boards/${board.id}`, leaver.cookie)).status).toBe(200);
  });
});

describe("a workspace always keeps an admin", () => {
  const LAST_ADMIN = { code: "last_admin", error: expect.stringMatching(/promote.*admin/i) };

  it("refuses to demote or remove the last admin, and says to promote someone first", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer);

    const demote = await setRole(creator, workspace, creator, "member");
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual(LAST_ADMIN);
    const leave = await removeMember(creator, workspace, creator);
    expect(leave.status).toBe(409);
    expect(await leave.json()).toEqual(LAST_ADMIN);
    expect(await roleOf(workspace, creator)).toBe("admin");
    // Nothing was reserved or left half done.
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_change_scopes WHERE workspace_id=?`).bind(workspace).first<{ n: number }>())?.n,
    ).toBe(0);

    // Promoting someone first is exactly what unblocks it, and then the other
    // admin is the last one.
    expect((await setRole(creator, workspace, peer, "admin")).status).toBe(200);
    expect((await setRole(creator, workspace, creator, "member")).status).toBe(200);
    expect(await adminCount(workspace)).toBe(1);
    const peerDemote = await setRole(peer, workspace, peer, "member");
    expect(peerDemote.status).toBe(409);
    expect(await peerDemote.json()).toEqual(LAST_ADMIN);
    expect((await removeMember(peer, workspace, peer)).status).toBe(409);
    expect(await roleOf(workspace, peer)).toBe("admin");
  });

  it("leaves at least one admin when two admins demote each other, or leave, at once", async () => {
    // Several rounds, so the two requests interleave differently: the answer must
    // not depend on which one the server happens to run first.
    for (let round = 0; round < 6; round++) {
      const a = await person();
      const b = await person();
      const workspace = await createWorkspace(a);
      await add(a, workspace, b, "admin");
      const bothAct = round % 2 === 0 ? [setRole(a, workspace, b, "member"), setRole(b, workspace, a, "member")] : [removeMember(a, workspace, a), removeMember(b, workspace, b)];
      const answers = await Promise.all(bothAct);
      const statuses = answers.map((answer) => answer.status);

      expect(await adminCount(workspace), `round ${round}: ${statuses}`).toBeGreaterThanOrEqual(1);
      // One change can commit; the other is refused and told why, never half done.
      expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(1);
      for (const answer of answers.filter((candidate) => candidate.status !== 200)) {
        expect([403, 409]).toContain(answer.status);
      }
      expect(
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_change_scopes WHERE workspace_id=?`).bind(workspace).first<{ n: number }>())?.n,
      ).toBe(0);
    }
  });

  it("lets an admin leave while another admin remains", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer, "admin");
    expect((await removeMember(creator, workspace, creator)).status).toBe(200);
    expect(await roleOf(workspace, creator)).toBeNull();
    expect(await adminCount(workspace)).toBe(1);
  });

  it("journals a refusal the checks did not catch, and replays it", async () => {
    const creator = await person();
    const peer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, peer);
    const actor = (await env.DB.prepare(
      `SELECT id,email,name,github_login AS githubLogin,avatar_version AS avatarVersion,timezone FROM users WHERE id=?`,
    )
      .bind(creator.id)
      .first<SessionUser>())!;
    const operationId = crypto.randomUUID();

    // The route's own check is bypassed by driving the operation directly: the
    // reservation still succeeds, and the commit refuses to leave no admin.
    const result = await runAccessChange(env, actor, {
      operationId,
      kind: "workspace-member-remove",
      payload: { workspaceId: workspace, userId: creator.id },
      workspaceIds: [workspace],
      inheritWorkspaceBoards: true,
    });
    expect(result).toMatchObject({ state: "completed", outcome: "aborted", result: ACCESS_CHANGE_ABORT.lastAdmin });
    expect(await roleOf(workspace, creator)).toBe("admin");
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_change_scopes WHERE workspace_id=?`).bind(workspace).first<{ n: number }>())?.n,
    ).toBe(0);

    // A retry of that attempt answers the recorded refusal, in the same words.
    const replay = await del(`/workspaces/${workspace}/members/${creator.id}`, { operationId }, creator.cookie);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(LAST_ADMIN);
  });
});

describe("an invitation is only as good as the admin who issued it", () => {
  const UNAVAILABLE = { code: "workspace_invite_unavailable", error: "This workspace invitation is unavailable." };
  const invite = async (by: Person, workspaceId: string, role: "admin" | "member" = "admin") => {
    const response = await post(`/workspaces/${workspaceId}/invites`, { role }, by.cookie);
    expect(response.status).toBe(201);
    const { invite: row, token } = await response.json<{ invite: { id: string }; token: string }>();
    return { id: row.id, token };
  };
  const accept = (by: Person, workspaceId: string, token: string) =>
    post(`/workspaces/${workspaceId}/invites/accept`, { token, operationId: crypto.randomUUID() }, by.cookie);
  const inspect = (by: Person, workspaceId: string, token: string) =>
    post(`/workspaces/${workspaceId}/invites/inspect`, { token }, by.cookie);
  const listedIds = async (by: Person, workspaceId: string) =>
    (await (await get(`/workspaces/${workspaceId}/invites`, by.cookie)).json<{ invites: Array<{ id: string }> }>()).invites.map((row) => row.id);

  it("does not let a demoted admin leave and rejoin as admin through the invite they kept", async () => {
    const creator = await person();
    const kept = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, kept, "admin");
    const { token } = await invite(kept, workspace);

    expect((await setRole(creator, workspace, kept, "member")).status).toBe(200);
    expect((await removeMember(kept, workspace, kept)).status).toBe(200);

    const accepted = await accept(kept, workspace, token);
    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toEqual(UNAVAILABLE);
    expect(await roleOf(workspace, kept)).toBeNull();
  });

  it("refuses the invite of an admin who was removed, to anyone", async () => {
    const creator = await person();
    const gone = await person();
    const newcomer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, gone, "admin");
    const { token } = await invite(gone, workspace, "member");

    expect((await removeMember(creator, workspace, gone)).status).toBe(200);

    const accepted = await accept(newcomer, workspace, token);
    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toEqual(UNAVAILABLE);
    expect(await roleOf(workspace, newcomer)).toBeNull();
  });

  it("is not offered as usable while its inviter is not an admin, and is again once they are", async () => {
    const creator = await person();
    const issuer = await person();
    const newcomer = await person();
    const workspace = await createWorkspace(creator);
    await add(creator, workspace, issuer, "admin");
    const { id, token } = await invite(issuer, workspace);
    expect(await listedIds(creator, workspace)).toEqual([id]);
    expect((await inspect(newcomer, workspace, token)).status).toBe(200);

    await setRole(creator, workspace, issuer, "member");
    expect(await listedIds(creator, workspace)).toEqual([]);
    const inspected = await inspect(newcomer, workspace, token);
    expect(inspected.status).toBe(400);
    expect(await inspected.json()).toEqual(UNAVAILABLE);

    // Promoting them again is the admin's call, and it makes the invite usable once more.
    await setRole(creator, workspace, issuer, "admin");
    expect(await listedIds(creator, workspace)).toEqual([id]);
    expect((await inspect(newcomer, workspace, token)).status).toBe(200);
    const accepted = await accept(newcomer, workspace, token);
    expect(accepted.status).toBe(200);
    expect(await roleOf(workspace, newcomer)).toBe("admin");
  });

  /**
   * A demotion that lands at any point of an acceptance. `demote` is the change
   * under test; it runs at each gap in turn, and the acceptance may then end any way
   * except one: the newcomer joined although the inviter had already lost the role.
   */
  const sweep = async (demote: (workspaceId: string, issuer: Person, creator: Person) => Promise<unknown>) => {
    const creator = await person();
    const issuer = await person();
    const newcomer = await person();
    const prepare = async () => {
      const workspace = await createWorkspace(creator, "Gap invite");
      await add(creator, workspace, issuer, "admin");
      return { workspace, token: (await invite(issuer, workspace)).token };
    };
    const acceptAs = (hooked: ReturnType<typeof workerWithPausedD1>, w: { workspace: string; token: string }) =>
      hooked.fetch(`/workspaces/${w.workspace}/invites/accept`, "POST", newcomer, { token: w.token, operationId: crypto.randomUUID() });
    const gaps = await queriesOf(async (hooked) => acceptAs(hooked, await prepare()));
    expect(gaps).toBeGreaterThan(5);

    const seen = new Set<number>();
    for (let gap = 0; gap <= gaps; gap++) {
      const w = await prepare();
      let fired = false;
      let joinedFirst: string | null = null;
      const fire = async () => {
        fired = true;
        joinedFirst = await roleOf(w.workspace, newcomer);
        await demote(w.workspace, issuer, creator);
      };
      const hooked = workerWithPausedD1(async (n) => {
        if (n === gap) await fire();
      });
      const accepted = await acceptAs(hooked, w);
      // One past the last query means: the demotion arrives after the acceptance is over.
      if (!fired) await fire();

      seen.add(accepted.status);
      // Whatever the newcomer got, it was granted while the issuer still held the role.
      if ((await roleOf(w.workspace, issuer)) !== "admin" && joinedFirst === null) {
        expect(await roleOf(w.workspace, newcomer), `joined after the demotion, gap ${gap}`).toBeNull();
      }
    }
    // The gaps straddled the demotion: the acceptance went through, was refused as an
    // unavailable invite (400), and was refused at its reservation (409), the gap
    // between the read that found the invite and the lock that was meant to hold it.
    expect([...seen].sort()).toEqual([200, 400, 409]);
  };

  it("never admits a newcomer after the inviter is demoted, at any point of the acceptance", async () => {
    await sweep((workspace, issuer, creator) => setRole(creator, workspace, issuer, "member"));
  }, 120_000);

  it("holds the same line at commit even when the demotion does not take the workspace lock", async () => {
    // A direct write cannot be refused by the lock the reservation holds, so only the
    // commit's own check can stop the acceptance that is already reserved.
    await sweep((workspace, issuer) =>
      env.DB.prepare(`UPDATE workspace_members SET role='member' WHERE workspace_id=? AND user_id=?`).bind(workspace, issuer.id).run(),
    );
  }, 120_000);
});
