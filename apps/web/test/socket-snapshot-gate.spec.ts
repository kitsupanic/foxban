import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Card, ClientMessage, ServerMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import type { MutationSettledStatus } from "../src/lib/socket";

// Service-free (ADR 0049): `useBoardSocket` under react-dom in Node with a fake WebSocket. A reconnected
// socket still holds the previous socket's base state, so a write made before its own snapshot lands
// would be settled as "not confirmed" by that snapshot: it is refused instead. Only that first snapshot
// settles; a later one on the same socket (after a card import) leaves what is in flight pending.

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

const g = globalThis as Record<string, unknown>;
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
});
test.afterAll(() => {
  for (const key of ["window", "location", "WebSocket", "IS_REACT_ACT_ENVIRONMENT", "addEventListener", "removeEventListener", "dispatchEvent", "document"]) delete g[key];
});

const snapshot: ServerMessage = {
  type: "snapshot", workflowRolesExplicit: false, columns: [], cards: [], archivedCards: [],
  checklistItems: [], attachments: [], commentCounts: {}, relations: [], labels: [], cardLabels: [],
};
const column: ClientMessage = { type: "column.create", mutationId: "m1", id: "col-a", title: "A", position: "a1" };

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("a mutation is refused between socket open and its snapshot, on first connect and on reconnect", async () => {
  const { createRoot } = await import("react-dom/client");
  const { useBoardSocket } = await import("../src/lib/socket");
  const socket: { current: ReturnType<typeof useBoardSocket> | null } = { current: null };
  const boardId = crypto.randomUUID();
  function Probe() {
    socket.current = useBoardSocket(boardId);
    return null;
  }
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  });
  await wait(5);

  const first = FakeSocket.last!;
  await act(async () => first.open());
  expect(socket.current!.sendMutation(column)).toBe(false);
  await act(async () => first.receive(snapshot));
  expect(socket.current!.sendMutation(column)).toBe(true);
  expect(first.sent).toHaveLength(1);

  // The previous base state survives the drop: only the new socket's own snapshot reopens writes.
  await act(async () => first.onclose?.({ code: 1006 }));
  await wait(600);
  const second = FakeSocket.last!;
  expect(second).not.toBe(first);
  await act(async () => second.open());
  expect(socket.current!.sendMutation({ ...column, mutationId: "m2" })).toBe(false);
  expect(second.sent).toHaveLength(0);
  await act(async () => second.receive(snapshot));
  expect(socket.current!.sendMutation({ ...column, mutationId: "m2" })).toBe(true);
  expect(second.sent).toHaveLength(1);

  await act(async () => root.unmount());
});

const columnId = "col-a";
const card = (id: string): Card => ({
  id, columnId, title: id, description: "", position: "a0", taskNumber: 1, assigneeId: null, priority: "medium",
  taskType: "task", dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1,
});
const boardSnapshot = (cards: Card[] = []): ServerMessage => ({
  type: "snapshot", workflowRolesExplicit: false, columns: [{ id: columnId, title: "A", position: "a0" }], cards, archivedCards: [],
  checklistItems: [], attachments: [], commentCounts: {}, relations: [], labels: [], cardLabels: [],
});
const createCard = (id: string): ClientMessage => ({ type: "card.create", mutationId: crypto.randomUUID(), id, columnId, title: id, position: "a1" });

async function mountBoard() {
  const { createRoot } = await import("react-dom/client");
  const { useBoardSocket } = await import("../src/lib/socket");
  const { boardQueryKey } = await import("../src/lib/board-cache");
  const socket: { current: ReturnType<typeof useBoardSocket> | null } = { current: null };
  const boardId = crypto.randomUUID();
  function Probe() {
    socket.current = useBoardSocket(boardId);
    return null;
  }
  const queryClient = new QueryClient();
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  await wait(5);
  const ws = FakeSocket.last!;
  await act(async () => {
    ws.open();
    ws.receive(boardSnapshot());
  });
  /** Sends a subscribed write, as a creation dialog does, and records every outcome it is told. */
  const send = async (msg: ClientMessage) => {
    const outcomes: MutationSettledStatus[] = [];
    await act(async () => {
      socket.current!.subscribeMutation(msg.mutationId, ({ status }) => outcomes.push(status));
      expect(socket.current!.sendMutation(msg)).toBe(true);
    });
    return outcomes;
  };
  const cardIds = () => queryClient.getQueryData<BoardState>(boardQueryKey(boardId))!.cards.map((c) => c.id).sort();
  return { ws, send, cardIds, unmount: () => act(() => root.unmount()) };
}

test("a later snapshot on the same socket leaves an in-flight create pending, and its late echo accepts it", async () => {
  const { ws, send, cardIds, unmount } = await mountBoard();
  const create = createCard("mine");
  const outcomes = await send(create);

  // A peer moved a card in from another board: the board sends every open socket a fresh snapshot.
  await act(async () => ws.receive(boardSnapshot([card("imported")])));
  expect(outcomes).toEqual([]);
  expect(cardIds()).toEqual(["imported", "mine"]);
  expect(ws.readyState).toBe(FakeSocket.OPEN);

  await act(async () => ws.receive(create as ServerMessage));
  expect(outcomes).toEqual(["accepted"]);
  expect(cardIds()).toEqual(["imported", "mine"]);
  await unmount();
});

test("a write kept across a later snapshot still times out on its own timer", async () => {
  const { ws, send, cardIds, unmount } = await mountBoard();
  const outcomes = await send(createCard("late"));
  await act(async () => ws.receive(boardSnapshot([card("imported")])));
  await wait(5_100);
  expect(outcomes).toEqual(["timeout"]);
  expect(cardIds()).toEqual(["imported"]);
  await unmount();
});

test("the first snapshot after a reconnect still settles each tracked write, once", async () => {
  const { ws, send, unmount } = await mountBoard();
  const kept = await send(createCard("kept"));
  const lost = await send(createCard("lost"));
  await act(async () => ws.onclose?.({ code: 1006 }));
  await wait(600);
  const reconnected = FakeSocket.last!;
  expect(reconnected).not.toBe(ws);
  await act(async () => {
    reconnected.open();
    reconnected.receive(boardSnapshot([card("kept")]));
  });
  expect(kept).toEqual(["uncertain", "accepted"]);
  expect(lost).toEqual(["uncertain", "verified-retry"]);
  await unmount();
});
