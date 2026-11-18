import { SELF, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainBackfill } from "../src/github-backfill";
import { connectRepos, enqueueBackfill } from "../src/github-repos";
import { API, ORIGIN, OWNER, adminSession, deliver, github, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * Backfill on connect (ADR 0064): installing the App, or adding repos to it, loads
 * the repo's existing open PRs, its branches and the PRs closed in the last 30 days,
 * through the same matcher and board writes as webhooks. Driven by signed
 * `installation` and `installation_repositories` deliveries through the real Worker;
 * GitHub's list endpoints are faked on top of the shared fake, and every request the
 * Worker makes to them is recorded, so the window and the paging are asserted on the wire.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;
const DAY = 24 * 60 * 60 * 1000;
// A branch's commit time is GitHub's, so it must not move between reads.
const COMMITTED = new Date(Date.now() - DAY).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** `repo` limits a pull to one repo's lists; without it every repo lists it. */
type FakePull = { number: number; title: string; state: "open" | "closed"; updated: string; closed?: string; merged?: boolean; draft?: boolean; head?: string; body?: string; repo?: string };
type FakeBranch = { name: string; sha: string; message?: string };

/** What the fake GitHub lists for the repo, plus a record of what the Worker asked. `limit` answers list calls with a 429. */
const fake = {
  pulls: [] as FakePull[],
  branches: [] as FakeBranch[],
  pullRequests: [] as string[],
  branchLists: [] as string[],
  branchReads: [] as string[],
  limit: null as { retryAfter: number } | null,
  /** `down` fails every PR list with a 500; `attemptsSeen` is the queue row's `attempts` at the moment each list was asked for. */
  down: false,
  attemptsSeen: [] as number[],
};

let kitFetch: typeof fetch;
beforeEach(() => {
  Object.assign(fake, { pulls: [], branches: [], pullRequests: [], branchLists: [], branchReads: [], limit: null, down: false, attemptsSeen: [] });
  kitFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = url.origin === API && url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(pulls|branches)(?:\/(.+))?$/);
    if (!match) return kitFetch(input, init);
    const [, full, kind, name] = match;
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    if (fake.limit && !name) return Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 429, headers: { "retry-after": String(fake.limit.retryAfter) } });
    if (kind === "pulls") {
      fake.attemptsSeen.push((await env.DB.prepare("SELECT attempts FROM github_backfill_queue WHERE repo_id = ?").bind(REPO_ID).first<{ attempts: number }>())?.attempts ?? -1);
      if (fake.down) return Response.json({ message: "Server Error" }, { status: 500 });
      const state = url.searchParams.get("state");
      fake.pullRequests.push(`${state} page ${page} ${url.searchParams.get("sort")} ${url.searchParams.get("direction")}`);
      const listed = fake.pulls
        .filter((pull) => pull.state === state && (!pull.repo || pull.repo === full))
        .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
        .slice((page - 1) * perPage, page * perPage);
      return Response.json(
        listed.map((pull) => ({
          number: pull.number,
          title: pull.title,
          body: pull.body ?? null,
          state: pull.state,
          draft: pull.draft ?? false,
          merged_at: pull.merged ? pull.closed : null,
          closed_at: pull.closed ?? null,
          html_url: `https://github.example/${REPO_NAME}/pull/${pull.number}`,
          updated_at: pull.updated,
          head: { ref: pull.head ?? "topic" },
        })),
      );
    }
    if (!name) {
      fake.branchLists.push(`page ${page}`);
      return Response.json(fake.branches.slice((page - 1) * perPage, page * perPage).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
    }
    fake.branchReads.push(decodeURIComponent(name));
    const branch = fake.branches.find((candidate) => candidate.name === decodeURIComponent(name));
    if (!branch) return Response.json({ message: "Branch not found" }, { status: 404 });
    return Response.json({
      name: branch.name,
      commit: { sha: branch.sha, commit: { message: branch.message ?? "Work", committer: { date: COMMITTED } } },
      _links: { html: `https://github.example/${REPO_NAME}/tree/${branch.name}` },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = kitFetch;
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

type TestBoard = { id: string; key: string; cookie: string; cardIds: string[] };

/** A new board with `cardCount` cards, numbered 1..cardCount in creation order. */
async function newBoard(cardCount = 1): Promise<TestBoard> {
  const cookie = await adminSession();
  const key = `B${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
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

type Development = { pullRequests: Array<{ number: number; state: string; title: string }>; branches: Array<{ name: string; sha: string }> };

async function developmentOf(board: TestBoard, index = 0): Promise<Development> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardIds[index]}/development`, { headers: { cookie: board.cookie } });
  expect(response.status).toBe(200);
  return response.json<Development>();
}

const prNumbers = async (board: TestBoard, index = 0) => (await developmentOf(board, index)).pullRequests.map((pr) => pr.number).sort((a, b) => a - b);
const branchNames = async (board: TestBoard, index = 0) => (await developmentOf(board, index)).branches.map((branch) => branch.name).sort();

/** The backfill runs after the webhook answers; it is over when the repo has left the queue. */
async function backfillDone() {
  await expect.poll(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM github_backfill_queue").first<{ n: number }>())!.n).toBe(0);
}

async function install(repos = [repo(REPO_ID, REPO_NAME)]) {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: repos });
  expect(response.status).toBe(200);
}

describe("backfill after the App is installed", () => {
  it("fills cards with open PRs, closed PRs from the last 30 days and branches that name their task key", async () => {
    const board = await newBoard(3);
    fake.pulls = [
      { number: 1, title: `${board.key}-1 add login`, state: "open", updated: daysAgo(2) },
      // An open PR nobody touched for two months is still open work.
      { number: 2, title: "Stale but open", state: "open", updated: daysAgo(60), head: `${board.key.toLowerCase()}-2-old-work` },
      { number: 3, title: `${board.key}-3 done`, state: "closed", updated: daysAgo(3), closed: daysAgo(3), merged: true },
      { number: 4, title: `${board.key}-1 abandoned`, state: "closed", updated: daysAgo(20), closed: daysAgo(20) },
      { number: 5, title: `${board.key}-3 ancient`, state: "closed", updated: daysAgo(45), closed: daysAgo(45), merged: true },
      { number: 6, title: "No key at all", state: "open", updated: daysAgo(1) },
    ];
    fake.branches = [
      { name: "main", sha: "0".repeat(40) },
      { name: `feature/${board.key}-2-cache`, sha: "b".repeat(40) },
      { name: "wip-no-key", sha: "c".repeat(40) },
    ];

    await install();
    await backfillDone();

    expect(await prNumbers(board, 0)).toEqual([1, 4]);
    expect(await prNumbers(board, 1)).toEqual([2]);
    expect(await prNumbers(board, 2)).toEqual([3]);
    const merged = (await developmentOf(board, 2)).pullRequests[0]!;
    expect(merged.state).toBe("merged");
    expect(await branchNames(board, 1)).toEqual([`feature/${board.key}-2-cache`]);
    expect(await branchNames(board, 0)).toEqual([]);
    // Only a branch whose name holds a key of a known board costs a read.
    expect(fake.branchReads).toEqual([`feature/${board.key}-2-cache`]);
  });

  it("asks for open PRs and for closed PRs newest-update-first, and stops paging at the 30-day cutoff", async () => {
    const board = await newBoard(1);
    // 130 closed PRs inside the window (two pages and a bit), then old ones that must never be paged to.
    fake.pulls = [
      ...Array.from({ length: 130 }, (_, index): FakePull => ({
        number: 1000 + index,
        title: index === 0 ? `${board.key}-1 newest` : "chore",
        state: "closed",
        updated: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        closed: daysAgo(1),
      })),
      ...Array.from({ length: 250 }, (_, index): FakePull => ({
        number: 5000 + index,
        title: `${board.key}-1 old ${index}`,
        state: "closed",
        updated: daysAgo(40 + index / 100),
        closed: daysAgo(40),
      })),
    ];
    // 150 open PRs: no window applies to them, so all of them are listed.
    fake.pulls.push(...Array.from({ length: 150 }, (_, index): FakePull => ({ number: 9000 + index, title: "open", state: "open", updated: daysAgo(100 + index) })));

    await install();
    await backfillDone();

    expect(fake.pullRequests.filter((call) => call.startsWith("open"))).toEqual(["open page 1 updated desc", "open page 2 updated desc"]);
    // Page 1 is all in the window, page 2 crosses the cutoff: page 3 is never requested.
    expect(fake.pullRequests.filter((call) => call.startsWith("closed"))).toEqual(["closed page 1 updated desc", "closed page 2 updated desc"]);
    expect(await prNumbers(board)).toEqual([1000]);
  });

  it("lists every branch page but reads only keyed names, so a big repo stays cheap", async () => {
    const board = await newBoard(1);
    fake.branches = [
      ...Array.from({ length: 250 }, (_, index): FakeBranch => ({ name: `topic-${index}`, sha: "d".repeat(40) })),
      { name: `${board.key}-1-late-alphabet`, sha: "e".repeat(40) },
    ];

    await install();
    await backfillDone();

    expect(fake.branchLists).toEqual(["page 1", "page 2", "page 3"]);
    expect(fake.branchReads).toEqual([`${board.key}-1-late-alphabet`]);
    expect(await branchNames(board)).toEqual([`${board.key}-1-late-alphabet`]);
  });

  it("uses the installation's token, not the App's, for every list call", async () => {
    await newBoard(1);
    fake.pulls = [{ number: 1, title: "x", state: "open", updated: daysAgo(1) }];
    await install();
    await backfillDone();
    expect(github.calls).toContain("POST /app/installations/7/access_tokens");
    expect(fake.pullRequests.length).toBeGreaterThan(0);
  });

  it("does nothing for an installation on someone else's account", async () => {
    const board = await newBoard(1);
    fake.pulls = [{ number: 1, title: `${board.key}-1 x`, state: "open", updated: daysAgo(1) }];
    const response = await deliver("installation", { action: "created", installation: installation(8, "Stranger"), repositories: [repo(REPO_ID, REPO_NAME)] });
    expect(await response.json()).toEqual({ result: "ignored" });
    await backfillDone();
    expect(fake.pullRequests).toEqual([]);
    expect(await prNumbers(board)).toEqual([]);
  });
});

describe("backfill after repos are added", () => {
  it("backfills only the repos that were added", async () => {
    const board = await newBoard(1);
    await install([repo(REPO_ID, REPO_NAME)]);
    await backfillDone();
    fake.pullRequests.length = 0;
    fake.pulls = [{ number: 7, title: `${board.key}-1 from the new repo`, state: "open", updated: daysAgo(1) }];

    const response = await deliver("installation_repositories", {
      action: "added",
      installation: installation(),
      repositories_added: [repo(202, `${OWNER}/web`)],
      repositories_removed: [],
    });
    expect(response.status).toBe(200);
    await backfillDone();

    expect(await prNumbers(board)).toEqual([7]);
    // One repo, two lists (open, closed): the repo that was already connected was not read again.
    expect(fake.pullRequests).toHaveLength(2);
  });
});

describe("backfill after the Admin page finds a repo no webhook announced", () => {
  const nudge = () => deliver("installation_repositories", { action: "added", installation: installation(), repositories_added: [], repositories_removed: [] });

  it("queues the repos the re-read newly connects, and only those", async () => {
    const board = await newBoard(1);
    fake.pulls = [{ number: 3, title: `${board.key}-1 from a missed delivery`, state: "open", updated: daysAgo(1) }];
    // GitHub has the installation, but its webhook never arrived: the Admin page's re-read is the only way in.
    github.installations = [{ id: 7, account: OWNER, repos: [{ id: REPO_ID, full_name: REPO_NAME }] }];
    const admin = await adminSession();

    expect((await SELF.fetch(`${ORIGIN}/github-app`, { headers: { cookie: admin } })).status).toBe(200);
    // Any later delivery drains the queue, the way the minute cron does.
    await nudge();
    await backfillDone();
    expect(await prNumbers(board)).toEqual([3]);

    // The repo is connected now: reading the page again asks GitHub for nothing more.
    fake.pullRequests.length = 0;
    expect((await SELF.fetch(`${ORIGIN}/github-app`, { headers: { cookie: admin } })).status).toBe(200);
    await nudge();
    await backfillDone();
    expect(fake.pullRequests).toEqual([]);
  });
});

describe("running the backfill again", () => {
  it("changes nothing: same cards, no new announcements", async () => {
    const board = await newBoard(1);
    fake.pulls = [
      { number: 1, title: `${board.key}-1 open`, state: "open", updated: daysAgo(2) },
      { number: 2, title: `${board.key}-1 merged`, state: "closed", updated: daysAgo(5), closed: daysAgo(5), merged: true },
    ];
    fake.branches = [{ name: `${board.key}-1-work`, sha: "f".repeat(40) }];
    await install();
    await backfillDone();
    const before = await developmentOf(board);
    expect(before.pullRequests).toHaveLength(2);
    expect(before.branches).toHaveLength(1);

    const socket = await openSocket(board.id, board.cookie);
    fake.pullRequests.length = 0;
    const again = await deliver("installation_repositories", {
      action: "added",
      installation: installation(),
      repositories_added: [repo(REPO_ID, REPO_NAME)],
      repositories_removed: [],
    });
    expect(again.status).toBe(200);
    await expect.poll(() => fake.pullRequests.length).toBe(2);
    await backfillDone();

    expect(await developmentOf(board)).toEqual(before);
    expect(socket.frames.filter((frame) => frame.type === "github.invalidated")).toEqual([]);
    socket.close();
  });
});

describe("GitHub's rate limits", () => {
  it("holds a limited repo until Retry-After has passed, then finishes it", async () => {
    const board = await newBoard(1);
    fake.pulls = [{ number: 1, title: `${board.key}-1 x`, state: "open", updated: daysAgo(1) }];
    fake.limit = { retryAfter: 120 };

    await install();
    await expect.poll(() => fake.pullRequests.length).toBe(0);
    await expect.poll(async () => (await env.DB.prepare("SELECT run_after AS at FROM github_backfill_queue").first<{ at: number }>())?.at ?? 0).toBeGreaterThan(Date.now() + 110_000);
    const callsWhileLimited = github.calls.length;

    // Another delivery nudges the queue, but the repo is not due, so GitHub is not asked again.
    await deliver("installation_repositories", { action: "added", installation: installation(), repositories_added: [], repositories_removed: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(github.calls.length).toBe(callsWhileLimited);
    expect(await prNumbers(board)).toEqual([]);

    // Time passes (the clock cannot be moved, so the hold is lifted in the row) and the next nudge finishes the job.
    fake.limit = null;
    await env.DB.exec("UPDATE github_backfill_queue SET run_after = 0");
    await deliver("installation_repositories", { action: "added", installation: installation(), repositories_added: [], repositories_removed: [] });
    await backfillDone();
    expect(await prNumbers(board)).toEqual([1]);
  });
});

describe("a repo whose backfill keeps failing", () => {
  const attemptsOf = async () => (await env.DB.prepare("SELECT attempts FROM github_backfill_queue WHERE repo_id = ?").bind(REPO_ID).first<{ attempts: number }>())?.attempts;
  const nudge = () => deliver("installation_repositories", { action: "added", installation: installation(), repositories_added: [], repositories_removed: [] });

  it("counts each claim as an attempt, before any work, and gives up after five", async () => {
    fake.down = true;
    await install();
    await expect.poll(attemptsOf).toBe(1);
    // The claim had already counted the attempt when GitHub was first asked.
    expect(fake.attemptsSeen[0]).toBe(1);

    for (const attempt of [2, 3, 4]) {
      await env.DB.exec("UPDATE github_backfill_queue SET run_after = 0");
      await nudge();
      await expect.poll(attemptsOf).toBe(attempt);
    }
    await env.DB.exec("UPDATE github_backfill_queue SET run_after = 0");
    await nudge();
    await backfillDone();
  });

  it("does not count a rate limit against the repo", async () => {
    fake.limit = { retryAfter: 120 };
    await install();
    await expect.poll(async () => (await env.DB.prepare("SELECT run_after AS at FROM github_backfill_queue").first<{ at: number }>())?.at ?? 0).toBeGreaterThan(Date.now() + 110_000);
    expect(await attemptsOf()).toBe(0);
  });
});

describe("a repo too big for one drain's subrequests", () => {
  const queue = async () => (await env.DB.prepare("SELECT repo_id AS id, attempts, run_after AS at FROM github_backfill_queue ORDER BY repo_id").all<{ id: number; attempts: number; at: number }>()).results;

  it("is held like a failure and dropped after five attempts, and the repos behind it still run", async () => {
    // Seven full pages of open PRs, a ceiling of six subrequests: the repo never fits. The small repo behind it needs five.
    fake.pulls = Array.from({ length: 650 }, (_, index): FakePull => ({ number: index + 1, title: "open", state: "open", updated: daysAgo(100 + index / 100), repo: REPO_NAME }));
    const SMALL_ID = 102;
    // Storage is shared between tests: start from an empty queue, not the previous test's held repo.
    await env.DB.exec("DELETE FROM github_backfill_queue");
    await connectRepos(env, 7, [
      { id: REPO_ID, fullName: REPO_NAME, private: false },
      { id: SMALL_ID, fullName: `${OWNER}/small`, private: false },
    ]);
    await enqueueBackfill(env, [REPO_ID, SMALL_ID]);

    await drainBackfill(env, 6);
    const [big, small] = await queue();
    expect(big).toMatchObject({ id: REPO_ID, attempts: 1 });
    // Held with the failure delay, not due now: it cannot be claimed first again.
    expect(big.at).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(small).toMatchObject({ id: SMALL_ID, attempts: 0, at: 0 });

    await drainBackfill(env, 6);
    expect(await queue()).toEqual([expect.objectContaining({ id: REPO_ID, attempts: 1 })]);

    for (const attempts of [2, 3, 4]) {
      await env.DB.exec("UPDATE github_backfill_queue SET run_after = 0");
      await drainBackfill(env, 6);
      expect(await queue()).toEqual([expect.objectContaining({ id: REPO_ID, attempts })]);
    }
    await env.DB.exec("UPDATE github_backfill_queue SET run_after = 0");
    await drainBackfill(env, 6);
    expect(await queue()).toEqual([]);
  });
});
