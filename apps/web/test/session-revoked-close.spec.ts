import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SESSION_REVOKED_CLOSE } from "@foxban/shared";

// Service-free (ADR 0049): a socket closed with SESSION_REVOKED_CLOSE (ADR 0082) must not reconnect and must
// leave like a sign-out, on the board socket and on the presence socket. The board socket also goes terminal
// (`signedOut`) before it leaves, so a cancelled redirect (the browser's leave prompt over an unsent draft)
// does not leave the board saying "reconnecting…".

class FakeSocket {
  static readonly OPEN = 1;
  static count = 0;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.count += 1;
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}

/** Just enough of a DOM element for react-dom to mount a component that renders nothing. */
function fakeContainer() {
  const noop = () => {};
  const view = { document: { activeElement: null }, HTMLIFrameElement: class {} };
  const doc = { nodeType: 9, addEventListener: noop, removeEventListener: noop, defaultView: view };
  return { nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, addEventListener: noop, removeEventListener: noop };
}

const navigations: string[] = [];
const g = globalThis as Record<string, unknown>;
test.beforeAll(() => {
  g.window = globalThis;
  g.location = { protocol: "http:", host: "localhost", assign: (url: string) => navigations.push(url) };
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
test.beforeEach(() => {
  FakeSocket.count = 0;
  navigations.length = 0;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const closeLatest = (code: number) => act(async () => FakeSocket.last!.onclose?.({ code }));

/** What the board socket hook returned on its latest render. */
const board: { current: { signedOut: boolean; handshakeFailed: boolean; connected: boolean } | null } = { current: null };

async function mountSocket(name: "board" | "presence") {
  const { createRoot } = await import("react-dom/client");
  const { useBoardSocket } = await import("../src/lib/socket");
  const { usePresenceSocket } = await import("../src/lib/presence");
  const user = { id: "u1", timezone: "UTC" } as Parameters<typeof usePresenceSocket>[0];
  // One id for every render: a new one would restart the connect loop, as a state update re-renders the probe.
  const boardId = crypto.randomUUID();
  function Probe() {
    if (name === "board") board.current = useBoardSocket(boardId);
    else usePresenceSocket(user);
    return null;
  }
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  });
  // The socket connects from a zero-delay timer scheduled by the mount effect.
  await wait(5);
  expect(FakeSocket.count).toBe(1);
  return root;
}

for (const name of ["board", "presence"] as const) {
  test(`the ${name} socket does not reconnect after SESSION_REVOKED_CLOSE and leaves to /login`, async () => {
    const root = await mountSocket(name);
    await closeLatest(SESSION_REVOKED_CLOSE);
    // Past the first retry delay (500 ms): an ordinary close would have reconnected by now.
    await wait(700);
    expect(FakeSocket.count).toBe(1);
    expect(navigations).toEqual(["/login"]);
    if (name === "board") expect(board.current).toMatchObject({ signedOut: true, handshakeFailed: false, connected: false });
    await act(() => root.unmount());
  });

  test(`the ${name} socket still reconnects after an ordinary close and does not leave`, async () => {
    const root = await mountSocket(name);
    await closeLatest(1006);
    await wait(700);
    expect(FakeSocket.count).toBe(2);
    expect(navigations).toEqual([]);
    if (name === "board") expect(board.current?.signedOut).toBe(false);
    await act(() => root.unmount());
  });
}
