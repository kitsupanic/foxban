import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientMessage, Comment, ServerMessage } from "@foxban/shared";
import type { MutationSettledStatus } from "../src/lib/socket";

// Service-free (ADR 0049), like socket-attachment-events: `useBoardSocket` under react-dom in Node,
// a fake WebSocket and a stubbed `fetch`. The snapshot carries no comments (ADR 0078), so an
// uncertain comment write is settled (ADR 0069) by a fresh read of its card.

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function fakeContainer() {
  const noop = () => {};
  const view = { document: { activeElement: null }, HTMLIFrameElement: class {} };
  const doc = { nodeType: 9, addEventListener: noop, removeEventListener: noop, defaultView: view };
  return { nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, addEventListener: noop, removeEventListener: noop };
}

/** What the stubbed comments route answers next; each read is logged by card id. */
/** `failures`: how many reads answer 503 before the rest succeed. `gate`: held reads wait on it. */
const server = { comments: [] as Comment[], reads: [] as string[], failures: 0, gate: null as Promise<void> | null, onRead: null as (() => void) | null };

const g = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;
test.beforeAll(() => {
  g.window = globalThis;
  g.location = { protocol: "http:", host: "localhost" };
  g.WebSocket = FakeSocket;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const windowBus = new EventTarget();
  g.addEventListener = windowBus.addEventListener.bind(windowBus);
  g.removeEventListener = windowBus.removeEventListener.bind(windowBus);
  g.dispatchEvent = windowBus.dispatchEvent.bind(windowBus);
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  g.fetch = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /\/cards\/([^/]+)\/comments$/.exec(url);
    if (!match) throw new Error(`unexpected fetch ${url}`);
    server.reads.push(match[1]);
    const comments = server.comments;
    server.onRead?.();
    if (server.gate) await server.gate;
    if (server.failures > 0) {
      server.failures -= 1;
      return new Response("{}", { status: 503 });
    }
    return Response.json({ comments });
  };
});
test.afterAll(() => {
  for (const key of ["window", "location", "WebSocket", "IS_REACT_ACT_ENVIRONMENT", "addEventListener", "removeEventListener", "dispatchEvent", "document"]) delete g[key];
  g.fetch = realFetch;
});
test.beforeEach(() => {
  Object.assign(server, { comments: [], reads: [], failures: 0, gate: null, onRead: null });
});

const boardId = crypto.randomUUID();
const cardId = crypto.randomUUID();
const commentId = crypto.randomUUID();
const stored: Comment = { id: commentId, cardId, authorId: "u1", parentCommentId: null, deleted: false, body: "Hello", createdAt: 1, updatedAt: 1 };

const snapshot = (commentCounts: Record<string, number> = {}): ServerMessage => ({
  type: "snapshot", workflowRolesExplicit: false, columns: [], cards: [], archivedCards: [],
  checklistItems: [], attachments: [], commentCounts, relations: [], labels: [], cardLabels: [],
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function mount() {
  const { createRoot } = await import("react-dom/client");
  const { useBoardSocket } = await import("../src/lib/socket");
  const { boardQueryKey } = await import("../src/lib/board-cache");
  const socket: { current: ReturnType<typeof useBoardSocket> | null } = { current: null };
  function Probe() {
    socket.current = useBoardSocket(boardId);
    return null;
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  await wait(5);
  const ws = FakeSocket.last!;
  await act(async () => {
    ws.open();
    ws.receive(snapshot());
  });
  /** Sends a subscribed comment write, as the comment thread's authored operation does. */
  const sendSubscribed = async (msg: ClientMessage) => {
    const outcomes: MutationSettledStatus[] = [];
    await act(async () => {
      socket.current!.subscribeMutation(msg.mutationId, ({ status }) => outcomes.push(status));
      expect(socket.current!.sendMutation(msg)).toBe(true);
    });
    return outcomes;
  };
  /** The transport drops before the echo (a timed-out write closes it on purpose), then reconnects. */
  const resync = async (commentCounts?: Record<string, number>) => {
    await act(async () => FakeSocket.last!.onclose?.({ code: 1006 }));
    await wait(600);
    const reconnected = FakeSocket.last!;
    await act(async () => {
      reconnected.open();
      reconnected.receive(snapshot(commentCounts));
    });
    await wait(20);
    return reconnected;
  };
  const board = () => queryClient.getQueryData<{ comments: Comment[]; commentCounts: Record<string, number> }>(boardQueryKey(boardId));
  return { socket, board, queryClient, sendSubscribed, resync, unmount: () => act(() => root.unmount()) };
}

const create = (): ClientMessage => ({
  type: "comment.create", mutationId: crypto.randomUUID(), id: commentId, cardId, authorId: "u1", parentCommentId: null, body: "Hello", createdAt: 1,
});

test("an uncertain comment the server did store is verified accepted by reading its card", async () => {
  const { board, sendSubscribed, resync, unmount } = await mount();
  const outcomes = await sendSubscribed(create());
  server.comments = [stored];
  await resync({ [cardId]: 1 });
  expect(server.reads).toEqual([cardId]);
  expect(outcomes).toEqual(["uncertain", "accepted"]);
  // The read installed the card's comments, so the thread shows the comment the user wrote.
  expect(board()!.comments).toEqual([stored]);
  expect(board()!.commentCounts).toEqual({ [cardId]: 1 });
  await unmount();
});

test("an uncertain comment the server never stored is left for a retry", async () => {
  const { sendSubscribed, resync, unmount } = await mount();
  const outcomes = await sendSubscribed(create());
  await resync();
  expect(outcomes).toEqual(["uncertain", "verified-retry"]);
  await unmount();
});

test("an uncertain edit is verified against the body the read returns", async () => {
  const { sendSubscribed, resync, unmount } = await mount();
  const edit: ClientMessage = { type: "comment.update", mutationId: crypto.randomUUID(), id: commentId, cardId, body: "Edited", updatedAt: 2 };
  const outcomes = await sendSubscribed(edit);
  server.comments = [{ ...stored, body: "Edited", updatedAt: 2 }];
  await resync({ [cardId]: 1 });
  expect(outcomes).toEqual(["uncertain", "accepted"]);
  await unmount();
});

test("a read that fails once is retried, so a stored comment still settles accepted", async () => {
  const { sendSubscribed, resync, unmount } = await mount();
  const outcomes = await sendSubscribed(create());
  server.failures = 1;
  server.comments = [stored];
  await resync({ [cardId]: 1 });
  await expect.poll(() => outcomes, { timeout: 5_000 }).toEqual(["uncertain", "accepted"]);
  expect(server.reads).toEqual([cardId, cardId]);
  await unmount();
});

test("a card that keeps failing to read leaves the write unverified rather than guessing", async () => {
  const { sendSubscribed, resync, unmount } = await mount();
  const outcomes = await sendSubscribed(create());
  server.failures = Infinity;
  server.comments = [stored];
  await resync({ [cardId]: 1 });
  await expect.poll(() => outcomes, { timeout: 8_000 }).toEqual(["uncertain", "verified-retry"]);
  expect(server.reads).toHaveLength(3);
  await unmount();
});

test("a cancelled verification read leaves the write uncertain for the next snapshot to settle", async () => {
  const { queryClient, sendSubscribed, resync, unmount } = await mount();
  const outcomes = await sendSubscribed(create());
  let release!: () => void;
  server.gate = new Promise((resolve) => (release = resolve));
  server.comments = [stored];
  await resync({ [cardId]: 1 });
  expect(server.reads).toEqual([cardId]);
  await act(() => queryClient.cancelQueries({ queryKey: ["card-comments", boardId] }));
  server.gate = null;
  release();
  await wait(20);
  expect(outcomes).toEqual(["uncertain"]);
  // The next snapshot reads the card again and settles it.
  await resync({ [cardId]: 1 });
  expect(outcomes).toEqual(["uncertain", "accepted"]);
  await unmount();
});

test("a comment frame for the card landing mid-read makes the read run again", async () => {
  const { socket, board, queryClient, unmount } = await mount();
  const peer: Comment = { ...stored, id: crypto.randomUUID(), body: "Peer" };
  server.comments = [stored];
  // The first read's answer predates the peer's comment, whose frame arrives before that answer does.
  server.onRead = () => {
    server.onRead = null;
    FakeSocket.last!.receive({ type: "comment.create", mutationId: crypto.randomUUID(), id: peer.id, cardId, authorId: "u1", parentCommentId: null, body: "Peer", createdAt: 1 });
    server.comments = [stored, peer];
  };
  await act(async () => {
    await queryClient.fetchQuery(socket.current!.cardCommentsQuery(cardId));
  });
  expect(server.reads).toEqual([cardId, cardId]);
  expect(board()!.comments.map((c) => c.id).sort()).toEqual([stored.id, peer.id].sort());
  expect(board()!.commentCounts).toEqual({ [cardId]: 1 });
  await unmount();
});
