import { expect, test } from "@playwright/test";
import type { ChecklistItem, ClientMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import { createAuthoredScope, type AuthoredTransport } from "../src/lib/authored-operation";
import { createSubtaskComposer } from "../src/lib/subtask-composer";
import type { MutationSettledStatus } from "../src/lib/socket";

// Callbacks stay reachable after unsubscribe so the tests can prove the core ignores them itself.
function fakeTransport() {
  const sends: ClientMessage[] = [];
  const subscribed: string[] = [];
  const callbacks = new Map<string, Parameters<AuthoredTransport["subscribe"]>[1]>();
  const state = { connected: true, board: undefined as BoardState | undefined };
  return {
    state,
    sends,
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
        return () => {};
      },
      retire: () => {},
      readBoard: () => state.board,
    } satisfies AuthoredTransport,
  };
}

const item = (id: string, text: string): ChecklistItem => ({ id, cardId: "card-1", text, done: false, position: "a0" });

function setup() {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const env = { isSubtask: false, placed: 0, doneFlags: [] as boolean[] };
  const subtasks = createSubtaskComposer(scope, {
    cardId: () => "card-1",
    isSubtask: () => env.isSubtask,
    placeTail: (done) => {
      env.doneFlags.push(done);
      return `tail-${++env.placed}`;
    },
  });
  const last = () => fake.ids[fake.ids.length - 1];
  const compose = (text: string) => {
    subtasks.openComposer();
    subtasks.setDraft(text);
  };
  return { fake, env, subtasks, last, compose };
}

test("a retry reuses the entity and relation ids, so it is one child, not two", () => {
  const { fake, subtasks, last, compose } = setup();
  compose("  Write docs ");
  subtasks.add();
  const first = fake.sends[0] as { id: string; relationId: string };
  expect(fake.sends[0]).toEqual({
    type: "subtask.create",
    mutationId: last(),
    id: first.id,
    parentCardId: "card-1",
    relationId: first.relationId,
    title: "Write docs",
    position: "tail-1",
  });
  const firstAttempt = last();

  fake.fire(last(), "rejected");
  expect(subtasks.getState().composer).toMatchObject({
    pending: false,
    error: null,
    recovery: { error: "Server rejected the subtask.", rawDraft: "  Write docs " },
  });
  expect(subtasks.getState().draft).toBe("  Write docs ");

  subtasks.retry();
  expect(fake.sends).toHaveLength(2);
  expect(fake.sends[1]).toMatchObject({ type: "subtask.create", id: first.id, relationId: first.relationId, title: "Write docs", position: "tail-1" });
  expect(last()).not.toBe(firstAttempt);
  // The recovery stays on screen, with its last error, while the retry runs.
  expect(subtasks.getState().composer).toMatchObject({ pending: true, recovery: { error: "Server rejected the subtask." } });

  fake.fire(last(), "accepted");
  expect(subtasks.getState()).toMatchObject({ composing: false, draft: "", composer: { pending: false, error: null, recovery: null }, hasWork: false });
});

test("a retry after discard sends nothing", () => {
  const { fake, subtasks, compose } = setup();
  compose("Write docs");
  subtasks.add();
  fake.fire(fake.ids[0], "rejected");
  expect(subtasks.getState().composer.recovery).not.toBeNull();

  subtasks.discardRecovery();
  expect(subtasks.getState().composer).toMatchObject({ pending: false, error: null, recovery: null });
  subtasks.retry();
  expect(fake.sends).toHaveLength(1);
  expect(subtasks.getState().composer.pending).toBe(false);
  // The draft is still there to be sent as a fresh lineage.
  expect(subtasks.getState()).toMatchObject({ composing: true, draft: "Write docs" });
});

test("acceptance clears the draft only while the field still holds what was submitted", () => {
  const { fake, subtasks, last, compose } = setup();
  compose("Write docs");
  subtasks.add();
  subtasks.setDraft("Write docs, then ship");
  fake.fire(last(), "accepted");
  expect(subtasks.getState()).toMatchObject({ composing: true, draft: "Write docs, then ship", composer: { pending: false, recovery: null } });

  // A cancel after the submit forgets the lineage: its late acceptance changes nothing, even when
  // the field holds the same text again.
  subtasks.setDraft("Ship");
  subtasks.add();
  const submitted = last();
  subtasks.cancel(true);
  expect(subtasks.getState()).toMatchObject({ composing: false, draft: "" });
  compose("Ship");
  fake.fire(submitted, "accepted");
  expect(subtasks.getState()).toMatchObject({ composing: true, draft: "Ship" });
});

test("a blank draft sends nothing, and a pending or recovered composer ignores another submit", () => {
  const { fake, subtasks, last, compose } = setup();
  compose("   ");
  subtasks.add();
  expect(fake.sends).toEqual([]);

  subtasks.setDraft("Write docs");
  subtasks.add();
  subtasks.add();
  expect(fake.sends).toHaveLength(1);
  fake.fire(last(), "timeout");
  expect(subtasks.getState().composer).toMatchObject({ pending: true, uncertain: true });
  subtasks.add();
  subtasks.retry();
  expect(fake.sends).toHaveLength(1);

  // An unverified attempt is a recovery; a new submit waits for retry or discard.
  fake.fire(last(), "verified-retry");
  expect(subtasks.getState().composer).toMatchObject({
    pending: false,
    recovery: { error: "Sync could not verify the subtask. You can retry sending." },
  });
  subtasks.add();
  expect(fake.sends).toHaveLength(1);
});

test("a first attempt that never left is an inline error, not a recovery", () => {
  const { fake, subtasks, last, compose } = setup();
  fake.state.connected = false;
  compose("Write docs");
  subtasks.add();
  expect(fake.sends).toEqual([]);
  expect(subtasks.getState().composer).toEqual({ pending: false, uncertain: false, error: "Not connected — try again.", recovery: null });
  expect(subtasks.getState()).toMatchObject({ draft: "Write docs", hasWork: true });

  // Typing dismisses it; the next submit is a new lineage with fresh ids.
  subtasks.clearError();
  expect(subtasks.getState().composer.error).toBeNull();
  fake.state.connected = true;
  subtasks.add();
  expect(fake.sends).toHaveLength(1);

  // A retry that does not leave is a recovery, and keeps showing why.
  fake.fire(last(), "rejected", "No room.");
  expect(subtasks.getState().composer.recovery).toMatchObject({ error: "No room." });
  fake.state.connected = false;
  subtasks.retry();
  expect(subtasks.getState().composer).toMatchObject({ pending: false, error: null, recovery: { error: "Not connected — try again.", rawDraft: "Write docs" } });
});

test("cancel is ignored while a write or recovery is in play unless forced, and clears everything when it runs", () => {
  const { fake, subtasks, last, compose } = setup();
  compose("Write docs");
  subtasks.add();
  subtasks.cancel();
  expect(subtasks.getState()).toMatchObject({ composing: true, draft: "Write docs", composer: { pending: true } });

  fake.fire(last(), "rejected");
  subtasks.cancel();
  expect(subtasks.getState().composer.recovery).not.toBeNull();

  subtasks.cancel(true);
  expect(subtasks.getState()).toMatchObject({ composing: false, draft: "", composer: { pending: false, recovery: null }, hasWork: false });

  compose("");
  subtasks.cancel();
  expect(subtasks.getState().composing).toBe(false);
});

test("conversion refuses an empty item without sending, and the refusal clears on the next valid convert", () => {
  const { fake, subtasks } = setup();
  subtasks.convert(item("item-1", "   "));
  expect(fake.sends).toEqual([]);
  expect(subtasks.getState().conversion).toEqual({ pendingItemId: null, uncertain: false, error: "Checklist item is empty.", recovery: null, busy: false });
  expect(subtasks.getState().hasWork).toBe(false);

  subtasks.convert(item("item-2", "Write docs"));
  expect(fake.sends).toHaveLength(1);
  expect(subtasks.getState().conversion).toMatchObject({ pendingItemId: "item-2", error: null, busy: true });
});

test("conversion carries the stored text untrimmed and the item id, and the composer trims", () => {
  const { fake, subtasks, last, compose } = setup();
  subtasks.convert(item("item-1", " Write docs "));
  const convert = fake.sends[0] as { id: string; relationId: string };
  expect(fake.sends[0]).toEqual({
    type: "subtask.create",
    mutationId: last(),
    id: convert.id,
    parentCardId: "card-1",
    relationId: convert.relationId,
    title: " Write docs ",
    position: "tail-1",
    checklistItemId: "item-1",
  });

  // Settling the conversion never speaks for the composer lane.
  compose("Draft");
  fake.fire(last(), "accepted");
  expect(subtasks.getState()).toMatchObject({
    composing: true,
    draft: "Draft",
    conversion: { pendingItemId: null, busy: false, recovery: null, error: null },
  });
  subtasks.add();
  expect(fake.sends[1]).toMatchObject({ title: "Draft", position: "tail-2" });
  expect(fake.sends[1]).not.toHaveProperty("checklistItemId");
});

test("the conversion lane is single-slot, and a retry sends the same ids", () => {
  const { fake, subtasks, last } = setup();
  const docs = item("item-1", "Write docs");
  const ship = item("item-2", "Ship it");
  subtasks.convert(docs);
  subtasks.convert(ship);
  expect(fake.sends).toHaveLength(1);

  fake.fire(last(), "timeout");
  expect(subtasks.getState().conversion).toMatchObject({ pendingItemId: "item-1", uncertain: true, busy: true });
  subtasks.convert(ship);
  subtasks.retryConversion();
  expect(fake.sends).toHaveLength(1);

  fake.fire(last(), "rejected");
  expect(subtasks.getState().conversion).toMatchObject({ pendingItemId: null, recovery: { error: "Server rejected the conversion." }, busy: true });
  subtasks.convert(ship);
  expect(fake.sends).toHaveLength(1);

  const first = fake.sends[0] as { id: string; relationId: string };
  subtasks.retryConversion();
  expect(fake.sends).toHaveLength(2);
  expect(fake.sends[1]).toMatchObject({ id: first.id, relationId: first.relationId, title: "Write docs", checklistItemId: "item-1" });
  expect(subtasks.getState().conversion).toMatchObject({ pendingItemId: "item-1", recovery: { error: "Server rejected the conversion." } });

  fake.fire(last(), "verified-retry");
  expect(subtasks.getState().conversion.recovery).toMatchObject({ error: "Sync could not verify the conversion. You can retry the same item." });
  subtasks.discardConversion();
  expect(subtasks.getState().conversion).toMatchObject({ busy: false, recovery: null });
  subtasks.convert(ship);
  expect(fake.sends).toHaveLength(3);
  expect(fake.sends[2]).toMatchObject({ title: "Ship it", checklistItemId: "item-2" });
});

test("a subtask card cannot convert", () => {
  const { fake, env, subtasks } = setup();
  env.isSubtask = true;
  subtasks.convert(item("item-1", "Write docs"));
  expect(fake.sends).toEqual([]);

  env.isSubtask = false;
  subtasks.convert(item("item-1", "Write docs"));
  fake.fire(fake.ids[0], "rejected");
  env.isSubtask = true;
  subtasks.retryConversion();
  expect(fake.sends).toHaveLength(1);
});

test("hasWork guards a typed title and anything in play; keepsCardOpen only a typed title or a recovery", () => {
  const { fake, subtasks, last, compose } = setup();
  expect(subtasks.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });

  // An open composer with no text is nothing yet; a typed title is a draft.
  subtasks.openComposer();
  expect(subtasks.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
  subtasks.setDraft("  ");
  expect(subtasks.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
  subtasks.setDraft("Write docs");
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });

  // A write in flight guards the close but is the scope's to report, not the card's to be kept open for.
  subtasks.add();
  subtasks.setDraft("");
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "rejected");
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  subtasks.discardRecovery();
  expect(subtasks.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });

  subtasks.convert(item("item-1", "Write docs"));
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "timeout");
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "verified-retry");
  expect(subtasks.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  subtasks.discardConversion();
  expect(subtasks.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
});

test("getState keeps its identity until something changes, and subscribers hear each change", () => {
  const { fake, subtasks, last } = setup();
  const first = subtasks.getState();
  expect(subtasks.getState()).toBe(first);

  let heard = 0;
  const unsubscribe = subtasks.subscribe(() => void heard++);
  subtasks.openComposer();
  expect(heard).toBe(1);
  const second = subtasks.getState();
  expect(second).not.toBe(first);
  expect(subtasks.getState()).toBe(second);

  subtasks.setDraft("Write docs");
  expect(heard).toBe(2);
  subtasks.setDraft("Write docs");
  expect(heard).toBe(2);

  // An operation's own state changes are heard too.
  subtasks.add();
  expect(heard).toBeGreaterThan(2);
  const pending = subtasks.getState();
  expect(pending.composer.pending).toBe(true);
  fake.fire(last(), "accepted");
  expect(subtasks.getState()).not.toBe(pending);
  unsubscribe();
  const before = heard;
  subtasks.openComposer();
  expect(heard).toBe(before);
});

test("placement follows the item's done flag: a done item lands in the completed column, a new subtask in the starting one", () => {
  const { env, subtasks, compose } = setup();
  subtasks.convert({ ...item("item-1", "Ship"), done: true });
  compose("New");
  subtasks.add();
  expect(env.doneFlags).toEqual([true, false]);
});
