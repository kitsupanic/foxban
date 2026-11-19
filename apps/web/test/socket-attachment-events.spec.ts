import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientMessage, ServerMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";

// Service-free (ADR 0049): `useBoardSocket` runs under react-dom in Node against a fake
// WebSocket, so the socket-to-attachments wiring is checked without a browser or server.

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

/** Just enough of a DOM element for react-dom to mount a component that renders nothing. */
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
  // The reconnect loop listens for `online` on window and `visibilitychange` on document.
  const windowBus = new EventTarget();
  g.addEventListener = windowBus.addEventListener.bind(windowBus);
  g.removeEventListener = windowBus.removeEventListener.bind(windowBus);
  g.dispatchEvent = windowBus.dispatchEvent.bind(windowBus);
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
});
test.afterAll(() => {
  for (const key of ["window", "location", "WebSocket", "IS_REACT_ACT_ENVIRONMENT", "addEventListener", "removeEventListener", "dispatchEvent", "document"]) delete g[key];
});

const boardId = crypto.randomUUID();
const cardId = crypto.randomUUID();
const attachmentId = crypto.randomUUID();

function snapshot(extra: Record<string, unknown> = {}): ServerMessage {
  return {
    type: "snapshot",
    workflowRolesExplicit: false,
    columns: [{ id: crypto.randomUUID(), title: "Tasks", position: "a0" }],
    cards: [],
    archivedCards: [],
    checklistItems: [],
    attachments: [{ id: attachmentId, cardId, fileName: "shot.png", contentType: "image/png", size: 10 }],
    commentCounts: {},
    relations: [],
    labels: [],
    cardLabels: [],
    ...extra,
  } as ServerMessage;
}

async function mount(snapshotExtra: Record<string, unknown> = {}) {
  // Imported after the globals exist: the modules read `window` and `WebSocket` lazily, but react-dom probes the DOM on load.
  const { createRoot } = await import("react-dom/client");
  const { useBoardSocket } = await import("../src/lib/socket");
  const { createBoardAttachments } = await import("../src/lib/attachments");

  const attachments = createBoardAttachments(boardId);
  const calls: string[] = [];
  const events = attachments.events;
  const spied = {
    ...events,
    message: (msg: ServerMessage, own: boolean) => {
      calls.push(`message ${msg.type} own=${own}`);
      events.message?.(msg, own);
    },
    resolved: (mutationId: string) => {
      calls.push(`resolved ${mutationId}`);
      events.resolved?.(mutationId);
    },
    halted: () => {
      calls.push("halted");
      events.halted?.();
    },
  };
  const socket: { current: ReturnType<typeof useBoardSocket> | null } = { current: null };
  function Probe() {
    socket.current = useBoardSocket(boardId, { events: spied });
    return null;
  }
  const queryClient = new QueryClient();
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  // The socket connects from a zero-delay timer scheduled by the mount effect.
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  const ws = FakeSocket.last!;
  await act(async () => {
    ws.open();
    ws.receive(snapshot(snapshotExtra));
  });
  const deleteAttachment = async () => {
    const mutationId = crypto.randomUUID();
    await act(async () => {
      expect(socket.current!.sendMutation({ type: "attachment.delete", mutationId, id: attachmentId })).toBe(true);
    });
    return mutationId;
  };
  return { attachments, calls, ws, socket, queryClient, deleteAttachment, unmount: () => act(() => root.unmount()) };
}

test("an own delete echo reaches the attachments module as own, resolves it and clears the gate", async () => {
  const { attachments, calls, ws, deleteAttachment, unmount } = await mount();
  const mutationId = await deleteAttachment();
  expect(ws.sent.at(-1)).toEqual({ type: "attachment.delete", mutationId, id: attachmentId });
  expect(attachments.getView().isDeletePending(cardId)).toBe(true);

  await act(async () => ws.receive({ type: "attachment.delete", mutationId, id: attachmentId } as ServerMessage));
  expect(calls).toContain("message attachment.delete own=true");
  expect(calls).toContain(`resolved ${mutationId}`);
  expect(attachments.getView().isDeletePending(cardId)).toBe(false);
  expect(attachments.getView().descriptionFor(cardId, `![x](/boards/${boardId}/attachments/${attachmentId})`)).toBe("");
  await unmount();
});

test("a rejected delete is resolved by the rollback and clears the gate without confirming anything", async () => {
  const { attachments, calls, ws, deleteAttachment, unmount } = await mount();
  const mutationId = await deleteAttachment();
  expect(attachments.getView().isDeletePending(cardId)).toBe(true);

  await act(async () => ws.receive({ type: "error", mutationId, message: "Not allowed." } as ServerMessage));
  expect(calls).toEqual([`resolved ${mutationId}`]);
  expect(attachments.getView().isDeletePending(cardId)).toBe(false);
  const embed = `![x](/boards/${boardId}/attachments/${attachmentId})`;
  expect(attachments.getView().descriptionFor(cardId, embed)).toBe(embed);
  await unmount();
});

test("a denied close halts the attachments module", async () => {
  const { BOARD_ACCESS_DENIED_CLOSE } = await import("../src/lib/access-attempt");
  const { calls, ws, unmount } = await mount();
  await act(async () => ws.onclose?.({ code: BOARD_ACCESS_DENIED_CLOSE }));
  expect(calls).toEqual(["halted"]);
  await unmount();
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("an instant mutation a reconnect leaves uncertain is forgotten once its snapshot verifies it absent", async () => {
  const { calls, ws, deleteAttachment, unmount } = await mount();
  const mutationId = await deleteAttachment();
  await act(async () => ws.onclose?.({ code: 1006 }));
  await wait(600);
  const reconnected = FakeSocket.last!;
  expect(reconnected).not.toBe(ws);
  // The snapshot still holds the attachment: verified-retry, and nobody subscribed to retry it.
  await act(async () => {
    reconnected.open();
    reconnected.receive(snapshot());
  });
  calls.length = 0;
  await act(async () => reconnected.receive({ type: "attachment.delete", mutationId, id: attachmentId } as ServerMessage));
  expect(calls).toContain("message attachment.delete own=false");
  await unmount();
});

for (const [name, fire] of [
  ["online", () => g.dispatchEvent(new Event("online"))],
  ["visibilitychange", () => (g.document as EventTarget).dispatchEvent(new Event("visibilitychange"))],
] as const) {
  test(`a board socket that gave up reconnects on ${name}`, async () => {
    const { ws, unmount } = await mount();
    let current = ws;
    // Three transport failures spend the budget: retries after 500 ms and 1 s, then it stops.
    for (const delay of [600, 1100]) {
      await act(async () => current.onclose?.({ code: 1006 }));
      await wait(delay);
      expect(FakeSocket.last).not.toBe(current);
      current = FakeSocket.last!;
    }
    await act(async () => current.onclose?.({ code: 1006 }));
    await wait(50);
    expect(FakeSocket.last).toBe(current);
    await act(async () => fire());
    await wait(20);
    expect(FakeSocket.last).not.toBe(current);
    await unmount();
  });
}

test("a rebalance frame re-keys the board and leaves an in-flight authored mutation pending (ADR 0076)", async () => {
  const { boardQueryKey } = await import("../src/lib/board-cache");
  const columnId = crypto.randomUUID();
  const longKey = "a0VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
  const card = (id: string, position: string) => ({
    id, columnId, title: id, description: "", position, taskNumber: 1, assigneeId: null, priority: "medium",
    taskType: "task", dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1,
  });
  const { ws, socket, queryClient, unmount } = await mount({
    columns: [{ id: columnId, title: "Tasks", position: "a0" }],
    cards: [card("x1", "a0"), card("x2", longKey), card("x3", "a1")],
  });
  const mutationId = crypto.randomUUID();
  const comment = { type: "comment.create", mutationId, id: crypto.randomUUID(), cardId: "x1", authorId: "me", parentCommentId: null, body: "in flight", createdAt: Date.now() } as const;
  const settled: string[] = [];
  socket.current!.subscribeMutation(mutationId, ({ status }) => settled.push(status));
  await act(async () => {
    expect(socket.current!.sendMutation(comment)).toBe(true);
  });

  const board = () => queryClient.getQueryData<BoardState>(boardQueryKey(boardId))!;
  await act(async () => ws.receive({ type: "positions.rebalanced", table: "cards", positions: [{ id: "x1", position: "a0" }, { id: "x2", position: "a1" }, { id: "x3", position: "a2" }] }));
  // Re-keyed, with the unacknowledged comment still on top, the socket still up, and nothing settled.
  expect(board().cards.map((c) => [c.id, c.position])).toEqual([["x1", "a0"], ["x2", "a1"], ["x3", "a2"]]);
  expect(board().comments.map((c) => c.id)).toEqual([comment.id]);
  expect(ws.readyState).toBe(FakeSocket.OPEN);
  expect(settled).toEqual([]);

  await act(async () => ws.receive(comment));
  expect(settled).toEqual(["accepted"]);
  await unmount();
});
