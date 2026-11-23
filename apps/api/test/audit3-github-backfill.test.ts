import { SELF, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainBackfill } from "../src/github-backfill";
import { enqueueBackfill } from "../src/github-repos";
import { API, ORIGIN, OWNER, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * Audit 3: the repair backfill must reach what is linked without a key in its text: a pull
 * request linked by hand, and a branch whose card moved to another board. Both are found
 * through the D1 routing tables, the way webhooks find them.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date().toISOString();

/** What the fake GitHub lists. `pull` is the one pull request, `branches` maps a branch name to its tip sha. */
const fake = { pull: null as { number: number; title: string; state: "open" | "closed"; merged: boolean } | null, branches: new Map<string, string>() };

let kitFetch: typeof fetch;
beforeEach(() => {
  Object.assign(fake, { pull: null, branches: new Map() });
  kitFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = url.origin === API && url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/(pulls|branches)(?:\/(.+))?$/);
    if (!match) return kitFetch(input, init);
    const [, kind, rest] = match;
    const pull = fake.pull;
    if (kind === "pulls") {
      const body = (item: NonNullable<typeof pull>) => ({
        number: item.number,
        title: item.title,
        body: null,
        state: item.state,
        draft: false,
        merged_at: item.merged ? NOW : null,
        closed_at: item.state === "closed" ? NOW : null,
        html_url: `https://github.example/${REPO_NAME}/pull/${item.number}`,
        updated_at: NOW,
        head: { ref: "topic" },
        base: { repo: { id: REPO_ID, full_name: REPO_NAME } },
      });
      if (rest) return pull ? Response.json(body(pull)) : Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(pull && pull.state === url.searchParams.get("state") && url.searchParams.get("page") === "1" ? [body(pull)] : []);
    }
    if (!rest) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(page === 1 ? [...fake.branches].map(([name, sha]) => ({ name, commit: { sha } })) : []);
    }
    const name = decodeURIComponent(rest);
    const sha = fake.branches.get(name);
    if (!sha) return Response.json({ message: "Branch not found" }, { status: 404 });
    return Response.json({
      name,
      commit: { sha, commit: { message: "Work", committer: { date: NOW } } },
      _links: { html: `https://github.example/${REPO_NAME}/tree/${name}` },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = kitFetch;
});

type BoardSocket = { frames: ServerMessage[]; send(message: object): void; close(): void };

async function openSocket(boardId: string, cookie: string): Promise<BoardSocket> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, { headers: { Upgrade: "websocket", cookie } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as ServerMessage);
  });
  socket.accept();
  return { frames, send: (message) => socket.send(JSON.stringify(message)), close: () => socket.close() };
}

type TestBoard = { id: string; key: string; cookie: string; cardId: string };

/** A new board with one card (task number 1); `cookie` reuses a user so two boards share a workspace. */
async function newBoard(cookie?: string): Promise<TestBoard> {
  cookie ??= await adminSession();
  const key = `A${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
  const created = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: `Board ${key}`, key, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(created.status).toBe(200);
  const { id } = await created.json<{ id: string }>();
  const socket = await openSocket(id, cookie);
  const cardId = crypto.randomUUID();
  socket.send({ type: "column.create", mutationId: crypto.randomUUID(), id: "col", title: "To do", position: "a0" });
  socket.send({ type: "card.create", mutationId: crypto.randomUUID(), id: cardId, columnId: "col", title: "Card", position: "a0" });
  await expect.poll(() => socket.frames.filter((frame) => frame.type === "card.numbered").length).toBe(1);
  socket.close();
  return { id, key, cookie, cardId };
}

type Development = { pullRequests: Array<{ number: number; state: string }>; branches: Array<{ name: string; sha: string }> };
async function developmentOf(board: TestBoard): Promise<Development> {
  const response = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardId}/development`, { headers: { cookie: board.cookie } });
  expect(response.status).toBe(200);
  return response.json<Development>();
}

/** Connects the repo (its own, empty backfill runs and finishes), then runs one more drain for it. */
async function connectThenRepair(): Promise<() => Promise<void>> {
  expect((await deliver("installation", { action: "created", installation: installation(), repositories: [repo(REPO_ID, REPO_NAME)] })).status).toBe(200);
  await expect.poll(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM github_backfill_queue").first<{ n: number }>())!.n).toBe(0);
  return async () => {
    await enqueueBackfill(env, [REPO_ID]);
    await drainBackfill(env);
  };
}

describe("repair backfill of linked work whose text names no key", () => {
  it("repairs a pull request linked by hand that merged while its webhook was lost", async () => {
    const board = await newBoard();
    const repair = await connectThenRepair();
    fake.pull = { number: 5, title: "Rework the importer", state: "open", merged: false };
    const linked = await SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${board.cardId}/development/pull-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: board.cookie },
      body: JSON.stringify({ pullRequest: "5", repositoryId: REPO_ID }),
    });
    expect(linked.status).toBe(200);
    expect((await developmentOf(board)).pullRequests).toEqual([expect.objectContaining({ number: 5, state: "open" })]);

    fake.pull = { number: 5, title: "Rework the importer", state: "closed", merged: true };
    await repair();

    expect((await developmentOf(board)).pullRequests).toEqual([expect.objectContaining({ number: 5, state: "merged" })]);
  });

  it("repairs a branch whose card moved to another board, though its name holds the old board's key", async () => {
    const source = await newBoard();
    const destination = await newBoard(source.cookie);
    const repair = await connectThenRepair();
    const name = `${source.key.toLowerCase()}-1-move-me`;
    fake.branches.set(name, "1".repeat(40));
    expect((await deliver("create", { ref: name, ref_type: "branch", repository: repo(REPO_ID, REPO_NAME) })).status).toBe(200);
    const moved = await SELF.fetch(`${ORIGIN}/boards/${source.id}/cards/${source.cardId}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: source.cookie },
      body: JSON.stringify({ transferId: crypto.randomUUID(), destinationBoardId: destination.id, destinationColumnId: "col" }),
    });
    expect(moved.status).toBe(200);
    const onDestination = await SELF.fetch(`${ORIGIN}/boards/${destination.id}/cards/${source.cardId}/development`, { headers: { cookie: source.cookie } });
    expect((await onDestination.json<Development>()).branches).toEqual([expect.objectContaining({ name, sha: "1".repeat(40) })]);

    fake.branches.set(name, "2".repeat(40));
    await repair();

    const after = await SELF.fetch(`${ORIGIN}/boards/${destination.id}/cards/${source.cardId}/development`, { headers: { cookie: source.cookie } });
    expect((await after.json<Development>()).branches).toEqual([expect.objectContaining({ name, sha: "2".repeat(40) })]);
  });

  it("clears a routed branch deleted on GitHub whose delete webhook was lost, though GitHub no longer lists it", async () => {
    const board = await newBoard();
    const repair = await connectThenRepair();
    const name = `${board.key.toLowerCase()}-1-gone`;
    fake.branches.set(name, "1".repeat(40));
    expect((await deliver("create", { ref: name, ref_type: "branch", repository: repo(REPO_ID, REPO_NAME) })).status).toBe(200);
    expect((await developmentOf(board)).branches).toEqual([expect.objectContaining({ name })]);

    fake.branches.delete(name);
    await repair();

    expect((await developmentOf(board)).branches).toEqual([]);
  });
});
