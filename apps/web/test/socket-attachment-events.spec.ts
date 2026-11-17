import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientMessage, ServerMessage } from "@foxban/shared";

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
});
test.afterAll(() => {
  for (const key of ["window", "location", "WebSocket", "IS_REACT_ACT_ENVIRONMENT"]) delete g[key];
});

const boardId = crypto.randomUUID();
const cardId = crypto.randomUUID();
const attachmentId = crypto.randomUUID();

function snapshot(): ServerMessage {
  return {
    type: "snapshot",
    workflowRolesExplicit: false,
    columns: [{ id: crypto.randomUUID(), title: "Tasks", position: "a0" }],
    cards: [],
    archivedCards: [],
    checklistItems: [],
    attachments: [{ id: attachmentId, cardId, fileName: "shot.png", contentType: "image/png", size: 10 }],
    comments: [],
    activities: [],
    relations: [],
    labels: [],
    cardLabels: [],
  } as ServerMessage;
}

async function mount() {
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
    ws.receive(snapshot());
  });
  const deleteAttachment = async () => {
    const mutationId = crypto.randomUUID();
    await act(async () => {
      expect(socket.current!.sendMutation({ type: "attachment.delete", mutationId, id: attachmentId })).toBe(true);
    });
    return mutationId;
  };
  return { attachments, calls, ws, deleteAttachment, unmount: () => act(() => root.unmount()) };
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
