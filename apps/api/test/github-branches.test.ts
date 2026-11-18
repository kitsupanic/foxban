import { SELF, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API, ORIGIN, OWNER, PASSWORD, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * Branches on cards (ADR 0064): signed `push`, `create` and `delete` webhooks in,
 * card reads and board sockets out, through the real Worker. These events carry no
 * usable clock, so the Worker re-reads the branch from GitHub (faked here, on top of
 * the shared fake) and a card shows what GitHub answered, not what the payload said.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;
const BASE_TIME = Date.UTC(2026, 10, 12, 10, 0, 0);
const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000).toISOString();

type FakeBranch = { sha: string; message: string; date: string };
/** Branches the fake GitHub has, by `owner/repo/name`; `reads` counts branch reads, `down` makes them fail. */
const branches = { heads: new Map<string, FakeBranch>(), reads: 0, down: false, tokens: [] as string[] };

let kitFetch: typeof fetch;
beforeEach(() => {
  Object.assign(branches, { heads: new Map(), reads: 0, down: false, tokens: [] });
  kitFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = url.origin === API && url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/);
    if (!match) return kitFetch(input, init);
    branches.reads += 1;
    branches.tokens.push(new Headers(init?.headers).get("authorization") ?? "");
    if (branches.down) return Response.json({ message: "Service Unavailable" }, { status: 503 });
    const name = decodeURIComponent(match[2]!);
    const head = branches.heads.get(`${match[1]}/${name}`);
    if (!head) return Response.json({ message: "Branch not found" }, { status: 404 });
    return Response.json({
      name,
      commit: { sha: head.sha, commit: { message: head.message, author: { date: "2001-01-01T00:00:00Z" }, committer: { date: head.date } } },
      _links: { html: `https://github.example/${match[1]}/tree/${name}` },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = kitFetch;
});

/** Puts the branch on the fake GitHub, as a push or a branch creation would. */
function setBranch(name: string, sha: string, message = "Work", seconds = 0, repoName = REPO_NAME) {
  branches.heads.set(`${repoName}/${name}`, { sha, message, date: at(seconds) });
}

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

type TestBoard = { id: string; key: string; cookie: string; cardIds: string[] };

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
  socket.close();
  return { id, key, cookie, cardIds };
}

type Branch = { repositoryId: number; repository: string; name: string; url: string; sha: string; message: string; committedAt: number };

/** What the card's Development section reads. */
async function branchesOn(board: TestBoard, index = 0): Promise<Branch[]> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development`, { headers: { cookie: board.cookie } });
  expect(response.status).toBe(200);
  return (await response.json<{ branches: Branch[] }>()).branches;
}

async function connect(repoId = REPO_ID, fullName = REPO_NAME) {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(repoId, fullName)] });
  expect(response.status).toBe(200);
}

const pushEvent = (name: string, options: { repoId?: number; repoName?: string; after?: string; ref?: string } = {}) => ({
  ref: options.ref ?? `refs/heads/${name}`,
  after: options.after ?? "0".repeat(40),
  deleted: false,
  repository: repo(options.repoId ?? REPO_ID, options.repoName ?? REPO_NAME),
  commits: [{ id: options.after ?? "0".repeat(40), timestamp: "1999-01-01T00:00:00Z" }],
});
const branchEvent = (name: string, refType = "branch") => ({ ref: name, ref_type: refType, repository: repo(REPO_ID, REPO_NAME) });

describe("a branch that names a task key", () => {
  it("shows on that card with its repo, name, link and latest commit", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key.toLowerCase()}-1-fix-login`;
    setBranch(name, "a".repeat(40), "Fix the login\n\nLonger explanation", 5);

    const response = await deliver("create", branchEvent(name));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "applied" });

    expect(await branchesOn(board)).toEqual([
      {
        repositoryId: REPO_ID,
        repository: REPO_NAME,
        name,
        url: `https://github.example/${REPO_NAME}/tree/${name}`,
        sha: "a".repeat(40),
        message: "Fix the login",
        committedAt: BASE_TIME + 5000,
      },
    ]);
  });

  it("reads the branch with the installation's token, not the App's", async () => {
    const board = await newBoard();
    await connect();
    setBranch(`${board.key}-1-x`, "b".repeat(40));

    await deliver("create", branchEvent(`${board.key}-1-x`));

    expect(branches.tokens).toEqual(["Bearer ghs_installation_7"]);
  });

  it("finds the key in any case, including in a slashed name, and links every card it names", async () => {
    const board = await newBoard(2);
    await connect();
    const name = `feature/${board.key.toLowerCase()}-1_and_${board.key}-2`;
    setBranch(name, "c".repeat(40));

    await deliver("create", branchEvent(name));

    expect((await branchesOn(board, 0)).map((b) => b.name)).toEqual([name]);
    expect((await branchesOn(board, 1)).map((b) => b.name)).toEqual([name]);
  });

  it("ignores names that hold no key for a card, without asking GitHub", async () => {
    const board = await newBoard(1);
    await connect();
    setBranch("main", "d".repeat(40));
    setBranch(`${board.key}-99-nope`, "d".repeat(40));
    setBranch(`${board.key}-10-near-miss`, "d".repeat(40));

    for (const name of ["main", `${board.key}-99-nope`, `${board.key}-10-near-miss`]) {
      expect(await (await deliver("create", branchEvent(name))).json()).toEqual({ result: "dropped" });
    }
    expect(await branchesOn(board)).toEqual([]);
    // Only the one that names a real board's key (any card number) is worth a read.
    expect(branches.reads).toBe(2);
  });

  it("ignores tags, tag pushes and repos that are not connected", async () => {
    const board = await newBoard(1);
    await connect();
    const name = `${board.key}-1-x`;
    setBranch(name, "e".repeat(40));
    setBranch(name, "e".repeat(40), "Elsewhere", 0, "Stranger/elsewhere");

    expect(await (await deliver("create", branchEvent(name, "tag"))).json()).toEqual({ result: "dropped" });
    expect(await (await deliver("push", pushEvent(name, { ref: `refs/tags/${name}` }))).json()).toEqual({ result: "dropped" });
    const stranger = await deliver("push", pushEvent(name, { repoId: 999, repoName: "Stranger/elsewhere" }));
    expect(await stranger.json()).toEqual({ result: "dropped" });

    expect(await branchesOn(board)).toEqual([]);
    expect(branches.reads).toBe(0);
  });
});

describe("a branch's latest commit", () => {
  it("follows pushes, and comes from GitHub rather than the payload", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40), "First", 0);
    await deliver("create", branchEvent(name));

    // The payload names a stale commit and an old timestamp; GitHub says the tip moved on.
    setBranch(name, "2".repeat(40), "Second", 60);
    await deliver("push", pushEvent(name, { after: "9".repeat(40) }));

    expect(await branchesOn(board)).toEqual([expect.objectContaining({ sha: "2".repeat(40), message: "Second", committedAt: BASE_TIME + 60_000 })]);
  });

  it("holds one row per branch, with no commit history", async () => {
    const board = await newBoard();
    await connect();
    const first = `${board.key}-1-a`;
    const second = `${board.key}-1-b`;
    setBranch(first, "1".repeat(40), "A1", 0);
    setBranch(second, "3".repeat(40), "B1", 30);
    await deliver("create", branchEvent(first));
    await deliver("create", branchEvent(second));
    for (let i = 2; i <= 4; i++) {
      setBranch(first, String(i).repeat(40), `A${i}`, i * 10);
      await deliver("push", pushEvent(first));
    }

    const shown = await branchesOn(board);
    // Most recent commit first; each branch only its latest commit.
    expect(shown.map((b) => [b.name, b.message])).toEqual([
      [first, "A4"],
      [second, "B1"],
    ]);
    expect(Object.keys(shown[0]!).sort()).toEqual(["committedAt", "message", "name", "repository", "repositoryId", "sha", "url"]);
  });

  it("answers 502 and changes nothing when GitHub cannot be asked", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40), "First", 0);
    await deliver("create", branchEvent(name));

    branches.down = true;
    setBranch(name, "2".repeat(40), "Second", 10);
    expect((await deliver("push", pushEvent(name))).status).toBe(502);
    expect((await branchesOn(board))[0]?.message).toBe("First");
  });

  it("queues the repo for a backfill when the event fails, so the minute cron repairs the card", async () => {
    const board = await newBoard();
    await connect();
    // Let the backfill that connecting started settle (finished, or held for a retry), then start from an empty queue.
    await expect.poll(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM github_backfill_queue WHERE run_after <= ?").bind(Date.now() + 3 * 60_000).first<{ n: number }>())!.n).toBe(0);
    await env.DB.exec("DELETE FROM github_backfill_queue");
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40), "First", 0);

    branches.down = true;
    expect((await deliver("push", pushEvent(name))).status).toBe(502);
    const queued = await env.DB.prepare("SELECT repo_id AS repoId, run_after AS runAfter FROM github_backfill_queue").all<{ repoId: number; runAfter: number }>();
    expect(queued.results).toEqual([{ repoId: REPO_ID, runAfter: 0 }]);
  });
});

describe("a deleted branch", () => {
  it("disappears from the card", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40));
    await deliver("create", branchEvent(name));
    expect(await branchesOn(board)).toHaveLength(1);

    branches.heads.clear();
    const response = await deliver("delete", branchEvent(name));
    expect(await response.json()).toEqual({ result: "applied" });

    expect(await branchesOn(board)).toEqual([]);
  });

  it("stays when GitHub still has it, because the event is not trusted over a read", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40));
    await deliver("create", branchEvent(name));

    // A delete delivered after the branch was made again.
    await deliver("delete", branchEvent(name));

    expect(await branchesOn(board)).toHaveLength(1);
  });

  it("is also noticed from a push that finds the branch gone", async () => {
    const board = await newBoard();
    await connect();
    const name = `${board.key}-1-work`;
    setBranch(name, "1".repeat(40));
    await deliver("create", branchEvent(name));

    branches.heads.clear();
    await deliver("push", pushEvent(name));

    expect(await branchesOn(board)).toEqual([]);
  });
});

describe("live updates", () => {
  const hintsFor = (socket: BoardSocket, cardId: string) =>
    socket.frames.filter((frame) => frame.type === "github.invalidated" && frame.scope === "card" && frame.cardId === cardId);

  it("tells the board's sockets on a new branch, a moved tip and a delete, and says nothing when nothing changed", async () => {
    const board = await newBoard(1);
    const other = await newBoard(1);
    await connect();
    const live = await openSocket(board.id, board.cookie);
    const elsewhere = await openSocket(other.id, other.cookie);
    const name = `${board.key}-1-work`;
    const card = board.cardIds[0]!;

    setBranch(name, "1".repeat(40), "First", 0);
    await deliver("create", branchEvent(name));
    await expect.poll(() => hintsFor(live, card).length).toBe(1);

    // The same tip again is no change.
    await deliver("push", pushEvent(name));
    setBranch(name, "2".repeat(40), "Second", 10);
    await deliver("push", pushEvent(name));
    await expect.poll(() => hintsFor(live, card).length).toBe(2);

    branches.heads.clear();
    await deliver("delete", branchEvent(name));
    await expect.poll(() => hintsFor(live, card).length).toBe(3);

    expect(elsewhere.frames.filter((frame) => frame.type === "github.invalidated")).toHaveLength(0);
    live.close();
    elsewhere.close();
  });
});

/** A branch's way through the board's own life (ADR 0064): the card moves, its board key is edited, a member unlinks it, the card is purged. */
describe("a linked branch through the life of its card", () => {
  /** Sends one mutation on a short-lived socket and waits for the board to echo it back. */
  async function mutate(board: TestBoard, message: { type: string; [field: string]: unknown }) {
    const socket = await openSocket(board.id, board.cookie);
    socket.send({ mutationId: crypto.randomUUID(), ...message });
    await expect.poll(() => socket.frames.some((frame) => frame.type === message.type || (message.type === "card.purge" && frame.type === "archive.purged"))).toBe(true);
    socket.close();
  }
  async function purge(board: TestBoard, cardId = board.cardIds[0]!) {
    await mutate(board, { type: "card.delete", id: cardId });
    await mutate(board, { type: "card.purge", id: cardId });
  }
  const transfer = (source: TestBoard, destination: TestBoard, cardId = source.cardIds[0]!) =>
    SELF.fetch(`${ORIGIN}/boards/${source.id}/cards/${cardId}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: source.cookie },
      body: JSON.stringify({ transferId: crypto.randomUUID(), destinationBoardId: destination.id, destinationColumnId: "col" }),
    });
  const editKey = (board: TestBoard, key: string) =>
    SELF.fetch(`${ORIGIN}/boards/${board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: board.cookie },
      body: JSON.stringify({ name: `Board ${key}`, key }),
    });
  /** Whether the D1 routing table points the branch at the board: the one thing no public route shows. */
  async function routed(board: TestBoard, name: string): Promise<boolean> {
    const row = await env.DB.prepare("SELECT 1 AS found FROM github_branch_routes WHERE repo_id = ? AND branch_name = ? AND board_id = ?").bind(REPO_ID, name, board.id).first();
    return row !== null;
  }
  const developmentOf = (board: TestBoard, cardId: string) =>
    SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${cardId}/development`, { headers: { cookie: board.cookie } });

  describe("when its card moves to another board", () => {
    it("goes with the card, and later events still reach it there", async () => {
      const source = await newBoard();
      const destination = await newBoard();
      await connect();
      const cardId = source.cardIds[0]!;
      const name = `${source.key.toLowerCase()}-1-move-me`;
      setBranch(name, "1".repeat(40), "Before the move", 5);
      await deliver("create", branchEvent(name));

      expect((await transfer(source, destination)).status).toBe(200);

      expect((await (await developmentOf(destination, cardId)).json<{ branches: Branch[] }>()).branches).toEqual([
        expect.objectContaining({ name, sha: "1".repeat(40), message: "Before the move", committedAt: BASE_TIME + 5000 }),
      ]);
      expect((await developmentOf(source, cardId)).status).toBe(404);

      // The name still holds the source's key; only the routing row can bring this event to the destination.
      setBranch(name, "2".repeat(40), "After the move", 60);
      await deliver("push", pushEvent(name));
      expect((await (await developmentOf(destination, cardId)).json<{ branches: Branch[] }>()).branches).toEqual([
        expect.objectContaining({ sha: "2".repeat(40), message: "After the move" }),
      ]);

      branches.heads.clear();
      await deliver("delete", branchEvent(name));
      expect((await (await developmentOf(destination, cardId)).json<{ branches: Branch[] }>()).branches).toEqual([]);
    });

    it("moves its routing row to the destination board", async () => {
      const source = await newBoard();
      const destination = await newBoard();
      await connect();
      const name = `${source.key.toLowerCase()}-1-route`;
      setBranch(name, "1".repeat(40));
      await deliver("create", branchEvent(name));
      expect(await routed(source, name)).toBe(true);

      expect((await transfer(source, destination)).status).toBe(200);

      expect(await routed(destination, name)).toBe(true);
      await expect.poll(() => routed(source, name)).toBe(false);
    });
  });

  describe("when its board's key is edited", () => {
    it("keeps following pushes and still applies a delete, though the name holds the old key", async () => {
      const board = await newBoard();
      await connect();
      const name = `${board.key.toLowerCase()}-1-long-lived`;
      setBranch(name, "1".repeat(40), "First", 0);
      await deliver("create", branchEvent(name));
      expect((await editKey(board, `N${board.key.slice(1)}`)).status).toBe(200);

      setBranch(name, "2".repeat(40), "Second", 30);
      expect(await (await deliver("push", pushEvent(name))).json()).toEqual({ result: "applied" });
      expect(await branchesOn(board)).toEqual([expect.objectContaining({ sha: "2".repeat(40), message: "Second" })]);

      branches.heads.clear();
      await deliver("delete", branchEvent(name));
      expect(await branchesOn(board)).toEqual([]);
    });

    it("does not link a branch that names only the old key", async () => {
      const board = await newBoard();
      await connect();
      const oldKey = board.key;
      expect((await editKey(board, `N${board.key.slice(1)}`)).status).toBe(200);
      const name = `${oldKey.toLowerCase()}-1-new`;
      setBranch(name, "1".repeat(40));

      expect(await (await deliver("create", branchEvent(name))).json()).toEqual({ result: "dropped" });
      expect(await branchesOn(board)).toEqual([]);
    });
  });

  describe("when its card is purged", () => {
    it("drops the board's routing row, but keeps it while another card on the board holds the branch", async () => {
      const board = await newBoard(2);
      await connect();
      const name = `${board.key.toLowerCase()}-1_and_${board.key}-2`;
      setBranch(name, "1".repeat(40));
      await deliver("create", branchEvent(name));
      expect(await routed(board, name)).toBe(true);

      await purge(board, board.cardIds[0]!);
      expect(await routed(board, name)).toBe(true);

      await purge(board, board.cardIds[1]!);
      await expect.poll(() => routed(board, name)).toBe(false);
    });
  });
});

describe("unlinking a branch from a card", () => {
  const unlink = (board: TestBoard, name: string, options: { index?: number; cookie?: string; repositoryId?: string } = {}) =>
    SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[options.index ?? 0]}/development/branches/${options.repositoryId ?? REPO_ID}/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { cookie: options.cookie ?? board.cookie },
    });

  it("removes it from that card alone, answers with the card's development info, and holds against later events", async () => {
    const board = await newBoard(2);
    await connect();
    // A slash in the name travels encoded, and the name names both cards.
    const name = `feature/${board.key.toLowerCase()}-1_and_${board.key}-2`;
    setBranch(name, "1".repeat(40), "First", 0);
    await deliver("create", branchEvent(name));
    const live = await openSocket(board.id, board.cookie);

    const response = await unlink(board, name);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pullRequests: [], branches: [] });
    expect(await branchesOn(board, 0)).toEqual([]);
    expect(await branchesOn(board, 1)).toHaveLength(1);
    await expect.poll(() => live.frames.filter((frame) => frame.type === "github.invalidated" && frame.cardId === board.cardIds[0])).toHaveLength(1);

    // The tip moves and the branch is announced again: the other card follows, the unlinked one stays clear.
    setBranch(name, "2".repeat(40), "Second", 30);
    await deliver("push", pushEvent(name));
    expect(await branchesOn(board, 0)).toEqual([]);
    expect(await branchesOn(board, 1)).toEqual([expect.objectContaining({ sha: "2".repeat(40) })]);
    live.close();
  });

  it("answers 404 for a branch the card does not link, and 400 for a reference that is none", async () => {
    const board = await newBoard(1);
    await connect();
    const name = `${board.key.toLowerCase()}-1-x`;
    setBranch(name, "1".repeat(40));
    await deliver("create", branchEvent(name));

    expect(await (await unlink(board, "no-such-branch")).json()).toMatchObject({ code: "not_linked" });
    expect((await unlink(board, "no-such-branch")).status).toBe(404);
    expect((await unlink(board, name, { repositoryId: "abc" })).status).toBe(400);
    expect((await unlink(board, name, { repositoryId: "0" })).status).toBe(400);
    expect(await branchesOn(board)).toHaveLength(1);
    // Unlinking twice: the second finds nothing.
    expect((await unlink(board, name)).status).toBe(200);
    expect((await unlink(board, name)).status).toBe(404);
  });

  it("is limited to members of the board, and to cards that exist", async () => {
    const board = await newBoard(1);
    await connect();
    const name = `${board.key.toLowerCase()}-1-x`;
    setBranch(name, "1".repeat(40));
    await deliver("create", branchEvent(name));
    const invite = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { cookie: board.cookie } });
    const stranger = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `stranger-${board.key}@example.com`, name: "Stranger", password: PASSWORD, invite: (await invite.json<{ token: string }>()).token }),
    });
    expect(stranger.status).toBe(200);

    expect((await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[0]}/development/branches/${REPO_ID}/${name}`, { method: "DELETE" })).status).toBe(401);
    expect((await unlink(board, name, { cookie: stranger.headers.get("set-cookie")!.split(";")[0]! })).status).toBe(403);
    const missing = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/no-such-card/development/branches/${REPO_ID}/${name}`, { method: "DELETE", headers: { cookie: board.cookie } });
    expect(missing.status).toBe(404);
    expect(await branchesOn(board)).toHaveLength(1);
  });
});
