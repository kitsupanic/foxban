import { SELF } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, OWNER, PASSWORD, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * Development info on cards (ADR 0064): signed `pull_request` webhooks in, card
 * reads and board sockets out, all through the real Worker. Nothing here looks
 * inside the BoardDO or D1; a card's pull requests are what `GET .../development`
 * says. Boards get fresh keys per test because storage outlives a test.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;

/** A board's live socket: collects every frame the board sends. */
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

/** A new board with `cardCount` cards, numbered 1..cardCount in creation order. */
async function newBoard(cardCount = 1): Promise<TestBoard> {
  const cookie = await adminSession();
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

/** What the card's Development section reads. */
async function pullRequestsOn(board: TestBoard, index = 0) {
  const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development`, { headers: { cookie: board.cookie } });
  expect(response.status).toBe(200);
  return (await response.json<{ pullRequests: Array<{ number: number; title: string; state: string; repository: string }> }>()).pullRequests;
}

/** Makes `repo` a connected repo, the way the owner installing the App does. */
async function connect(repoId = REPO_ID, fullName = REPO_NAME) {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(repoId, fullName)] });
  expect(response.status).toBe(200);
}

const BASE_TIME = Date.UTC(2026, 10, 12, 10, 0, 0);
/** GitHub's timestamp format, `seconds` after a fixed start. */
const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000).toISOString();

type PullRequestOptions = {
  repoId?: number;
  repoName?: string;
  action?: string;
  number?: number;
  title?: string;
  body?: string | null;
  branch?: string;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  updatedAt?: string;
};

/** A `pull_request` event as GitHub sends it, down to the fields this feature reads. */
function pullRequestEvent(options: PullRequestOptions = {}) {
  const { repoId = REPO_ID, repoName = REPO_NAME, number = 5, branch = "main-work", state = "open" } = options;
  return {
    action: options.action ?? "opened",
    number,
    repository: repo(repoId, repoName),
    pull_request: {
      number,
      title: options.title ?? "Untitled work",
      body: options.body ?? null,
      state,
      draft: options.draft ?? false,
      merged: options.merged ?? false,
      html_url: `https://github.example/${repoName}/pull/${number}`,
      updated_at: options.updatedAt ?? at(0),
      head: { ref: branch },
    },
  };
}

describe("a pull request that names a task key", () => {
  it("shows on that card with its repo, number, title, state and link", async () => {
    const board = await newBoard();
    await connect();

    const response = await deliver("pull_request", pullRequestEvent({ title: "Fix the login", branch: `${board.key.toLowerCase()}-1-fix-login` }));
    expect(response.status).toBe(200);

    expect(await pullRequestsOn(board)).toEqual([
      {
        repositoryId: REPO_ID,
        repository: REPO_NAME,
        number: 5,
        title: "Fix the login",
        state: "open",
        url: `https://github.example/${REPO_NAME}/pull/5`,
        updatedAt: BASE_TIME,
      },
    ]);
  });
});

describe("matching task keys", () => {
  it("ignores case, and finds the key in the branch, the title or the body", async () => {
    const board = await newBoard(3);
    await connect();

    await deliver("pull_request", pullRequestEvent({ number: 1, branch: `feature/${board.key.toLowerCase()}-1-login` }));
    await deliver("pull_request", pullRequestEvent({ number: 2, title: `Fix ${board.key}-2 properly` }));
    await deliver("pull_request", pullRequestEvent({ number: 3, body: `Closes ${board.key.toLowerCase()}-3.` }));

    expect((await pullRequestsOn(board, 0)).map((pr) => pr.number)).toEqual([1]);
    expect((await pullRequestsOn(board, 1)).map((pr) => pr.number)).toEqual([2]);
    expect((await pullRequestsOn(board, 2)).map((pr) => pr.number)).toEqual([3]);
  });

  it("matches whole words only: KR-10 is not KR-1, and neither is KR-100", async () => {
    const board = await newBoard(10);
    await connect();

    await deliver("pull_request", pullRequestEvent({ number: 1, branch: `${board.key.toLowerCase()}-10-fix` }));
    await deliver("pull_request", pullRequestEvent({ number: 2, title: `${board.key}-100 and X${board.key}-1 and ${board.key}-1x and ${board.key}-01` }));

    expect(await pullRequestsOn(board, 0)).toEqual([]);
    expect((await pullRequestsOn(board, 9)).map((pr) => pr.number)).toEqual([1]);
  });

  it("links one pull request to every card it names, on one board or on two", async () => {
    const first = await newBoard(2);
    const second = await newBoard(1);
    await connect();

    await deliver("pull_request", pullRequestEvent({ number: 7, title: `${first.key}-1 and ${first.key}-2 together`, branch: `${second.key.toLowerCase()}-1-shared` }));

    expect((await pullRequestsOn(first, 0)).map((pr) => pr.number)).toEqual([7]);
    expect((await pullRequestsOn(first, 1)).map((pr) => pr.number)).toEqual([7]);
    expect((await pullRequestsOn(second, 0)).map((pr) => pr.number)).toEqual([7]);
  });

  it("drops keys that name no board or no card, and never reaches another board's card with the same number", async () => {
    const mine = await newBoard(1);
    const other = await newBoard(1);
    await connect();

    // `ZZNOBOARD-1` is no board; `${mine.key}-99` is a board with no such card; ${mine.key}-1 is the only hit.
    const response = await deliver("pull_request", pullRequestEvent({ number: 9, title: `ZZNOBOARD-1 ${mine.key}-99`, branch: "no-key-here" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "dropped" });
    await deliver("pull_request", pullRequestEvent({ number: 10, title: `${mine.key}-1` }));

    expect((await pullRequestsOn(mine)).map((pr) => pr.number)).toEqual([10]);
    expect(await pullRequestsOn(other)).toEqual([]);
  });

  // The newer-event rule runs on `pull_request.updated_at`; an event without it is refused rather than guessed at.
  it("refuses a pull request event that carries no usable updated_at, and a link that is not a web URL", async () => {
    const board = await newBoard(1);
    await connect();
    const event = pullRequestEvent({ title: `${board.key}-1` });

    const noClock = { ...event, pull_request: { ...event.pull_request, updated_at: undefined } };
    expect((await deliver("pull_request", noClock)).status).toBe(400);
    const badClock = { ...event, pull_request: { ...event.pull_request, updated_at: "yesterday" } };
    expect((await deliver("pull_request", badClock)).status).toBe(400);
    const badLink = { ...event, pull_request: { ...event.pull_request, html_url: "javascript:alert(1)" } };
    expect((await deliver("pull_request", badLink)).status).toBe(400);
    expect(await pullRequestsOn(board)).toEqual([]);
  });

  it("drops events from repos that are not connected", async () => {
    const board = await newBoard(1);
    await connect(REPO_ID, REPO_NAME);

    const response = await deliver("pull_request", pullRequestEvent({ repoId: 999, repoName: "Stranger/elsewhere", title: `${board.key}-1` }));
    expect(response.status).toBe(200);
    expect(await pullRequestsOn(board)).toEqual([]);
  });
});

describe("a pull request's state on the card", () => {
  const stateOn = async (board: TestBoard, options: PullRequestOptions) => {
    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1`, ...options }));
    return (await pullRequestsOn(board))[0]?.state;
  };

  it("is open, draft, merged or closed", async () => {
    const board = await newBoard(4);
    await connect();
    const named = (index: number) => ({ number: index + 1, title: `${board.key}-${index + 1}` });

    await deliver("pull_request", pullRequestEvent({ ...named(0) }));
    await deliver("pull_request", pullRequestEvent({ ...named(1), draft: true }));
    await deliver("pull_request", pullRequestEvent({ ...named(2), action: "closed", state: "closed", merged: true }));
    await deliver("pull_request", pullRequestEvent({ ...named(3), action: "closed", state: "closed" }));

    expect(await Promise.all([0, 1, 2, 3].map(async (index) => (await pullRequestsOn(board, index))[0]?.state))).toEqual(["open", "draft", "merged", "closed"]);
  });

  it("follows the pull request through later events, with its new title", async () => {
    const board = await newBoard();
    await connect();

    expect(await stateOn(board, { updatedAt: at(0) })).toBe("open");
    expect(await stateOn(board, { action: "converted_to_draft", draft: true, updatedAt: at(10) })).toBe("draft");
    expect(await stateOn(board, { action: "ready_for_review", updatedAt: at(20) })).toBe("open");
    expect(await stateOn(board, { action: "closed", state: "closed", merged: true, title: `${board.key}-1 shipped`, updatedAt: at(30) })).toBe("merged");
    expect((await pullRequestsOn(board))[0]?.title).toBe(`${board.key}-1 shipped`);
  });

  // GitHub does not order deliveries and redelivers by hand: an older `updated_at` never writes. `updated_at` has
  // one-second resolution, so a follow-up in the same second as the stored event must still win.
  it("is not rolled back by a late or a repeated delivery", async () => {
    const board = await newBoard();
    await connect();

    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1`, updatedAt: at(0) }));
    const closed = pullRequestEvent({ action: "closed", state: "closed", merged: true, title: `${board.key}-1 merged`, updatedAt: at(60) });
    await deliver("pull_request", closed);

    const merged = [expect.objectContaining({ state: "merged", title: `${board.key}-1 merged`, updatedAt: BASE_TIME + 60_000 })];

    // An edit from half a minute earlier arrives late, and an older open event after it.
    await deliver("pull_request", pullRequestEvent({ action: "edited", title: `${board.key}-1 a stale title`, updatedAt: at(30) }));
    expect(await pullRequestsOn(board)).toEqual(merged);
    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1`, updatedAt: at(0) }));
    expect(await pullRequestsOn(board)).toEqual(merged);

    // The merge arrives a second time: nothing moves.
    await deliver("pull_request", closed);
    expect(await pullRequestsOn(board)).toEqual(merged);
  });

  it("takes a follow-up from the same second as the stored state, and stays quiet on a replay of it", async () => {
    const board = await newBoard();
    await connect();
    const number = 21;
    await deliver("pull_request", pullRequestEvent({ number, title: `${board.key}-1`, updatedAt: at(0) }));
    const live = await openSocket(board.id, board.cookie);

    // Opened and merged within one second: both carry the same `updated_at`, and the later event must win.
    const mergedAtOnce = pullRequestEvent({ number, action: "closed", state: "closed", merged: true, title: `${board.key}-1 shipped`, updatedAt: at(0) });
    await deliver("pull_request", mergedAtOnce);
    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number, state: "merged", title: `${board.key}-1 shipped` })]);

    // The same event again changes nothing, and tells nobody.
    await deliver("pull_request", mergedAtOnce);
    await deliver("pull_request", pullRequestEvent({ number, action: "edited", state: "closed", merged: true, title: `${board.key}-1 later`, updatedAt: at(5) }));
    await expect.poll(() => live.frames.filter((frame) => frame.type === "github.invalidated")).toHaveLength(2);
    live.close();
  });

  it("keeps updating a card's pull request after the text stops naming the key", async () => {
    const board = await newBoard();
    await connect();

    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1 login`, branch: "login-work", updatedAt: at(0) }));
    // Someone edits the key out of the title; the card must keep the PR and see it merge.
    await deliver("pull_request", pullRequestEvent({ action: "edited", title: "login", branch: "login-work", updatedAt: at(10) }));
    await deliver("pull_request", pullRequestEvent({ action: "closed", state: "closed", merged: true, title: "login", branch: "login-work", updatedAt: at(20) }));

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ state: "merged", title: "login" })]);
  });
});

describe("live updates", () => {
  const hintsFor = (socket: BoardSocket, cardId: string) =>
    socket.frames.filter((frame) => frame.type === "github.invalidated" && frame.scope === "card" && frame.cardId === cardId);

  it("tells the board's sockets which card changed, and no other board", async () => {
    const board = await newBoard(2);
    const other = await newBoard(1);
    await connect();
    const live = await openSocket(board.id, board.cookie);
    const elsewhere = await openSocket(other.id, other.cookie);

    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1` }));

    await expect.poll(() => hintsFor(live, board.cardIds[0]!).length).toBe(1);
    expect(hintsFor(live, board.cardIds[1]!)).toHaveLength(0);
    expect(elsewhere.frames.filter((frame) => frame.type === "github.invalidated")).toHaveLength(0);
    live.close();
    elsewhere.close();
  });

  it("says nothing when an event changes nothing", async () => {
    const board = await newBoard(1);
    await connect();
    const event = pullRequestEvent({ title: `${board.key}-1` });
    await deliver("pull_request", event);
    const live = await openSocket(board.id, board.cookie);

    await deliver("pull_request", event);
    // A second, newer event is the marker: once its hint arrives, the repeat has had its chance to speak.
    await deliver("pull_request", pullRequestEvent({ title: `${board.key}-1 renamed`, updatedAt: at(5) }));
    await expect.poll(() => hintsFor(live, board.cardIds[0]!).length).toBeGreaterThan(0);
    expect(hintsFor(live, board.cardIds[0]!)).toHaveLength(1);
    live.close();
  });
});

describe("reading a card's development info", () => {
  it("is limited to members of the board, and to cards that exist", async () => {
    const board = await newBoard(1);
    const read = (path: string, cookie?: string) => SELF.fetch(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
    const path = `/boards/${board.id}/cards/${board.cardIds[0]}/development`;

    const invite = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { cookie: board.cookie } });
    expect(invite.status).toBe(201);
    const stranger = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `stranger-${board.key}@example.com`, name: "Stranger", password: PASSWORD, invite: (await invite.json<{ token: string }>()).token }),
    });
    expect(stranger.status).toBe(200);

    expect((await read(path)).status).toBe(401);
    expect((await read(path, stranger.headers.get("set-cookie")!.split(";")[0]!)).status).toBe(403);
    expect((await read(path, board.cookie)).status).toBe(200);
    expect((await read(`/boards/${board.id}/cards/no-such-card/development`, board.cookie)).status).toBe(404);
  });
});
