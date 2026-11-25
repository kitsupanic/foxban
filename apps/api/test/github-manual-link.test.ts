import { SELF, env, runInDurableObject } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { API, ORIGIN, OWNER, PASSWORD, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * Linking a pull request to a card by hand, and unlinking one (ADR 0064, #14), all
 * through the real Worker. The fake GitHub from the kit is extended here with the one
 * read a manual link makes: `GET /repos/{owner}/{repo}/pulls/{number}`. Boards get
 * fresh keys per test because storage outlives a test.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;

type FakePull = { title: string; state?: "open" | "closed"; merged?: boolean; updatedAt?: string; baseRepoId?: number };
const pulls = new Map<number, FakePull>();
const BASE_TIME = Date.UTC(2026, 10, 12, 10, 0, 0);
const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000).toISOString();

beforeEach(() => {
  pulls.clear();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = url.origin === API && url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (!match) return inner(input, init);
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    if (!bearer.startsWith("Bearer ghs_installation_")) return Response.json({ message: "Bad credentials" }, { status: 401 });
    const number = Number(match[3]);
    const pull = pulls.get(number);
    if (`${match[1]}/${match[2]}`.toLowerCase() !== REPO_NAME.toLowerCase() || !pull) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({
      number,
      title: pull.title,
      state: pull.state ?? "open",
      draft: false,
      merged_at: pull.merged ? at(0) : null,
      html_url: `https://github.example/${REPO_NAME}/pull/${number}`,
      updated_at: pull.updatedAt ?? at(0),
      base: { repo: { id: pull.baseRepoId ?? REPO_ID, full_name: REPO_NAME } },
    });
  }) as typeof fetch;
});

type BoardSocket = { frames: ServerMessage[]; send(message: object): void; close(): void };

async function openSocket(boardId: string, cookie: string): Promise<BoardSocket> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", cookie },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as ServerMessage);
  });
  socket.accept();
  return { frames, send: (message) => socket.send(JSON.stringify(message)), close: () => socket.close() };
}

type TestBoard = { id: string; key: string; cookie: string; cardIds: string[]; taskNumbers: number[] };

async function newBoard(cardCount = 1, owner?: string): Promise<TestBoard> {
  const cookie = owner ?? (await adminSession());
  const key = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
  const created = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: `Board ${key}`, key, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(created.status).toBe(200);
  const { id } = await created.json<{ id: string }>();

  const socket = await openSocket(id, cookie);
  socket.send({ type: "column.create", mutationId: crypto.randomUUID(), id: "col", title: "To do", position: "a0" });
  const cardIds = Array.from({ length: cardCount }, () => crypto.randomUUID());
  cardIds.forEach((cardId, index) => {
    socket.send({ type: "card.create", mutationId: crypto.randomUUID(), id: cardId, columnId: "col", title: `Card ${index + 1}`, position: `a${index}` });
  });
  await expect.poll(() => socket.frames.filter((frame) => frame.type === "card.numbered").length).toBe(cardCount);
  const numbers = new Map(socket.frames.flatMap((frame) => (frame.type === "card.numbered" ? [[frame.id, frame.taskNumber] as const] : [])));
  socket.close();
  return { id, key, cookie, cardIds, taskNumbers: cardIds.map((cardId) => numbers.get(cardId)!) };
}

/** A signed-in user who is not a member of the board (admins can open every board, so this one is invited and plain). */
async function strangerCookie(board: TestBoard): Promise<string> {
  const invite = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { cookie: board.cookie } });
  expect(invite.status).toBe(201);
  const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `stranger-${board.key}@example.com`, name: "Stranger", password: PASSWORD, invite: (await invite.json<{ token: string }>()).token }),
  });
  expect(signup.status).toBe(200);
  return signup.headers.get("set-cookie")!.split(";")[0]!;
}

async function pullRequestsOn(board: TestBoard, index = 0) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development`, { headers: { cookie: board.cookie } });
  expect(response.status).toBe(200);
  return (await response.json<{ pullRequests: Array<{ number: number; title: string; state: string; repository: string; url: string }> }>()).pullRequests;
}

const numbersOn = async (board: TestBoard, index = 0) => (await pullRequestsOn(board, index)).map((pr) => pr.number);

async function connect(repoId = REPO_ID, fullName = REPO_NAME) {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(repoId, fullName)] });
  expect(response.status).toBe(200);
}

/** Links by hand: `POST /boards/:id/cards/:cardId/development/pull-requests`. */
function link(board: TestBoard, index: number, body: object, cookie = board.cookie) {
  return SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development/pull-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/** Unlinks: `DELETE /boards/:id/cards/:cardId/development/pull-requests/:repositoryId/:number`. */
function unlink(board: TestBoard, index: number, number: number, repositoryId = REPO_ID, cookie = board.cookie) {
  return SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development/pull-requests/${repositoryId}/${number}`, {
    method: "DELETE",
    headers: { cookie },
  });
}

function pullRequestEvent(options: { number?: number; action?: string; title?: string; state?: "open" | "closed"; merged?: boolean; updatedAt?: string } = {}) {
  const { number = 5, state = "open" } = options;
  return {
    action: options.action ?? "opened",
    number,
    repository: repo(REPO_ID, REPO_NAME),
    pull_request: {
      number,
      title: options.title ?? "Untitled work",
      body: null,
      state,
      draft: false,
      merged: options.merged ?? false,
      html_url: `https://github.example/${REPO_NAME}/pull/${number}`,
      updated_at: options.updatedAt ?? at(0),
      head: { ref: "main-work", repo: { id: REPO_ID } },
    },
  };
}

describe("linking a pull request by hand", () => {
  it("takes a number and a connected repo, and shows the pull request on the card", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Rework the importer" });

    const response = await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID });

    expect(response.status).toBe(200);
    const expected = [
      {
        repositoryId: REPO_ID,
        repository: REPO_NAME,
        number: 5,
        title: "Rework the importer",
        state: "open",
        url: `https://github.example/${REPO_NAME}/pull/5`,
        updatedAt: BASE_TIME,
      },
    ];
    expect((await response.json<{ pullRequests: unknown[] }>()).pullRequests).toEqual(expected);
    expect(await pullRequestsOn(board)).toEqual(expected);
  });

  it("takes a pull request URL, in any letter case, and also a #number", async () => {
    const board = await newBoard(2);
    await connect();
    pulls.set(6, { title: "By URL" });
    pulls.set(7, { title: "By hash", state: "closed", merged: true });

    expect((await link(board, 0, { pullRequest: `https://github.com/${REPO_NAME.toUpperCase()}/pull/6?diff=split` })).status).toBe(200);
    expect((await link(board, 1, { pullRequest: "#7", repositoryId: REPO_ID })).status).toBe(200);

    expect(await pullRequestsOn(board, 0)).toEqual([expect.objectContaining({ number: 6, title: "By URL", state: "open" })]);
    expect(await pullRequestsOn(board, 1)).toEqual([expect.objectContaining({ number: 7, state: "merged" })]);
  });

  it("is repeatable: the same link twice leaves one row", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Once" });

    expect((await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID })).status).toBe(200);
    expect((await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID })).status).toBe(200);

    expect(await numbersOn(board)).toEqual([5]);
  });

  it("makes later events for that pull request update the card, though they name no key", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Rework the importer" });
    await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID });

    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title: "Rework the importer", updatedAt: at(30) }));

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number: 5, state: "merged" })]);
  });

  it("refuses what it cannot link, with a reason, and writes nothing", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Exists" });
    pulls.set(8, { title: "Targets elsewhere", baseRepoId: 999 });
    const code = async (response: Response) => (await response.json<{ code: string }>()).code;

    const garbage = await link(board, 0, { pullRequest: "not a pull request" });
    expect([garbage.status, await code(garbage)]).toEqual([400, "invalid_pr_reference"]);
    const noRepo = await link(board, 0, { pullRequest: "5" });
    expect([noRepo.status, await code(noRepo)]).toEqual([400, "repository_required"]);
    const unconnected = await link(board, 0, { pullRequest: "5", repositoryId: 777 });
    expect([unconnected.status, await code(unconnected)]).toEqual([409, "repo_not_connected"]);
    const otherUrl = await link(board, 0, { pullRequest: "https://github.com/Stranger/elsewhere/pull/5" });
    expect([otherUrl.status, await code(otherUrl)]).toEqual([409, "repo_not_connected"]);
    const mismatch = await link(board, 0, { pullRequest: `https://github.com/${REPO_NAME}/pull/5`, repositoryId: 777 });
    expect(mismatch.status).toBe(409);
    const missing = await link(board, 0, { pullRequest: "404", repositoryId: REPO_ID });
    expect([missing.status, await code(missing)]).toEqual([404, "pr_unavailable"]);
    const foreign = await link(board, 0, { pullRequest: "8", repositoryId: REPO_ID });
    expect([foreign.status, await code(foreign)]).toEqual([409, "wrong_repository"]);

    expect(await pullRequestsOn(board)).toEqual([]);
  });

  it("is limited to members of the board, and to cards that exist", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Members only" });
    const outsider = await strangerCookie(board);

    expect((await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID }, "")).status).toBe(401);
    expect((await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID }, outsider)).status).toBe(403);
    const ghost = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/no-such-card/development/pull-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: board.cookie },
      body: JSON.stringify({ pullRequest: "5", repositoryId: REPO_ID }),
    });
    expect(ghost.status).toBe(404);
    expect(await pullRequestsOn(board)).toEqual([]);
  });
});

describe("unlinking a pull request", () => {
  it("removes it from the card, and a later event that still names the key does not bring it back", async () => {
    const board = await newBoard();
    await connect();
    const named = (updatedAt: string, title = `${board.key}-1 login`) => pullRequestEvent({ title, updatedAt });
    await deliver("pull_request", named(at(0)));
    expect(await numbersOn(board)).toEqual([5]);

    const response = await unlink(board, 0, 5);
    expect(response.status).toBe(200);
    expect((await response.json<{ pullRequests: unknown[] }>()).pullRequests).toEqual([]);
    expect(await numbersOn(board)).toEqual([]);

    await deliver("pull_request", named(at(10), `${board.key}-1 login again`));
    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title: `${board.key}-1 login`, updatedAt: at(20) }));
    expect(await numbersOn(board)).toEqual([]);
  });

  it("holds for that card only: another card the pull request names keeps it, and keeps updating", async () => {
    const board = await newBoard(2);
    await connect();
    const title = `${board.key}-1 and ${board.key}-2`;
    await deliver("pull_request", pullRequestEvent({ title }));

    expect((await unlink(board, 0, 5)).status).toBe(200);
    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title, updatedAt: at(20) }));

    expect(await numbersOn(board, 0)).toEqual([]);
    expect(await pullRequestsOn(board, 1)).toEqual([expect.objectContaining({ number: 5, state: "merged" })]);
  });

  it("stops routing events for a pull request nothing links any more", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "No key here" });
    await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID });
    expect(await (await deliver("pull_request", pullRequestEvent({ title: "No key here", updatedAt: at(5) }))).json()).toEqual({ result: "applied" });

    await unlink(board, 0, 5);

    expect(await (await deliver("pull_request", pullRequestEvent({ title: "No key here", updatedAt: at(10) }))).json()).toEqual({ result: "dropped" });
  });

  it("can be undone by linking by hand again, and that link holds against later events", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: `${board.key}-1 login` });
    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1 login` }));
    await unlink(board, 0, 5);

    expect((await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID })).status).toBe(200);
    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title: `${board.key}-1 login`, updatedAt: at(20) }));

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number: 5, state: "merged" })]);
  });

  it("answers 404 for a pull request the card does not link, and for a card that does not exist", async () => {
    const board = await newBoard();
    await connect();

    const none = await unlink(board, 0, 5);
    expect([none.status, (await none.json<{ code: string }>()).code]).toEqual([404, "not_linked"]);
    const ghost = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/no-such-card/development/pull-requests/${REPO_ID}/5`, { method: "DELETE", headers: { cookie: board.cookie } });
    expect(ghost.status).toBe(404);
  });

  it("is limited to members of the board", async () => {
    const board = await newBoard();
    await connect();
    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1` }));
    const outsider = await strangerCookie(board);

    expect((await unlink(board, 0, 5, REPO_ID, "")).status).toBe(401);
    expect((await unlink(board, 0, 5, REPO_ID, outsider)).status).toBe(403);
    expect(await numbersOn(board)).toEqual([5]);
  });
});

describe("peers", () => {
  const hintsFor = (socket: BoardSocket, cardId: string) =>
    socket.frames.filter((frame) => frame.type === "github.invalidated" && frame.scope === "card" && frame.cardId === cardId);

  it("are told when a pull request is linked and when it is unlinked, without a reload", async () => {
    const board = await newBoard(2);
    await connect();
    pulls.set(5, { title: "Watched" });
    const live = await openSocket(board.id, board.cookie);

    await link(board, 0, { pullRequest: "5", repositoryId: REPO_ID });
    await expect.poll(() => hintsFor(live, board.cardIds[0]!).length).toBe(1);

    await unlink(board, 0, 5);
    await expect.poll(() => hintsFor(live, board.cardIds[0]!).length).toBe(2);
    expect(hintsFor(live, board.cardIds[1]!)).toHaveLength(0);
    live.close();
  });
});

describe("a pull request linked by hand before this model", () => {
  /** Seeds the old one-per-card association, which only the old per-board integration wrote. */
  async function seedOldAssociation(board: TestBoard, index: number, repositoryId: number, pullNumber: number) {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO card_github_pull_requests(card_id, repository_id, pull_number, revision) VALUES (?, ?, ?, ?)",
        board.cardIds[index],
        repositoryId,
        pullNumber,
        crypto.randomUUID(),
      );
    });
  }

  it("shows on the card once its repo is connected, with the pull request's current state", async () => {
    const board = await newBoard();
    pulls.set(5, { title: "Linked long ago", state: "closed", merged: true });
    await seedOldAssociation(board, 0, REPO_ID, 5);

    // Not connected yet: nothing to read it with, so nothing shows.
    expect(await pullRequestsOn(board)).toEqual([]);
    await connect();

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number: 5, title: "Linked long ago", state: "merged", repository: REPO_NAME })]);
  });

  it("can be unlinked, and stays unlinked", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Wrong match" });
    await seedOldAssociation(board, 0, REPO_ID, 5);
    expect(await numbersOn(board)).toEqual([5]);

    expect((await unlink(board, 0, 5)).status).toBe(200);

    expect(await numbersOn(board)).toEqual([]);
  });

  it("is followed by later events like any other link", async () => {
    const board = await newBoard();
    await connect();
    pulls.set(5, { title: "Old link" });
    await seedOldAssociation(board, 0, REPO_ID, 5);
    expect(await numbersOn(board)).toEqual([5]);

    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title: "Old link", updatedAt: at(40) }));

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ state: "merged" })]);
  });
});

describe("an unlink when its card moves to another board", () => {
  it("still holds there: the destination's key naming the pull request does not link it again", async () => {
    const source = await newBoard();
    // Same owner; the destination already holds its task 1, so the moved card becomes task 2.
    const destination = await newBoard(1, source.cookie);
    await connect();
    await deliver("pull_request", pullRequestEvent({ title: `${source.key}-1 login` }));
    expect((await unlink(source, 0, 5)).status).toBe(200);

    const moved = await SELF.fetch(`${ORIGIN}/boards/${source.id}/cards/${source.cardIds[0]}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: source.cookie },
      body: JSON.stringify({ transferId: crypto.randomUUID(), destinationBoardId: destination.id, destinationColumnId: "col" }),
    });
    expect(moved.status).toBe(200);
    await deliver("pull_request", pullRequestEvent({ title: `${destination.key}-2 login again`, updatedAt: at(10) }));

    const response = await SELF.fetch(`${ORIGIN}/boards/${destination.id}/cards/${source.cardIds[0]}/development`, { headers: { cookie: source.cookie } });
    expect(response.status).toBe(200);
    expect((await response.json<{ pullRequests: unknown[] }>()).pullRequests).toEqual([]);
  });
});
