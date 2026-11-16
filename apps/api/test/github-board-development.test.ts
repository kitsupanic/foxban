import { SELF } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, OWNER, PASSWORD, adminSession, deliver, installApp, installation, repo, useFakeGitHub } from "./github-test-kit";

/**
 * What a board's card fronts read (ADR 0064): the pull requests linked to its cards,
 * in one request, so the board needs no per-card reads and no polling. Signed webhooks
 * in, one board read out, all through the real Worker. Boards get fresh keys per test
 * because storage outlives a test.
 */
useFakeGitHub();
beforeEach(installApp);

const REPO_ID = 101;
const REPO_NAME = `${OWNER}/api`;
const BASE_TIME = Date.UTC(2026, 10, 12, 10, 0, 0);

type TestBoard = { id: string; key: string; cookie: string; cardIds: string[] };

async function newBoard(cardCount: number): Promise<TestBoard> {
  const cookie = await adminSession();
  const key = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
  const created = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: `Board ${key}`, key, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(created.status).toBe(200);
  const { id } = await created.json<{ id: string }>();

  const response = await SELF.fetch(`${ORIGIN}/boards/${id}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, { headers: { Upgrade: "websocket", cookie } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as ServerMessage);
  });
  socket.accept();
  socket.send(JSON.stringify({ type: "column.create", mutationId: crypto.randomUUID(), id: "col", title: "To do", position: "a0" }));
  const cardIds = Array.from({ length: cardCount }, () => crypto.randomUUID());
  cardIds.forEach((cardId, index) => {
    socket.send(JSON.stringify({ type: "card.create", mutationId: crypto.randomUUID(), id: cardId, columnId: "col", title: `Card ${index + 1}`, position: `a${index}` }));
  });
  await expect.poll(() => frames.filter((frame) => frame.type === "card.numbered").length).toBe(cardCount);
  socket.close();
  return { id, key, cookie, cardIds };
}

async function connect() {
  const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(REPO_ID, REPO_NAME)] });
  expect(response.status).toBe(200);
}

function pullRequestEvent(number: number, title: string, options: { state?: "open" | "closed"; merged?: boolean; draft?: boolean; seconds?: number } = {}) {
  return {
    action: "opened",
    number,
    repository: repo(REPO_ID, REPO_NAME),
    pull_request: {
      number,
      title,
      body: null,
      state: options.state ?? "open",
      draft: options.draft ?? false,
      merged: options.merged ?? false,
      html_url: `https://github.example/${REPO_NAME}/pull/${number}`,
      updated_at: new Date(BASE_TIME + (options.seconds ?? 0) * 1000).toISOString(),
      head: { ref: "work" },
    },
  };
}

const readBoard = (board: TestBoard, cookie = board.cookie) => SELF.fetch(`${ORIGIN}/boards/${board.id}/development`, { headers: { cookie } });

describe("a board's development info", () => {
  it("lists the pull requests of each card that has any, and no other card", async () => {
    const board = await newBoard(3);
    await connect();
    await deliver("pull_request", pullRequestEvent(5, `${board.key}-1 login`));
    await deliver("pull_request", pullRequestEvent(6, `${board.key}-1 and ${board.key}-3`, { draft: true }));

    const response = await readBoard(board);
    expect(response.status).toBe(200);
    const { cards } = await response.json<{ cards: Array<{ cardId: string; pullRequests: Array<{ number: number; state: string; repository: string }> }> }>();
    const byCard = new Map(cards.map((card) => [card.cardId, card.pullRequests.map((pr) => [pr.number, pr.state, pr.repository])]));
    expect(byCard.get(board.cardIds[0]!)).toEqual([
      [5, "open", REPO_NAME],
      [6, "draft", REPO_NAME],
    ]);
    expect(byCard.get(board.cardIds[2]!)).toEqual([[6, "draft", REPO_NAME]]);
    expect(byCard.has(board.cardIds[1]!)).toBe(false);
  });

  it("follows a pull request to its new state", async () => {
    const board = await newBoard(1);
    await connect();
    await deliver("pull_request", pullRequestEvent(5, `${board.key}-1`));
    await deliver("pull_request", pullRequestEvent(5, `${board.key}-1`, { state: "closed", merged: true, seconds: 30 }));

    const { cards } = await (await readBoard(board)).json<{ cards: Array<{ pullRequests: Array<{ state: string }> }> }>();
    expect(cards.map((card) => card.pullRequests.map((pr) => pr.state))).toEqual([["merged"]]);
  });

  it("is limited to members of the board", async () => {
    const board = await newBoard(1);
    const invite = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { cookie: board.cookie } });
    const stranger = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `stranger-${board.key}@example.com`, name: "Stranger", password: PASSWORD, invite: (await invite.json<{ token: string }>()).token }),
    });
    expect(stranger.status).toBe(200);

    expect((await SELF.fetch(`${ORIGIN}/boards/${board.id}/development`)).status).toBe(401);
    expect((await readBoard(board, stranger.headers.get("set-cookie")!.split(";")[0]!)).status).toBe(403);
    expect((await readBoard(board)).status).toBe(200);
  });
});
