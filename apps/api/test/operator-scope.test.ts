import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const request = (path: string, method: string, body?: unknown, session?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(session ? { cookie: session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string, session?: string) => request(path, "GET", undefined, session);
const post = (path: string, body: unknown, session?: string) => request(path, "POST", body, session);

type Person = { cookie: string; id: string };

async function signup(email: string, invite?: string): Promise<string> {
  const response = await post("/auth/signup", { email, name: email.split("@")[0], password: PASSWORD, ...(invite ? { invite } : {}) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** `*@foxban.test` is an instance Admin (the test environment's ADMIN_EMAILS). */
async function admin(): Promise<Person> {
  const cookie = await signup(`admin-${crypto.randomUUID()}@foxban.test`);
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id };
}

let inviter: Person;
beforeAll(async () => {
  inviter = await admin();
});

/** An ordinary account: no instance power, only what workspaces and boards give it. */
async function person(): Promise<Person> {
  const { token } = await (await post("/invites", {}, inviter.cookie)).json<{ token: string }>();
  const cookie = await signup(`person-${crypto.randomUUID()}@example.test`, token);
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id };
}

async function createWorkspace(by: Person, name: string): Promise<string> {
  const response = await post("/workspaces", { name }, by.cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function addMember(by: Person, workspaceId: string, who: Person, role: "admin" | "member" = "member") {
  const response = await post(`/workspaces/${workspaceId}/members`, { userId: who.id, role, operationId: crypto.randomUUID() }, by.cookie);
  expect(response.status).toBe(200);
}

async function createBoard(by: Person, workspaceId: string, accessMode: "workspace" | "restricted"): Promise<string> {
  const response = await post("/boards", { name: `${accessMode} board`, key: `S${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId, accessMode }, by.cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

/** Makes `who` a Guest of one board: an explicit board_members row, no workspace membership. */
async function addGuest(by: Person, boardId: string, who: Person) {
  const response = await post(`/boards/${boardId}/members`, { userId: who.id }, by.cookie);
  expect(response.status).toBe(200);
}

type Row = { id: string; access: string; role: string | null; boardCount: number; createdBy?: string };
const workspacesOf = async (who: Person) => (await (await get("/workspaces", who.cookie)).json<{ workspaces: Row[] }>()).workspaces;
const boardIdsOf = async (who: Person, query = "") => (await (await get(`/boards${query}`, who.cookie)).json<Array<{ id: string }>>()).map((board) => board.id);

/**
 * One workspace `team` owned by `owner`, with a Workspace board and a Private board,
 * and one viewer of every kind: a member, a Guest of the Private board only, a
 * stranger, an Admin with no tie to it, and an Admin who is a Guest of the Private board.
 */
async function scene() {
  const owner = await person();
  const member = await person();
  const guest = await person();
  const stranger = await person();
  const operator = await admin();
  const guestOperator = await admin();
  const team = await createWorkspace(owner, "Team");
  await addMember(owner, team, member);
  const open = await createBoard(owner, team, "workspace");
  const hidden = await createBoard(owner, team, "restricted");
  await addGuest(owner, hidden, guest);
  await addGuest(owner, hidden, guestOperator);
  return { owner, member, guest, stranger, operator, guestOperator, team, open, hidden };
}

describe("GET /workspaces", () => {
  it("lists only what the viewer has as a member or a Guest, an Admin included", async () => {
    const { owner, member, guest, stranger, operator, guestOperator, team } = await scene();

    expect((await workspacesOf(owner)).find((item) => item.id === team)).toMatchObject({ access: "member", role: "admin", boardCount: 2 });
    expect((await workspacesOf(member)).find((item) => item.id === team)).toMatchObject({ access: "member", role: "member", boardCount: 1 });
    expect((await workspacesOf(guest)).find((item) => item.id === team)).toMatchObject({ access: "guest", role: null, boardCount: 1 });
    expect((await workspacesOf(stranger)).find((item) => item.id === team)).toBeUndefined();
    // An Admin with no tie to it does not see it, and no row is ever an operator row.
    expect((await workspacesOf(operator)).find((item) => item.id === team)).toBeUndefined();
    // An Admin who was added to a board is a Guest like anyone else.
    expect((await workspacesOf(guestOperator)).find((item) => item.id === team)).toMatchObject({ access: "guest", role: null, boardCount: 1 });
    for (const who of [owner, member, guest, stranger, operator, guestOperator]) {
      expect((await workspacesOf(who)).map((item) => item.access)).not.toContain("operator");
    }
  });
});

describe("GET /workspaces/all", () => {
  it("gives an Admin every workspace, including empty ones, and refuses everyone else", async () => {
    const { owner, member, guest, stranger, operator, guestOperator, team } = await scene();
    const empty = await createWorkspace(stranger, "Empty");
    const own = await createWorkspace(operator, "Operator's own");

    for (const admin of [operator, guestOperator]) {
      const response = await get("/workspaces/all", admin.cookie);
      expect(response.status).toBe(200);
      const rows = (await response.json<{ workspaces: Row[] }>()).workspaces;
      // How the Admin reaches each one: a membership is theirs, everything else is operator access.
      expect(rows.find((item) => item.id === team)).toMatchObject({ access: "operator", role: null, boardCount: 2 });
      expect(rows.find((item) => item.id === empty)).toMatchObject({ access: "operator", role: null, boardCount: 0 });
      expect(rows.find((item) => item.id === own)).toMatchObject({ access: admin === operator ? "member" : "operator" });
      // Workspaces can share a name ("Personal"), so each row names the person who created it.
      const nameOf = async (who: { cookie: string }) => (await (await get("/me", who.cookie)).json<{ name: string }>()).name;
      expect(rows.find((item) => item.id === empty)?.createdBy).toBe(await nameOf(stranger));
      expect(rows.find((item) => item.id === own)?.createdBy).toBe(await nameOf(operator));
    }

    // Everyone else is refused, whatever they hold, and an unsigned request is not a session.
    for (const who of [owner, member, guest, stranger]) {
      const refused = await get("/workspaces/all", who.cookie);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "forbidden" });
    }
    expect((await get("/workspaces/all")).status).toBe(401);
  });

});

describe("opening what the lists leave out", () => {
  it("still lets an Admin open the workspace and its boards directly, as an Operator", async () => {
    const { stranger, operator, team, open, hidden } = await scene();

    const workspace = await get(`/workspaces/${team}`, operator.cookie);
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({ workspace: { id: team, access: "operator", role: null } });
    expect((await get(`/boards/${open}`, operator.cookie)).status).toBe(200);
    expect((await get(`/boards/${hidden}`, operator.cookie)).status).toBe(200);
    // A stranger who is not an Admin gets neither.
    expect((await get(`/workspaces/${team}`, stranger.cookie)).status).toBe(403);
    expect((await get(`/boards/${open}`, stranger.cookie)).status).toBe(403);
  });
});

describe("an instance Admin who is also a workspace admin", () => {
  it("holds the workspace as a member, Private boards included, through both lists and the all-workspaces read", async () => {
    const { owner, operator, team, open, hidden } = await scene();
    await addMember(owner, team, operator, "admin");

    // The workspace admin arm of the open rule applies to them like to anyone else.
    expect((await workspacesOf(operator)).find((item) => item.id === team)).toMatchObject({ access: "member", role: "admin", boardCount: 2 });
    expect(await boardIdsOf(operator)).toEqual(expect.arrayContaining([open, hidden]));
    expect(await boardIdsOf(operator, `?workspaceId=${team}`)).toEqual([open, hidden]);
    const listed = await (await get(`/boards?workspaceId=${team}`, operator.cookie)).json<Array<{ id: string; viaWorkspaceAdmin: boolean }>>();
    expect(listed.find((board) => board.id === hidden)?.viaWorkspaceAdmin).toBe(true);
    const all = (await (await get("/workspaces/all", operator.cookie)).json<{ workspaces: Row[] }>()).workspaces;
    expect(all.find((item) => item.id === team)).toMatchObject({ access: "member", role: "admin", boardCount: 2 });

    // A plain workspace admin of the same workspace sees the same boards, and is still refused the instance-wide read.
    const peer = await person();
    await addMember(owner, team, peer, "admin");
    expect(await boardIdsOf(peer)).toEqual([open, hidden]);
    expect((await get("/workspaces/all", peer.cookie)).status).toBe(403);
  });
});

describe("GET /boards", () => {
  it("lists only what the viewer has as a member or a Guest, an Admin included", async () => {
    const { owner, member, guest, stranger, operator, guestOperator, open, hidden } = await scene();

    expect(await boardIdsOf(owner)).toEqual([open, hidden]);
    expect(await boardIdsOf(member)).toEqual([open]);
    expect(await boardIdsOf(guest)).toEqual([hidden]);
    expect(await boardIdsOf(stranger)).toEqual([]);
    // An Admin does not get the instance's boards by default...
    expect(await boardIdsOf(operator)).not.toContain(open);
    expect(await boardIdsOf(operator)).not.toContain(hidden);
    // ...and one added to a board holds exactly that board, as a Guest.
    expect(await boardIdsOf(guestOperator)).toEqual([hidden]);
  });

  it("lists every board of one workspace an Admin operates, and nobody else gets that", async () => {
    const { owner, member, guest, stranger, operator, guestOperator, team, open, hidden } = await scene();
    const own = await createWorkspace(operator, "Operator's own");
    const ownBoard = await createBoard(operator, own, "restricted");

    // The workspace page of an Operator: all boards of that workspace, Private ones included.
    expect(await boardIdsOf(operator, `?workspaceId=${team}`)).toEqual([open, hidden]);
    expect(await boardIdsOf(guestOperator, `?workspaceId=${team}`)).toEqual([open, hidden]);
    // The filter widens nothing for anyone else.
    expect(await boardIdsOf(owner, `?workspaceId=${team}`)).toEqual([open, hidden]);
    expect(await boardIdsOf(member, `?workspaceId=${team}`)).toEqual([open]);
    expect(await boardIdsOf(guest, `?workspaceId=${team}`)).toEqual([hidden]);
    expect(await boardIdsOf(stranger, `?workspaceId=${team}`)).toEqual([]);
    // An Admin reading a workspace they belong to sees it as a member does.
    await addMember(owner, team, operator);
    expect(await boardIdsOf(operator, `?workspaceId=${team}`)).toEqual([open]);
    expect(await boardIdsOf(operator, `?workspaceId=${own}`)).toEqual([ownBoard]);
  });
});
