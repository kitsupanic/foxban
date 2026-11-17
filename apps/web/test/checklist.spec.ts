import { expect, test } from "@playwright/test";
import type { ChecklistItem, ClientMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import { createAuthoredScope, type AuthoredTransport } from "../src/lib/authored-operation";
import { createChecklist } from "../src/lib/checklist";
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
const boardWith = (...ids: string[]) => ({ checklistItems: ids.map((id) => ({ id })) }) as unknown as BoardState;
const TOO_LONG = "x".repeat(201);

function setup(items: ChecklistItem[] = []) {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const env = { items, placed: 0, closed: [] as string[] };
  const checklist = createChecklist(scope, {
    cardId: () => "card-1",
    items: () => env.items,
    placeNew: () => `pos-${++env.placed}`,
    onEditClosed: (id) => void env.closed.push(id),
  });
  const last = () => fake.ids[fake.ids.length - 1];
  return { fake, env, checklist, last };
}

test("a checklist text edit keeps its text on refusal", () => {
  const milk = item("item-1", "Buy milk");
  const { fake, env, checklist, last } = setup([milk]);
  checklist.startEdit(milk);
  checklist.setEditText("Buy oat milk");
  checklist.commitEdit(milk);
  expect(fake.sends).toEqual([{ type: "checklist.update", mutationId: last(), id: "item-1", text: "Buy oat milk" }]);
  expect(checklist.getState().edit).toEqual({ pending: true, uncertain: false, error: null });

  fake.fire(last(), "rejected");
  expect(checklist.getState()).toMatchObject({
    editingId: "item-1",
    editText: "Buy oat milk",
    edit: { pending: false, uncertain: false, error: "Server rejected checklist save." },
  });
  expect(env.closed).toEqual([]);
  expect(checklist.hasWork()).toBe(true);

  // Resubmitting is the retry: same item, a fresh attempt.
  checklist.commitEdit(milk);
  expect(fake.sends).toHaveLength(2);
  expect(fake.sends[1]).toMatchObject({ type: "checklist.update", id: "item-1", text: "Buy oat milk" });
  expect(checklist.getState().edit.error).toBeNull();
});

test("a refused send keeps the add draft and nothing leaves on a validation refusal", () => {
  const { fake, checklist } = setup();
  checklist.setNewItem("   ");
  checklist.addItem();
  expect(fake.sends).toEqual([]);
  expect(checklist.getState()).toMatchObject({ newItem: "   ", add: { pending: false, error: "Checklist text must contain 1–200 characters." } });

  checklist.setNewItem(TOO_LONG);
  checklist.clearError("add");
  expect(checklist.getState().add.error).toBeNull();
  checklist.addItem();
  expect(fake.sends).toEqual([]);
  expect(checklist.getState()).toMatchObject({ newItem: TOO_LONG, add: { error: "Checklist text must contain 1–200 characters." } });

  // The edit lane validates on its own, and the error is its own.
  const milk = item("item-1", "Buy milk");
  const edit = setup([milk]);
  edit.checklist.startEdit(milk);
  edit.checklist.setEditText(TOO_LONG);
  edit.checklist.commitEdit(milk);
  expect(edit.fake.sends).toEqual([]);
  expect(edit.checklist.getState()).toMatchObject({ editingId: "item-1", editText: TOO_LONG, edit: { error: "Checklist text must contain 1–200 characters." }, add: { error: null } });
});

test("add clears newItem only on acceptance", () => {
  const { fake, env, checklist, last } = setup();
  checklist.setNewItem("  Buy milk ");
  checklist.addItem();
  const id = (fake.sends[0] as { id: string }).id;
  expect(fake.sends).toEqual([{ type: "checklist.create", mutationId: last(), id, cardId: "card-1", text: "Buy milk", position: "pos-1" }]);
  expect(checklist.getState()).toMatchObject({ newItem: "  Buy milk ", add: { pending: true } });

  fake.fire(last(), "rejected", "No room.");
  expect(checklist.getState()).toMatchObject({ newItem: "  Buy milk ", add: { pending: false, error: "No room." } });

  // Typing dismisses the failure; the next submit is a new lineage.
  checklist.setNewItem("Buy milk");
  checklist.clearError("add");
  expect(checklist.getState().add.error).toBeNull();
  checklist.addItem();
  expect(fake.sends).toHaveLength(2);
  fake.state.board = boardWith((fake.sends[1] as { id: string }).id);
  fake.fire(last(), "accepted");
  expect(checklist.getState()).toMatchObject({ newItem: "", add: { pending: false, error: null } });
  expect(checklist.hasWork()).toBe(false);
  expect(env.closed).toEqual([]);
});

test("an edit accepted after the item was deleted keeps the draft, and Save as new item creates it", () => {
  const milk = item("item-1", "Buy milk");
  const { fake, env, checklist, last } = setup([milk]);
  checklist.startEdit(milk);
  checklist.setEditText("Buy oat milk");
  checklist.commitEdit(milk);
  env.items = [];
  fake.state.board = boardWith();
  fake.fire(last(), "accepted");

  expect(checklist.getState()).toMatchObject({
    editingId: "item-1",
    editText: "Buy oat milk",
    editedItemDeleted: true,
    hasWork: true,
    edit: { pending: false, error: "This item was deleted. Your draft is preserved below." },
  });
  expect(env.closed).toEqual([]);

  checklist.saveEditAsNew();
  const create = fake.sends[1] as { id: string };
  expect(create).toEqual({ type: "checklist.create", mutationId: last(), id: create.id, cardId: "card-1", text: "Buy oat milk", position: "pos-1" });
  expect(create.id).not.toBe("item-1");

  fake.state.board = boardWith(create.id);
  fake.fire(last(), "accepted");
  expect(checklist.getState()).toMatchObject({ editingId: null, editedItemDeleted: false, hasWork: false });
  expect(env.closed).toEqual([create.id]);
});

test("a pending lane ignores a second submit, even when uncertain", () => {
  const milk = item("item-1", "Buy milk");
  const { fake, checklist, last } = setup([milk]);
  checklist.setNewItem("Eggs");
  checklist.addItem();
  checklist.addItem();
  expect(fake.sends).toHaveLength(1);
  fake.fire(last(), "timeout");
  expect(checklist.getState().add).toEqual({ pending: true, uncertain: true, error: null });
  checklist.addItem();
  expect(fake.sends).toHaveLength(1);

  checklist.startEdit(milk);
  checklist.setEditText("Buy oat milk");
  checklist.commitEdit(milk);
  checklist.commitEdit(milk);
  checklist.cancelEdit();
  expect(fake.sends).toHaveLength(2);
  expect(checklist.getState()).toMatchObject({ editingId: "item-1", edit: { pending: true } });
});

test("hasWork is true for a typed add draft, a changed edit, a deleted edit and anything in flight", () => {
  const milk = item("item-1", "Buy milk");
  const { fake, env, checklist, last } = setup([milk]);
  expect(checklist.hasWork()).toBe(false);

  checklist.setNewItem("Eggs");
  expect(checklist.hasWork()).toBe(true);
  expect(checklist.getState().hasWork).toBe(true);
  checklist.setNewItem("");
  expect(checklist.hasWork()).toBe(false);

  checklist.startEdit(milk);
  expect(checklist.hasWork()).toBe(false);
  checklist.setEditText("Buy oat milk");
  expect(checklist.hasWork()).toBe(true);
  checklist.setEditText("Buy milk");
  expect(checklist.hasWork()).toBe(false);

  // A peer's change to the item arrives with the props, not as a notification.
  env.items = [item("item-1", "Buy goat milk")];
  expect(checklist.hasWork()).toBe(true);
  expect(checklist.getState().hasWork).toBe(true);
  env.items = [];
  expect(checklist.getState()).toMatchObject({ editedItemDeleted: true, hasWork: true });

  checklist.discardEdit();
  expect(checklist.getState()).toMatchObject({ editingId: null, editedItemDeleted: false, hasWork: false });

  checklist.setNewItem("Eggs");
  checklist.addItem();
  checklist.setNewItem("");
  expect(checklist.hasWork()).toBe(true);
  fake.state.board = boardWith((fake.sends[0] as { id: string }).id);
  fake.fire(last(), "accepted");
  expect(checklist.hasWork()).toBe(false);
});

test("getState keeps its identity until something changes, and subscribers hear each change", () => {
  const milk = item("item-1", "Buy milk");
  const { env, checklist } = setup([milk]);
  const first = checklist.getState();
  expect(checklist.getState()).toBe(first);

  let heard = 0;
  const unsubscribe = checklist.subscribe(() => void heard++);
  checklist.setNewItem("Eggs");
  expect(heard).toBe(1);
  const second = checklist.getState();
  expect(second).not.toBe(first);
  expect(checklist.getState()).toBe(second);
  checklist.setNewItem("Eggs");
  expect(heard).toBe(1);

  checklist.startEdit(milk);
  const third = checklist.getState();
  env.items = [];
  expect(checklist.getState()).not.toBe(third);
  expect(checklist.getState().editedItemDeleted).toBe(true);
  unsubscribe();
  checklist.revealAdd();
  expect(heard).toBeGreaterThan(0);
  expect(checklist.getState().adding).toBe(true);
  checklist.hideAdd();
  expect(checklist.getState().adding).toBe(false);
});

test("focus returns to an item only for an edit that is still open", () => {
  const milk = item("item-1", "Buy milk");
  const { fake, env, checklist, last } = setup([milk]);

  // Escape returns focus; an unchanged blur or Enter just closes.
  checklist.startEdit(milk);
  checklist.cancelEdit();
  expect(env.closed).toEqual(["item-1"]);
  checklist.startEdit(milk);
  checklist.commitEdit(milk);
  expect(checklist.getState().editingId).toBeNull();
  expect(env.closed).toEqual(["item-1"]);
  expect(fake.sends).toEqual([]);

  // An unverified attempt stays live: leaving the edit and then hearing its late acceptance must not steal focus.
  checklist.startEdit(milk);
  checklist.setEditText("Buy oat milk");
  checklist.commitEdit(milk);
  fake.fire(last(), "verified-retry");
  expect(checklist.getState().edit.error).toBe("Sync could not verify checklist save. You can retry saving.");
  checklist.cancelEdit();
  expect(env.closed).toEqual(["item-1", "item-1"]);
  fake.state.board = boardWith("item-1");
  fake.fire(last(), "accepted");
  expect(env.closed).toEqual(["item-1", "item-1"]);

  // An accepted edit of the open item closes it and returns focus.
  checklist.startEdit(milk);
  checklist.setEditText("Buy soy milk");
  checklist.commitEdit(milk);
  fake.fire(last(), "accepted");
  expect(checklist.getState()).toMatchObject({ editingId: null, edit: { pending: false, error: null } });
  expect(env.closed).toEqual(["item-1", "item-1", "item-1"]);
});
