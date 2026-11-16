import { SELF, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { API, ORIGIN, OWNER, PASSWORD, adminSession, deliver, installApp, installation, repo, request, useFakeGitHub } from "./github-test-kit";

/**
 * Write-back (ADR 0064): a card creates its task-key branch, then a pull request,
 * in a connected repo the member picks. Everything goes through the real Worker.
 * The repo's git side is a small fake layered over the shared fake GitHub: it
 * remembers branches and pull requests, and records every write with the token
 * that made it, because an installation token is what makes the author `foxban[bot]`.
 * Boards get fresh keys per test because storage outlives a test.
 */
useFakeGitHub();

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;
const OTHER_REPO_ID = 202;
const OTHER_REPO_NAME = `${OWNER}/web`;
const INSTALLATION_TOKEN = "ghs_installation_7";
// vitest.config.ts binds APP_ORIGIN, which wins over the request's own origin in links.
const APP_ORIGIN = "https://app.example";
// Commit ids are 40 hex digits; the board refuses anything else.
const TRUNK_SHA = "1".repeat(40);
const EXISTING_SHA = "2".repeat(40);

type RemotePull = { number: number; title: string; head: string; base: string; body: string; draft: boolean };
type RemoteWrite = { method: string; path: string; token: string; body: Record<string, unknown> };

/** What the fake repo holds, and what was done to it. `onRead` runs once, at the first read of a request. */
const remote = {
  defaultBranch: "trunk",
  branches: new Map<string, string>(),
  ahead: new Set<string>(),
  pulls: [] as RemotePull[],
  writes: [] as RemoteWrite[],
  onRead: null as null | (() => Promise<void>),
};

function resetRemote() {
  Object.assign(remote, { defaultBranch: "trunk", branches: new Map([["trunk", TRUNK_SHA]]), ahead: new Set<string>(), pulls: [], writes: [], onRead: null });
}

const pullPayload = (pull: RemotePull) => ({
  number: pull.number,
  state: "open",
  draft: pull.draft,
  merged_at: null,
  html_url: `https://github.com/${REPO_NAME}/pull/${pull.number}`,
});

async function remoteFetch(kitFetch: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const route = url.origin === API ? url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/) : null;
  if (!route || route[1] !== REPO_NAME) return kitFetch(input, init);
  const method = init?.method ?? "GET";
  const rest = route[2] ?? "";
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : {};

  if (method === "GET") {
    const hook = remote.onRead;
    remote.onRead = null;
    await hook?.();
  } else {
    remote.writes.push({ method, path: rest, token, body });
  }

  if (method === "GET" && rest === "") {
    return json({ id: REPO_ID, name: "api", full_name: REPO_NAME, html_url: `https://github.com/${REPO_NAME}`, default_branch: remote.defaultBranch, owner: { login: OWNER } });
  }
  const ref = rest.match(/^\/git\/ref\/heads\/(.+)$/);
  if (method === "GET" && ref) {
    const sha = remote.branches.get(decodeURIComponent(ref[1]!));
    return sha ? json({ ref: `refs/heads/${ref[1]}`, object: { sha, url: "https://api.github.example/ignored" } }) : json({ message: "Not Found" }, 404);
  }
  if (method === "POST" && rest === "/git/refs") {
    const name = String(body.ref).replace(/^refs\/heads\//, "");
    if (remote.branches.has(name)) return json({ message: "Reference already exists" }, 422);
    remote.branches.set(name, String(body.sha));
    return json({ ref: body.ref }, 201);
  }
  if (method === "GET" && rest === "/pulls") {
    const head = (url.searchParams.get("head") ?? "").split(":")[1];
    return json(remote.pulls.filter((pull) => pull.head === head).map(pullPayload));
  }
  if (method === "POST" && rest === "/pulls") {
    if (!remote.ahead.has(String(body.head))) {
      return json({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `No commits between ${body.base} and ${body.head}` }] }, 422);
    }
    const pull: RemotePull = { number: remote.pulls.length + 1, title: String(body.title), head: String(body.head), base: String(body.base), body: String(body.body), draft: body.draft === true };
    remote.pulls.push(pull);
    return json(pullPayload(pull), 201);
  }
  const branch = rest.match(/^\/branches\/(.+)$/);
  if (method === "GET" && branch) {
    const sha = remote.branches.get(decodeURIComponent(branch[1]!));
    if (!sha) return json({ message: "Not Found" }, 404);
    return json({ commit: { sha, commit: { message: "Start work", committer: { date: "2026-11-12T10:00:00Z" } } }, _links: { html: `https://github.com/${REPO_NAME}/tree/${branch[1]}` } });
  }
  return json({ message: "Not Found" }, 404);
}

let counter = 0;
const post = (path: string, cookie: string, body: unknown) =>
  request("POST", path, { body: JSON.stringify(body), headers: { "content-type": "application/json", cookie } });
const get = (path: string, cookie: string) => request("GET", path, { headers: { cookie } });

type Session = { cookie: string; id: string };

async function signupAs(email: string, name: string, invite?: string): Promise<Session> {
  const response = await request("POST", "/auth/signup", { body: JSON.stringify({ email, name, password: PASSWORD, invite }), headers: { "content-type": "application/json" } });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, id: (await (await get("/me", cookie)).json<{ id: string }>()).id };
}

/** A member who is neither Admin nor owner, added to `boardId` by `owner`. */
async function addMember(owner: Session, boardId: string, name = "Ada Lovelace"): Promise<Session> {
  const invite = (await (await post("/invites", owner.cookie, {})).json<{ token: string }>()).token;
  const member = await signupAs(`member-${++counter}-${crypto.randomUUID()}@example.test`, name, invite);
  expect((await post(`/boards/${boardId}/members`, owner.cookie, { userId: member.id })).status).toBe(200);
  return member;
}

/** A board's live socket: collects every frame the board sends. */
async function openSocket(boardId: string, cookie: string) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, { headers: { Upgrade: "websocket", cookie } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as ServerMessage);
  });
  socket.accept();
  return { frames, send: (message: object) => socket.send(JSON.stringify(message)), close: () => socket.close() };
}

type TestBoard = { id: string; key: string; owner: Session; cardId: string; taskNumber: number };

/** A new board owned by an Admin, with one card titled `title` (task number 1). */
async function newBoard(title = "Fix the login"): Promise<TestBoard> {
  const adminCookie = await adminSession();
  const owner = { cookie: adminCookie, id: (await (await get("/me", adminCookie)).json<{ id: string }>()).id };
  const key = `W${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
  const created = await post("/boards", owner.cookie, { name: `Board ${key}`, key, workspaceId: await firstWorkspaceId(owner.cookie) });
  expect(created.status).toBe(200);
  const { id } = await created.json<{ id: string }>();

  const socket = await openSocket(id, owner.cookie);
  const cardId = crypto.randomUUID();
  socket.send({ type: "column.create", mutationId: crypto.randomUUID(), id: "col", title: "To do", position: "a0" });
  socket.send({ type: "card.create", mutationId: crypto.randomUUID(), id: cardId, columnId: "col", title, position: "a0" });
  await expect.poll(() => socket.frames.some((frame) => frame.type === "card.numbered")).toBe(true);
  const numbered = socket.frames.find((frame) => frame.type === "card.numbered");
  socket.close();
  return { id, key, owner, cardId, taskNumber: numbered && "taskNumber" in numbered ? numbered.taskNumber : 1 };
}

const branchPath = (board: TestBoard) => `/boards/${board.id}/cards/${board.cardId}/development/create-branch`;
const pullRequestPath = (board: TestBoard) => `/boards/${board.id}/cards/${board.cardId}/development/create-pull-request`;

/** Makes the repos connected, the way the owner installing the App does. */
async function connect(...repos: Array<[number, string]>) {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: repos.map(([id, name]) => repo(id, name)) });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await installApp();
  resetRemote();
  const kitFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => remoteFetch(kitFetch, input, init)) as typeof fetch;
  await connect([REPO_ID, REPO_NAME], [OTHER_REPO_ID, OTHER_REPO_NAME]);
});

describe("choosing a repo on a card", () => {
  it("offers every connected repo to a board member, by name", async () => {
    const board = await newBoard();
    const member = await addMember(board.owner, board.id);

    const response = await get(`/boards/${board.id}/connected-repos`, member.cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repos: [
        { id: REPO_ID, fullName: REPO_NAME, private: false },
        { id: OTHER_REPO_ID, fullName: OTHER_REPO_NAME, private: false },
      ],
    });
  });

  it("is closed to people who are not on the board", async () => {
    const board = await newBoard();
    const elsewhere = await newBoard();
    const outsider = await addMember(elsewhere.owner, elsewhere.id);

    expect((await get(`/boards/${board.id}/connected-repos`, outsider.cookie)).status).toBe(403);
    expect((await request("GET", `/boards/${board.id}/connected-repos`)).status).toBe(401);
  });
});

describe("creating the task branch from a card", () => {
  it("makes a branch named from the task key, at the default branch's tip, in the repo the member picked", async () => {
    const board = await newBoard();
    const member = await addMember(board.owner, board.id);

    const response = await post(branchPath(board), member.cookie, { repositoryId: REPO_ID });

    const name = `${board.key.toLowerCase()}-${board.taskNumber}`;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name, url: `https://github.com/${REPO_NAME}/tree/${name}` });
    expect(remote.branches.get(name)).toBe(TRUNK_SHA);
    // The installation token, not a person's, writes: that is what makes the author foxban[bot].
    expect(remote.writes).toEqual([{ method: "POST", path: "/git/refs", token: INSTALLATION_TOKEN, body: { ref: `refs/heads/${name}`, sha: TRUNK_SHA } }]);
  });

  it("shows on the card once GitHub's create event arrives, with no link written by the route", async () => {
    const board = await newBoard();
    const name = `${board.key.toLowerCase()}-${board.taskNumber}`;
    await post(branchPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    const created = await deliver("create", { ref: name, ref_type: "branch", repository: repo(REPO_ID, REPO_NAME) });
    expect(created.status).toBe(200);

    const development = await get(`/boards/${board.id}/cards/${board.cardId}/development`, board.owner.cookie);
    expect((await development.json<{ branches: Array<{ name: string; repository: string }> }>()).branches).toMatchObject([{ name, repository: REPO_NAME }]);
  });

  it("refuses a repo that is not connected, and writes nothing", async () => {
    const board = await newBoard();

    const response = await post(branchPath(board), board.owner.cookie, { repositoryId: 999 });

    expect(response.status).toBe(409);
    expect(remote.writes).toEqual([]);
  });

  it("refuses a request that does not name a repo", async () => {
    const board = await newBoard();

    expect((await post(branchPath(board), board.owner.cookie, {})).status).toBe(400);
    expect((await post(branchPath(board), board.owner.cookie, { repositoryId: "101" })).status).toBe(400);
  });

  it("answers 404 for a card that is not on the board", async () => {
    const board = await newBoard();

    const response = await post(`/boards/${board.id}/cards/${crypto.randomUUID()}/development/create-branch`, board.owner.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(404);
  });

  it("answers 503 when the instance has no GitHub App yet", async () => {
    const board = await newBoard();
    await env.DB.exec("DELETE FROM github_app");

    expect((await post(branchPath(board), board.owner.cookie, { repositoryId: REPO_ID })).status).toBe(503);
  });

  it("answers with the branch that is already there when the card has one", async () => {
    const board = await newBoard();
    const name = `${board.key.toLowerCase()}-${board.taskNumber}`;
    remote.branches.set(name, EXISTING_SHA);

    const response = await post(branchPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name });
    expect(remote.branches.get(name)).toBe(EXISTING_SHA);
  });
});

/** A branch the card's work was pushed to: it exists and is ahead of the default branch. */
function pushTaskBranch(board: TestBoard): string {
  const name = `${board.key.toLowerCase()}-${board.taskNumber}`;
  remote.branches.set(name, EXISTING_SHA);
  remote.ahead.add(name);
  return name;
}

/** The `pull_request` event GitHub sends for a pull request the fake repo holds. */
const pullRequestEvent = (pull: RemotePull) => ({
  action: "opened",
  number: pull.number,
  repository: repo(REPO_ID, REPO_NAME),
  pull_request: {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: "open",
    draft: pull.draft,
    merged: false,
    html_url: `https://github.com/${REPO_NAME}/pull/${pull.number}`,
    updated_at: "2026-11-12T10:00:00Z",
    head: { ref: pull.head },
  },
});

describe("creating a pull request from a card", () => {
  it("opens one from the task branch against the repo's live default branch, and says who opened it", async () => {
    const board = await newBoard("Fix the login");
    const member = await addMember(board.owner, board.id, "Ada Lovelace");
    const name = pushTaskBranch(board);

    const response = await post(pullRequestPath(board), member.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ number: 1, url: `https://github.com/${REPO_NAME}/pull/1`, state: "open" });
    // Written with the installation token: GitHub shows foxban[bot] as the author.
    expect(remote.writes).toEqual([
      {
        method: "POST",
        path: "/pulls",
        token: INSTALLATION_TOKEN,
        body: {
          title: `${board.key}-${board.taskNumber}: Fix the login`,
          head: name,
          base: "trunk",
          body: `Foxban: ${APP_ORIGIN}/board/${board.key}?card=${board.key}-${board.taskNumber}\n\nOpened by Ada Lovelace`,
          draft: false,
        },
      },
    ]);
  });

  it("shows on the card once GitHub's pull_request event arrives", async () => {
    const board = await newBoard("Fix the login");
    pushTaskBranch(board);
    await post(pullRequestPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    const delivered = await deliver("pull_request", pullRequestEvent(remote.pulls[0]!));
    expect(delivered.status).toBe(200);

    const development = await get(`/boards/${board.id}/cards/${board.cardId}/development`, board.owner.cookie);
    expect((await development.json<{ pullRequests: Array<{ number: number; repository: string }> }>()).pullRequests).toMatchObject([{ number: 1, repository: REPO_NAME }]);
  });

  it("keeps a display name from mentioning people or breaking the line on GitHub", async () => {
    const board = await newBoard();
    const member = await addMember(board.owner, board.id, "@octocat\nsecond line");
    pushTaskBranch(board);

    await post(pullRequestPath(board), member.cookie, { repositoryId: REPO_ID });

    const body = remote.pulls[0]!.body;
    expect(body).not.toMatch(/@octocat/);
    expect(body.split("\n\n")[1]).toMatch(/^Opened by .*octocat second line$/);
  });

  it("tells the member to push first when the branch has no commits of its own", async () => {
    const board = await newBoard();
    const name = pushTaskBranch(board);
    remote.ahead.delete(name);

    const response = await post(pullRequestPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `Push at least one commit to ${name} before creating a pull request.` });
  });

  it("asks for the branch first when the card has none", async () => {
    const board = await newBoard();

    const response = await post(pullRequestPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `branch ${board.key.toLowerCase()}-${board.taskNumber} does not exist` });
    expect(remote.writes).toEqual([]);
  });

  it("answers with the pull request the branch already has instead of opening a second", async () => {
    const board = await newBoard();
    const name = pushTaskBranch(board);
    remote.pulls.push({ number: 7, title: "Earlier", head: name, base: "trunk", body: "", draft: false });

    const response = await post(pullRequestPath(board), board.owner.cookie, { repositoryId: REPO_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ number: 7 });
    expect(remote.writes).toEqual([]);
  });

  it("refuses a repo that is not connected, and writes nothing", async () => {
    const board = await newBoard();
    pushTaskBranch(board);

    expect((await post(pullRequestPath(board), board.owner.cookie, { repositoryId: 999 })).status).toBe(409);
    expect(remote.writes).toEqual([]);
  });
});

describe("board access is rechecked right before each GitHub write", () => {
  for (const operation of ["branch", "pull-request"] as const) {
    const path = operation === "branch" ? branchPath : pullRequestPath;

    it(`refuses a member whose access is removed while GitHub is being read, for a ${operation}`, async () => {
      const board = await newBoard();
      const member = await addMember(board.owner, board.id);
      if (operation === "pull-request") pushTaskBranch(board);
      remote.onRead = async () => {
        const removed = await request("DELETE", `/boards/${board.id}/members/${member.id}`, { headers: { cookie: board.owner.cookie } });
        expect(removed.status).toBe(200);
      };

      const response = await post(path(board), member.cookie, { repositoryId: REPO_ID });

      expect(response.status).toBe(403);
      expect(remote.writes).toEqual([]);
    });

    it(`refuses when the repo is disconnected while GitHub is being read, for a ${operation}`, async () => {
      const board = await newBoard();
      if (operation === "pull-request") pushTaskBranch(board);
      remote.onRead = async () => {
        const removed = await deliver("installation", { action: "deleted", installation: installation(), repositories: [] });
        expect(removed.status).toBe(200);
      };

      const response = await post(path(board), board.owner.cookie, { repositoryId: REPO_ID });

      expect(response.status).toBe(409);
      expect(remote.writes).toEqual([]);
    });
  }
});
