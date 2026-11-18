import { expect, test } from "@playwright/test";
import { createElement, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Service-free (ADR 0049): `usePresenceSocket` runs under react-dom in Node against a fake WebSocket.

class FakeSocket {
  static count = 0;
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.count += 1;
    FakeSocket.last = this;
  }
  close() {}
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
  const windowBus = new EventTarget();
  g.addEventListener = windowBus.addEventListener.bind(windowBus);
  g.removeEventListener = windowBus.removeEventListener.bind(windowBus);
  g.dispatchEvent = windowBus.dispatchEvent.bind(windowBus);
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
});
test.afterAll(() => {
  for (const key of ["window", "location", "WebSocket", "IS_REACT_ACT_ENVIRONMENT", "addEventListener", "removeEventListener", "dispatchEvent", "document"]) delete g[key];
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const closeLatest = () => act(async () => FakeSocket.last!.onclose?.());
const goOnline = () => act(async () => void g.dispatchEvent(new Event("online")));

test("presence restarts on online only after it gave up, and not after unmount", async () => {
  const { createRoot } = await import("react-dom/client");
  const { usePresenceSocket } = await import("../src/lib/presence");
  const user = { id: "u1", timezone: "UTC" } as Parameters<typeof usePresenceSocket>[0];
  function Probe() {
    usePresenceSocket(user);
    return null;
  }
  const root = createRoot(fakeContainer() as unknown as Element);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  });
  await wait(5);
  expect(FakeSocket.count).toBe(1);

  // A retry is already pending after the first failure: coming online adds nothing.
  await closeLatest();
  await goOnline();
  expect(FakeSocket.count).toBe(1);

  // Retries after 500 ms and 1 s, then the third failure spends the budget.
  await wait(600);
  expect(FakeSocket.count).toBe(2);
  await closeLatest();
  await wait(1100);
  expect(FakeSocket.count).toBe(3);
  await closeLatest();
  await wait(50);
  expect(FakeSocket.count).toBe(3);

  await goOnline();
  expect(FakeSocket.count).toBe(4);

  // The restarted loop has a fresh budget: it retries again after a failure.
  await closeLatest();
  await wait(600);
  expect(FakeSocket.count).toBe(5);

  await act(() => root.unmount());
  await goOnline();
  expect(FakeSocket.count).toBe(5);
});
