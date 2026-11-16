import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

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

/** The test config's `ADMIN_EMAILS` covers `*@foxban.test`, so these are operators. */
const signupAdmin = () => signup(`admin-${crypto.randomUUID()}@foxban.test`);

/** Ordinary accounts need an account invitation, minted by a configured administrator. */
async function signupMember(admin: string, email?: string): Promise<string> {
  const minted = await post("/invites", {}, admin);
  expect(minted.status).toBe(201);
  const { token } = await minted.json<{ token: string }>();
  return signup(email ?? `member-${crypto.randomUUID()}@example.test`, token);
}

async function me(session: string): Promise<{ id: string }> {
  const response = await get("/me", session);
  expect(response.status).toBe(200);
  return response.json<{ id: string }>();
}

async function createWorkspace(session: string, name: string): Promise<string> {
  const response = await post("/workspaces", { name }, session);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

/** Puts an existing account into a workspace through a real invitation link. */
async function inviteToWorkspace(
  admin: string,
  workspaceId: string,
  member: string,
): Promise<void> {
  const created = await post(`/workspaces/${workspaceId}/invites`, { role: "member" }, admin);
  expect(created.status).toBe(201);
  const { token } = await created.json<{ token: string }>();
  const accepted = await post(
    `/workspaces/${workspaceId}/invites/accept`,
    { token, operationId: crypto.randomUUID() },
    member,
  );
  expect(accepted.status).toBe(200);
}

type WorkspaceMemberRow = {
  userId: string;
  role: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
};

/**
 * The directory's public identity is keyed by `id`, not `userId`: it is a list of
 * accounts, not of memberships.
 */
type CandidateRow = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
};

/** The member row as D1 holds it, so a response can never be the only evidence. */
async function membershipRow(workspaceId: string, userId: string) {
  return env.DB.prepare(
    `SELECT role,created_at AS createdAt,updated_at AS updatedAt
       FROM workspace_members WHERE workspace_id=? AND user_id=?`,
  )
    .bind(workspaceId, userId)
    .first<{ role: string; createdAt: number; updatedAt: number }>();
}

async function countOperations(operationId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_change_operations WHERE id=?`)
    .bind(operationId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

type BoardRow = { accessVersion: number; accessMode: string; pendingOperationId: string | null };

async function boardRow(boardId: string): Promise<BoardRow | null> {
  return env.DB.prepare(
    `SELECT access_version AS accessVersion,access_mode AS accessMode,
            pending_access_operation_id AS pendingOperationId
       FROM boards WHERE id=?`,
  )
    .bind(boardId)
    .first<BoardRow>();
}

async function createBoard(
  session: string,
  workspaceId: string,
  accessMode: "workspace" | "restricted",
): Promise<{ id: string; key: string }> {
  const key = `B${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const response = await post(
    "/boards",
    { name: "Direct add board", key, workspaceId, accessMode },
    session,
  );
  expect(response.status).toBe(200);
  return response.json<{ id: string; key: string }>();
}

describe("workspace membership candidates", () => {
  it("offers the accounts a workspace does not have, to its managers only", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const candidateUser = await me(candidate);
    const alreadyMember = await signupMember(owner);
    const alreadyMemberUser = await me(alreadyMember);
    // An operator with no membership here: its global reach must not include a
    // directory that names every account in it.
    const outsider = await signupAdmin();
    const workspace = await createWorkspace(owner, "Candidates");
    await inviteToWorkspace(owner, workspace, alreadyMember);

    expect((await get(`/workspaces/${workspace}/membership-candidates`)).status).toBe(401);
    const members = await get(`/workspaces/${workspace}/membership-candidates`, owner);
    expect(members.status).toBe(200);
    const body = await members.json<{ candidates: CandidateRow[] }>();
    expect(body.candidates).toContainEqual({
      id: candidateUser.id,
      email: expect.stringContaining("member-"),
      name: expect.any(String),
      githubLogin: null,
      avatarVersion: null,
    });
    // Public identity only, and never someone the member list already shows — the
    // viewer included.
    expect(Object.keys(body.candidates[0]!).sort()).toEqual([
      "avatarVersion",
      "email",
      "githubLogin",
      "id",
      "name",
    ]);
    const ids = body.candidates.map((row) => row.id);
    expect(ids).not.toContain(alreadyMemberUser.id);
    expect(ids).not.toContain((await me(owner)).id);
    // The order is deterministic — name, then email, then id — so a client never
    // sees the directory reshuffle between reads.
    const orderKeys = body.candidates.map((row) => [row.name, row.email, row.id].join("\u0000"));
    expect(orderKeys).toEqual([...orderKeys].sort());

    // A member of the workspace is not a manager, and neither is an operator.
    expect((await get(`/workspaces/${workspace}/membership-candidates`, alreadyMember)).status).toBe(403);
    expect((await get(`/workspaces/${workspace}/membership-candidates`, outsider)).status).toBe(403);
    // No such workspace is a denial too, never an empty directory.
    expect((await get(`/workspaces/${crypto.randomUUID()}/membership-candidates`, owner)).status).toBe(403);
  });
});

describe("direct workspace member add", () => {
  it("adds an existing account with the requested role and fences the workspace's boards", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Direct add");
    const shared = await createBoard(owner, workspace, "workspace");
    const restricted = await createBoard(owner, workspace, "restricted");
    const operationId = crypto.randomUUID();

    const added = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, role: "admin", operationId },
      owner,
    );
    expect(added.status).toBe(200);
    const body = await added.json<{
      operationId: string;
      state: string;
      outcome: string;
      result: { workspaceId: string; userId: string; role?: string };
    }>();
    expect(body).toMatchObject({
      operationId,
      state: "completed",
      outcome: "committed",
      result: { workspaceId: workspace, userId: target.id },
    });
    // A committed add never claims the role it asked for: a membership that already
    // existed keeps its own.
    expect(body.result.role).toBeUndefined();
    expect(await membershipRow(workspace, target.id)).toMatchObject({ role: "admin" });

    // The add fenced every board of the workspace: a new admin opens the Private ones.
    expect(await boardRow(shared.id)).toEqual({
      accessVersion: 1,
      accessMode: "workspace",
      pendingOperationId: null,
    });
    expect(await boardRow(restricted.id)).toEqual({
      accessVersion: 1,
      accessMode: "restricted",
      pendingOperationId: null,
    });

    // The member now reads the workspace, is offered by no directory any more, and
    // reaches the board the workspace grants, and the Private one as an admin.
    const memberView = await get(`/workspaces/${workspace}`, candidate);
    expect(memberView.status).toBe(200);
    expect(await memberView.json()).toMatchObject({ workspace: { role: "admin", access: "member" } });
    expect(await get(`/boards/${shared.id}`, candidate)).toMatchObject({ status: 200 });
    expect(await get(`/boards/${restricted.id}`, candidate)).toMatchObject({ status: 200 });
    const listed = await get(`/workspaces/${workspace}/members`, owner);
    const listedMembers = (await listed.json<{ members: WorkspaceMemberRow[] }>()).members;
    expect(listedMembers.map((row) => row.userId)).toContain(target.id);
    const directory = await get(`/workspaces/${workspace}/membership-candidates`, owner);
    expect((await directory.json<{ candidates: CandidateRow[] }>()).candidates.map((row) => row.id)).not.toContain(target.id);
  });

  it("defaults the role to member", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Default role");

    const added = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, operationId: crypto.randomUUID() },
      owner,
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ state: "completed", outcome: "committed" });
    expect(await membershipRow(workspace, target.id)).toMatchObject({ role: "member" });
  });

  it("is idempotent for an existing membership and never replaces its role", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Idempotent add");
    await inviteToWorkspace(owner, workspace, candidate);
    const before = await membershipRow(workspace, target.id);

    const added = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, role: "admin", operationId: crypto.randomUUID() },
      owner,
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ state: "completed", outcome: "committed" });
    // The membership the invitation created is untouched, timestamps included.
    expect(await membershipRow(workspace, target.id)).toEqual(before);
    expect(before?.role).toBe("member");
  });

  it("answers an unknown account with 404 and reserves nothing", async () => {
    const owner = await signupAdmin();
    const workspace = await createWorkspace(owner, "Unknown account");
    const operationId = crypto.randomUUID();

    const response = await post(
      `/workspaces/${workspace}/members`,
      { userId: crypto.randomUUID(), operationId },
      owner,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user not found" });
    expect(await countOperations(operationId)).toBe(0);
  });

  it("refuses a member, an operator and a locked workspace", async () => {
    const owner = await signupAdmin();
    const member = await signupMember(owner);
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const outsider = await signupAdmin();
    const workspace = await createWorkspace(owner, "Refusals");
    await inviteToWorkspace(owner, workspace, member);

    const refused = { userId: target.id, role: "member", operationId: crypto.randomUUID() };
    expect((await post(`/workspaces/${workspace}/members`, refused, member)).status).toBe(403);
    expect((await post(`/workspaces/${workspace}/members`, refused, outsider)).status).toBe(403);
    expect(await membershipRow(workspace, target.id)).toBeNull();
    expect(await countOperations(refused.operationId)).toBe(0);

    // Another access change holding this workspace's scope is the lock every write
    // path shares: the add cannot reserve, so it applies nothing.
    await env.DB.prepare(`INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`)
      .bind(workspace, crypto.randomUUID())
      .run();
    const locked = { userId: target.id, role: "member", operationId: crypto.randomUUID() };
    const conflict = await post(`/workspaces/${workspace}/members`, locked, owner);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "access change conflict",
      code: "access_change_conflict",
    });
    expect(await membershipRow(workspace, target.id)).toBeNull();
    expect(await countOperations(locked.operationId)).toBe(0);
  });

  it("binds one attempt id to the role it was issued for", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Bound attempt");
    const operationId = crypto.randomUUID();

    const added = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, role: "admin", operationId },
      owner,
    );
    expect(added.status).toBe(200);
    expect(await membershipRow(workspace, target.id)).toMatchObject({ role: "admin" });

    // The same id asking for a different role is a different operation, never a
    // replay of the recorded one.
    const reused = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, role: "member", operationId },
      owner,
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({
      error: "access change conflict",
      code: "access_change_conflict",
    });
    // Replaying the recorded resolution still answers with it.
    const replayed = await post(
      `/workspaces/${workspace}/members`,
      { userId: target.id, role: "admin", operationId },
      owner,
    );
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ operationId, state: "completed", outcome: "committed" });
    expect(await membershipRow(workspace, target.id)).toMatchObject({ role: "admin" });
  });

  it("rejects a body that is not exactly the documented input", async () => {
    const owner = await signupAdmin();
    const candidate = await signupMember(owner);
    const target = await me(candidate);
    const workspace = await createWorkspace(owner, "Strict input");
    const operationId = crypto.randomUUID();

    for (const body of [
      { userId: target.id, role: "owner", operationId },
      { userId: target.id, role: "member", operationId, extra: true },
      { userId: target.id },
      { role: "member", operationId },
      { userId: target.id, role: "member", operationId: "not-a-uuid" },
    ]) {
      expect((await post(`/workspaces/${workspace}/members`, body, owner)).status).toBe(400);
    }
    expect(await membershipRow(workspace, target.id)).toBeNull();
  });
});
