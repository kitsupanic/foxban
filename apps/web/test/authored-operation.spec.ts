import { expect, test } from "@playwright/test";
import type { ClientMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import {
  createAuthoredScope,
  type AuthoredOperationOptions,
  type AuthoredTransport,
} from "../src/lib/authored-operation";
import type { MutationSettledStatus } from "../src/lib/socket";

type Sent = { itemId: string; text: string };

const COPY = {
  rejected: "Server rejected it.",
  unverified: "Could not verify it.",
  "not-connected": "Not connected.",
  "accepted-gone": "It was deleted.",
};

// Callbacks stay reachable after unsubscribe so the tests can prove the core ignores them itself.
function fakeTransport() {
  const sends: ClientMessage[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const retired: string[] = [];
  const callbacks = new Map<string, Parameters<AuthoredTransport["subscribe"]>[1]>();
  const state = { connected: true, board: undefined as BoardState | undefined };
  return {
    state,
    sends,
    unsubscribed,
    retired,
    ids: subscribed,
    fire(mutationId: string, status: MutationSettledStatus, error?: string) {
      callbacks.get(mutationId)?.({ mutationId, status, error });
    },
    transport: {
      send(message) {
        if (!state.connected) return false;
        sends.push(message);
        return true;
      },
      subscribe(mutationId, callback) {
        subscribed.push(mutationId);
        callbacks.set(mutationId, callback);
        return () => void unsubscribed.push(mutationId);
      },
      retire: (mutationId) => void retired.push(mutationId),
      readBoard: () => state.board,
    } satisfies AuthoredTransport,
  };
}

function setup(overrides: Partial<AuthoredOperationOptions<Sent>> = {}) {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const accepted: Sent[] = [];
  const op = scope.operation<Sent>({
    build: (mutationId, sent) => ({ type: "checklist.update", mutationId, id: sent.itemId, text: sent.text }),
    onAccepted: (sent) => void accepted.push(sent),
    copy: COPY,
    ...overrides,
  });
  return { fake, scope, op, accepted };
}

const sent: Sent = { itemId: "item-1", text: "Buy milk" };

// Every terminal outcome must drop the socket's entry for exactly the attempt that was live.
function expectRetiredOnce(fake: ReturnType<typeof fakeTransport>, id: string) {
  expect(fake.retired).toEqual([id]);
  expect(fake.unsubscribed).toEqual([id]);
}

test("start subscribes before sending, goes pending, then accepted settles and reports the snapshot", () => {
  const { fake, op, accepted } = setup();
  expect(op.getState().status).toBe("idle");
  expect(op.start(sent)).toBe(true);
  const [id] = fake.ids;
  expect(fake.sends).toEqual([{ type: "checklist.update", mutationId: id, id: "item-1", text: "Buy milk" }]);
  expect(op.getState()).toEqual({ status: "pending", sent, failure: null, error: null });
  expect(fake.retired).toEqual([]);

  fake.fire(id, "accepted");
  expect(op.getState()).toEqual({ status: "settled", sent, failure: null, error: null });
  expect(accepted).toEqual([sent]);
  expectRetiredOnce(fake, id);
});

test("subscribers are notified with a new state object on each change", () => {
  const { fake, op } = setup();
  const seen: unknown[] = [];
  const unsubscribe = op.subscribe(() => seen.push(op.getState()));
  op.start(sent);
  fake.fire(fake.ids[0], "uncertain");
  fake.fire(fake.ids[0], "timeout");
  fake.fire(fake.ids[0], "accepted");
  expect(seen.map((state) => (state as { status: string }).status)).toEqual(["pending", "uncertain", "settled"]);
  expect(new Set(seen).size).toBe(3);
  unsubscribe();
  op.discard();
  expect(seen).toHaveLength(3);
});

test("timeout or uncertain keeps the attempt live, and a later accepted still settles it", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "timeout");
  expect(op.getState().status).toBe("uncertain");
  expect(op.getState().sent).toBe(sent);
  expect(fake.retired).toEqual([]);
  expect(fake.unsubscribed).toEqual([]);
  fake.fire(id, "uncertain");
  expect(op.getState().status).toBe("uncertain");

  fake.fire(id, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(accepted).toEqual([sent]);
  expectRetiredOnce(fake, id);
});

test("timeout then verified-retry fails as unverified but stays live", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "timeout");
  fake.fire(id, "verified-retry");
  expect(op.getState()).toEqual({ status: "failed", sent, failure: "unverified", error: COPY.unverified });
  expect(accepted).toEqual([]);
  expect(fake.retired).toEqual([]);
  expect(fake.unsubscribed).toEqual([]);
});

test("a late accepted after unverified settles, reports and retires", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "timeout");
  fake.fire(id, "verified-retry");
  fake.fire(id, "accepted");
  expect(op.getState()).toEqual({ status: "settled", sent, failure: null, error: null });
  expect(accepted).toEqual([sent]);
  expectRetiredOnce(fake, id);
});

test("a stray timeout does not pull an unverified attempt back to uncertain", () => {
  const { fake, op } = setup();
  op.start(sent);
  fake.fire(fake.ids[0], "verified-retry");
  fake.fire(fake.ids[0], "timeout");
  expect(op.getState().status).toBe("failed");
});

test("retry keeps the earlier attempt live; a late accept of the earlier id settles and retires both", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  expect(op.retry()).toBe(true);
  const [, second] = fake.ids;
  expect(fake.retired).toEqual([]);

  fake.fire(first, "accepted");
  expect(op.getState()).toEqual({ status: "settled", sent, failure: null, error: null });
  expect(accepted).toEqual([sent]);
  expect(fake.retired).toEqual([first, second]);
  expect(fake.unsubscribed).toEqual([first, second]);

  fake.fire(second, "accepted");
  expect(accepted).toEqual([sent]);
});

test("onAccepted receives the mutationId of the accepted attempt, including a late earlier one", () => {
  const ids: string[] = [];
  const { fake, op } = setup({ onAccepted: (_sent, mutationId) => void ids.push(mutationId) });
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  fake.fire(first, "accepted");
  expect(ids).toEqual([first]);
  expect(fake.ids[1]).not.toBe(first);
});

test("accepted of the latest attempt also retires an older unverified one", () => {
  const { fake, op } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  const [, second] = fake.ids;
  fake.fire(second, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(fake.retired).toEqual([first, second]);
});

test("a non-latest rejection retires just that attempt and never changes state", () => {
  const { fake, op } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  const [, second] = fake.ids;

  fake.fire(first, "rejected", "old news");
  expect(op.getState()).toEqual({ status: "pending", sent, failure: null, error: null });
  expect(fake.retired).toEqual([first]);
  fake.fire(first, "timeout");
  expect(op.getState().status).toBe("pending");
  fake.fire(second, "timeout");
  expect(op.getState().status).toBe("uncertain");
});

test("a rejected latest attempt retires only itself, so an older unverified one can still settle", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  const [, second] = fake.ids;
  fake.fire(second, "rejected", "no");
  expect(op.getState()).toMatchObject({ status: "failed", failure: "rejected", error: "no" });
  expect(fake.retired).toEqual([second]);

  fake.fire(first, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(accepted).toEqual([sent]);
  expect(fake.retired).toEqual([second, first]);
});

test("a retry that cannot send retires only the new attempt", () => {
  const { fake, op } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  fake.state.connected = false;
  op.retry();
  const [, second] = fake.ids;
  expect(op.getState()).toMatchObject({ status: "failed", failure: "not-connected" });
  expect(fake.retired).toEqual([second]);
  fake.state.connected = true;
  fake.fire(first, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(fake.retired).toEqual([second, first]);
});

test("build returning null on retry settles and retires the whole lineage", () => {
  let nothing = false;
  const { fake, op, accepted } = setup({
    build: (mutationId, s) => (nothing ? null : { type: "checklist.update", mutationId, id: s.itemId, text: s.text }),
  });
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  nothing = true;
  op.retry();
  expect(op.getState().status).toBe("settled");
  expect(fake.retired).toEqual([first]);
  expect(accepted).toEqual([]);
});

test("starting a new lineage retires every id of the previous one", () => {
  const { fake, op } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  const [, second] = fake.ids;
  fake.fire(second, "verified-retry");
  expect(op.start({ itemId: "item-2", text: "other" })).toBe(true);
  expect(fake.retired).toEqual([first, second]);
  expect(fake.unsubscribed).toEqual([first, second]);
});

test("discard retires every id of an unverified lineage", () => {
  const { fake, op } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "verified-retry");
  op.retry();
  const [, second] = fake.ids;
  op.discard();
  expect(fake.retired).toEqual([first, second]);
});

test("rejected prefers the server text and falls back to the copy", () => {
  const withText = setup();
  withText.op.start(sent);
  withText.fake.fire(withText.fake.ids[0], "rejected", "Title is too long");
  expect(withText.op.getState()).toEqual({ status: "failed", sent, failure: "rejected", error: "Title is too long" });
  expectRetiredOnce(withText.fake, withText.fake.ids[0]);

  const withoutText = setup();
  withoutText.op.start(sent);
  withoutText.fake.fire(withoutText.fake.ids[0], "rejected");
  expect(withoutText.op.getState()).toMatchObject({ failure: "rejected", error: COPY.rejected });
  expect(withoutText.accepted).toEqual([]);
});

test("a send that returns false fails as not-connected and still retires", () => {
  const { fake, op } = setup();
  fake.state.connected = false;
  expect(op.start(sent)).toBe(true);
  const [id] = fake.ids;
  expect(op.getState()).toEqual({ status: "failed", sent, failure: "not-connected", error: COPY["not-connected"] });
  expectRetiredOnce(fake, id);
});

test("confirm false turns an accepted attempt into accepted-gone", () => {
  const board = { checklistItems: [] } as unknown as BoardState;
  const seen: Array<[BoardState | undefined, Sent]> = [];
  const { fake, op, accepted } = setup({
    confirm: (live, snapshot) => {
      seen.push([live, snapshot]);
      return false;
    },
  });
  fake.state.board = board;
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "accepted");
  expect(seen).toEqual([[board, sent]]);
  expect(op.getState()).toEqual({ status: "failed", sent, failure: "accepted-gone", error: COPY["accepted-gone"] });
  expect(accepted).toEqual([]);
  expectRetiredOnce(fake, id);
});

test("confirm true settles normally", () => {
  const { fake, op, accepted } = setup({ confirm: () => true });
  op.start(sent);
  fake.fire(fake.ids[0], "accepted");
  expect(op.getState().status).toBe("settled");
  expect(accepted).toEqual([sent]);
});

test("onAccepted runs after the state is already settled", () => {
  let during: string | undefined;
  let status = () => "";
  const { fake, op } = setup({ onAccepted: () => void (during = status()) });
  status = () => op.getState().status;
  op.start(sent);
  fake.fire(fake.ids[0], "accepted");
  expect(during).toBe("settled");
});

test("retry mints a new mutationId, rebuilds from the same sent and retires the failed one once", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "rejected", "nope");
  expect(op.retry()).toBe(true);
  const [, second] = fake.ids;
  expect(second).not.toBe(first);
  expect(fake.sends).toEqual([
    { type: "checklist.update", mutationId: first, id: "item-1", text: "Buy milk" },
    { type: "checklist.update", mutationId: second, id: "item-1", text: "Buy milk" },
  ]);
  expect(op.getState()).toEqual({ status: "pending", sent, failure: null, error: null });

  fake.fire(second, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(accepted).toEqual([sent]);
  expect(fake.retired).toEqual([first, second]);
  expect(fake.unsubscribed).toEqual([first, second]);
});

test("retry is only allowed from failed", () => {
  const { fake, op } = setup();
  expect(op.retry()).toBe(false);
  op.start(sent);
  expect(op.retry()).toBe(false);
  fake.fire(fake.ids[0], "accepted");
  expect(op.retry()).toBe(false);
  expect(fake.ids).toHaveLength(1);
});

test("a late notification for a failed attempt cannot revive it", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "rejected");
  fake.fire(id, "accepted");
  expect(op.getState().status).toBe("failed");
  expect(accepted).toEqual([]);
  expect(fake.retired).toEqual([id]);
});

test("build returning null settles without sending, subscribing or onAccepted", () => {
  const { fake, op, accepted } = setup({ build: () => null });
  expect(op.start(sent)).toBe(true);
  expect(op.getState()).toEqual({ status: "settled", sent, failure: null, error: null });
  expect(fake.sends).toEqual([]);
  expect(fake.ids).toEqual([]);
  expect(fake.retired).toEqual([]);
  expect(accepted).toEqual([]);
});

test("start is ignored while pending or uncertain and allowed again after a terminal outcome", () => {
  const { fake, op } = setup();
  expect(op.start(sent)).toBe(true);
  expect(op.start({ itemId: "item-2", text: "other" })).toBe(false);
  fake.fire(fake.ids[0], "timeout");
  expect(op.start({ itemId: "item-2", text: "other" })).toBe(false);
  expect(fake.sends).toHaveLength(1);
  expect(op.getState().sent).toBe(sent);

  fake.fire(fake.ids[0], "accepted");
  const next = { itemId: "item-2", text: "other" };
  expect(op.start(next)).toBe(true);
  expect(op.getState()).toEqual({ status: "pending", sent: next, failure: null, error: null });
  fake.fire(fake.ids[1], "rejected");
  expect(op.start(sent)).toBe(true);
  expect(fake.ids).toHaveLength(3);
});

test("discard retires the live id, returns to idle and ignores later notifications", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [id] = fake.ids;
  fake.fire(id, "uncertain");
  op.discard();
  expect(op.getState()).toEqual({ status: "idle", sent: null, failure: null, error: null });
  expectRetiredOnce(fake, id);

  fake.fire(id, "accepted");
  fake.fire(id, "rejected");
  expect(op.getState().status).toBe("idle");
  expect(accepted).toEqual([]);
  expect(fake.retired).toEqual([id]);
  expect(op.start(sent)).toBe(true);
});

test("discard after a terminal outcome retires nothing twice", () => {
  const { fake, op } = setup();
  op.start(sent);
  fake.fire(fake.ids[0], "rejected");
  op.discard();
  expect(op.getState().status).toBe("idle");
  expect(fake.retired).toEqual([fake.ids[0]]);
});

test("a notification for an id that is no longer the live attempt is ignored", () => {
  const { fake, op, accepted } = setup();
  op.start(sent);
  const [first] = fake.ids;
  fake.fire(first, "rejected");
  op.retry();
  const [, second] = fake.ids;

  fake.fire(first, "accepted");
  expect(op.getState().status).toBe("pending");
  expect(accepted).toEqual([]);
  fake.fire(second, "accepted");
  expect(op.getState().status).toBe("settled");
  expect(accepted).toEqual([sent]);
});

test("hasActiveWork covers pending and uncertain across the scope's operations", () => {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const build = (mutationId: string, text: string): ClientMessage => ({
    type: "checklist.update",
    mutationId,
    id: "item-1",
    text,
  });
  const a = scope.operation<string>({ build, copy: COPY });
  const b = scope.operation<string>({ build, copy: COPY });
  expect(scope.hasActiveWork()).toBe(false);

  a.start("a");
  b.start("b");
  expect(scope.hasActiveWork()).toBe(true);
  fake.fire(fake.ids[0], "accepted");
  expect(scope.hasActiveWork()).toBe(true);
  fake.fire(fake.ids[1], "timeout");
  expect(scope.hasActiveWork()).toBe(true);
  fake.fire(fake.ids[1], "verified-retry");
  expect(scope.hasActiveWork()).toBe(false);
});

test("dispose retires live ids, idles the operations and makes start and retry return false", () => {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const build = (mutationId: string, text: string): ClientMessage => ({
    type: "checklist.update",
    mutationId,
    id: "item-1",
    text,
  });
  const live = scope.operation<string>({ build, copy: COPY });
  const failed = scope.operation<string>({ build, copy: COPY });
  const idle = scope.operation<string>({ build, copy: COPY });
  const unverified = scope.operation<string>({ build, copy: COPY });
  live.start("live");
  failed.start("failed");
  unverified.start("unverified");
  fake.fire(fake.ids[1], "rejected");
  fake.fire(fake.ids[2], "verified-retry");
  const [liveId, failedId, unverifiedId] = fake.ids;

  scope.dispose();
  expect(fake.retired).toEqual([failedId, liveId, unverifiedId]);
  expect(unverified.getState().status).toBe("idle");
  expect(scope.hasActiveWork()).toBe(false);
  expect(live.getState().status).toBe("idle");

  fake.fire(liveId, "accepted");
  expect(live.getState().status).toBe("idle");
  expect(live.start("again")).toBe(false);
  expect(failed.retry()).toBe(false);
  expect(idle.start("never")).toBe(false);
  expect(fake.ids).toHaveLength(3);
});
