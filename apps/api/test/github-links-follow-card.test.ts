import { SELF, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, OWNER, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * A pull request linked to a card stays on that card (ADR 0064): through a board-key
 * edit, archive and restore, a move to another board and, until it is purged, the
 * card's whole life. Everything goes through the real Worker: signed webhooks in,
 * card reads and board sockets out. The one thing read from D1 is the routing table
 * (`github_pr_routes`), because no public route shows it. The helpers are copies of
 * the ones in github-development.test.ts; boards get fresh keys per test because
 * storage outlives a test.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 202;
const REPO_NAME = `${OWNER}/web`;

/** Each test gets pull request numbers nobody else used, since routing rows outlive a test. */
let lastNumber = 0;
const nextNumber = () => ++lastNumber;

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

/** A new board with `cardCount` cards numbered 1..cardCount, owned by `cookie`'s user or a fresh admin. */
async function newBoard(cardCount = 1, cookie?: string): Promise<TestBoard> {
  cookie ??= await adminSession();
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

const developmentOf = (board: TestBoard, cardId: string) =>
  SELF.fetch(`${ORIGIN}/boards/${board.id}/cards/${cardId}/development`, { headers: { cookie: board.cookie } });

/** What the card's Development section reads. */
async function pullRequestsOn(board: TestBoard, cardId = board.cardIds[0]!) {
  const response = await developmentOf(board, cardId);
  expect(response.status).toBe(200);
  return (await response.json<{ pullRequests: Array<{ number: number; title: string; state: string }> }>()).pullRequests;
}

/** Sends one mutation on a short-lived socket and waits for the board to echo it back. */
async function mutate(board: TestBoard, message: { type: string; [field: string]: unknown }) {
  const socket = await openSocket(board.id, board.cookie);
  socket.send({ mutationId: crypto.randomUUID(), ...message });
  await expect.poll(() => socket.frames.some((frame) => frame.type === message.type || (message.type === "card.purge" && frame.type === "archive.purged"))).toBe(true);
  socket.close();
}

const archive = (board: TestBoard, cardId = board.cardIds[0]!) => mutate(board, { type: "card.delete", id: cardId });
const restore = (board: TestBoard, cardId = board.cardIds[0]!) => mutate(board, { type: "card.restore", id: cardId, columnId: "col", position: "a1" });
async function purge(board: TestBoard, cardId = board.cardIds[0]!) {
  await archive(board, cardId);
  await mutate(board, { type: "card.purge", id: cardId });
}

const transfer = (source: TestBoard, destination: TestBoard, cardId = source.cardIds[0]!) =>
  SELF.fetch(`${ORIGIN}/boards/${source.id}/cards/${cardId}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: source.cookie },
    body: JSON.stringify({ transferId: crypto.randomUUID(), destinationBoardId: destination.id, destinationColumnId: "col" }),
  });

/** Whether the D1 routing table points the pull request at the board. */
async function routed(board: TestBoard, number: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM github_pr_routes WHERE repo_id = ? AND pr_number = ? AND board_id = ?")
    .bind(REPO_ID, number, board.id)
    .first();
  return row !== null;
}

async function connect() {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(REPO_ID, REPO_NAME)] });
  expect(response.status).toBe(200);
}

const BASE_TIME = Date.UTC(2026, 10, 12, 10, 0, 0);
const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000).toISOString();

type PullRequestOptions = { action?: string; number: number; title?: string; state?: "open" | "closed"; merged?: boolean; updatedAt?: string };

/** A `pull_request` event as GitHub sends it, down to the fields this feature reads. */
function pullRequestEvent({ number, ...options }: PullRequestOptions) {
  return {
    action: options.action ?? "opened",
    number,
    repository: repo(REPO_ID, REPO_NAME),
    pull_request: {
      number,
      title: options.title ?? "Untitled work",
      body: null,
      state: options.state ?? "open",
      draft: false,
      merged: options.merged ?? false,
      html_url: `https://github.example/${REPO_NAME}/pull/${number}`,
      updated_at: options.updatedAt ?? at(0),
      head: { ref: "main-work" },
    },
  };
}

/** The pull request merging, with a title that no longer names any key. */
const merged = (number: number, seconds: number) =>
  pullRequestEvent({ number, action: "closed", state: "closed", merged: true, title: "login shipped", updatedAt: at(seconds) });

describe("a linked pull request after its board's key is edited", () => {
  it("still updates the card, even though its title names the old key", async () => {
    const board = await newBoard();
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${board.key}-1 login`, updatedAt: at(0) }));

    const newKey = `N${board.key.slice(1)}`;
    const edited = await SELF.fetch(`${ORIGIN}/boards/${board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: board.cookie },
      body: JSON.stringify({ name: `Board ${newKey}`, key: newKey }),
    });
    expect(edited.status).toBe(200);

    await deliver("pull_request", pullRequestEvent({ number, action: "closed", state: "closed", merged: true, title: `${board.key}-1 login`, updatedAt: at(10) }));

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number, state: "merged" })]);
  });
});

describe("a linked pull request when its card is archived and restored", () => {
  it("is kept while archived, keeps updating, and shows again on restore", async () => {
    const board = await newBoard();
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${board.key}-1 login`, updatedAt: at(0) }));

    await archive(board);
    await deliver("pull_request", merged(number, 10));
    await restore(board);

    expect(await pullRequestsOn(board)).toEqual([expect.objectContaining({ number, state: "merged", title: "login shipped" })]);
  });
});

describe("a linked pull request when its card moves to another board", () => {
  it("goes with the card, and later events still reach it there", async () => {
    const source = await newBoard();
    const destination = await newBoard(1, source.cookie);
    await connect();
    const number = nextNumber();
    const cardId = source.cardIds[0]!;
    await deliver("pull_request", pullRequestEvent({ number, title: `${source.key}-1 login`, updatedAt: at(0) }));

    const moved = await transfer(source, destination);
    expect(moved.status).toBe(200);

    expect((await developmentOf(source, cardId)).status).toBe(404);
    expect(await pullRequestsOn(destination, cardId)).toEqual([
      { repositoryId: REPO_ID, repository: REPO_NAME, number, title: `${source.key}-1 login`, state: "open", url: `https://github.example/${REPO_NAME}/pull/${number}`, updatedAt: BASE_TIME },
    ]);

    await deliver("pull_request", merged(number, 20));
    expect(await pullRequestsOn(destination, cardId)).toEqual([expect.objectContaining({ number, state: "merged" })]);
  });

  it("moves its routing row to the destination board", async () => {
    const source = await newBoard();
    const destination = await newBoard(1, source.cookie);
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${source.key}-1`, updatedAt: at(0) }));
    expect(await routed(source, number)).toBe(true);

    expect((await transfer(source, destination)).status).toBe(200);

    expect(await routed(destination, number)).toBe(true);
    await expect.poll(() => routed(source, number)).toBe(false);
  });

  it("leaves the source board linked while another of its cards still holds the pull request", async () => {
    const source = await newBoard(2);
    const destination = await newBoard(1, source.cookie);
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${source.key}-1 and ${source.key}-2`, updatedAt: at(0) }));

    expect((await transfer(source, destination)).status).toBe(200);
    await deliver("pull_request", merged(number, 30));

    expect(await pullRequestsOn(source, source.cardIds[1]!)).toEqual([expect.objectContaining({ number, state: "merged" })]);
    expect(await pullRequestsOn(destination, source.cardIds[0]!)).toEqual([expect.objectContaining({ number, state: "merged" })]);
    expect(await routed(source, number)).toBe(true);
    expect(await routed(destination, number)).toBe(true);
  });
});

describe("a linked pull request when its card is purged", () => {
  it("drops the board's routing row, so the board is not asked about it again", async () => {
    const board = await newBoard();
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${board.key}-1`, updatedAt: at(0) }));
    expect(await routed(board, number)).toBe(true);

    await purge(board);

    expect((await developmentOf(board, board.cardIds[0]!)).status).toBe(404);
    await expect.poll(() => routed(board, number)).toBe(false);
  });

  it("keeps the routing row while another card on the board still holds the pull request", async () => {
    const board = await newBoard(2);
    await connect();
    const number = nextNumber();
    await deliver("pull_request", pullRequestEvent({ number, title: `${board.key}-1 and ${board.key}-2`, updatedAt: at(0) }));

    await purge(board, board.cardIds[0]!);
    await deliver("pull_request", merged(number, 40));

    expect(await pullRequestsOn(board, board.cardIds[1]!)).toEqual([expect.objectContaining({ number, state: "merged" })]);
    expect(await routed(board, number)).toBe(true);

    await purge(board, board.cardIds[1]!);
    await expect.poll(() => routed(board, number)).toBe(false);
  });
});
