import { expect, test } from "@playwright/test";
import { buildSubtaskHierarchy, type Card } from "@foxban/shared";
import { resolveCardDrop } from "../src/lib/card-drop";
import type { BoardState } from "../src/lib/apply-mutation";

const card = (id: string, position: string, columnId = "todo"): Card => ({ id, title: id, position, columnId, description: "", taskNumber: 1, taskType: "task", priority: "medium", assigneeId: null, dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1 });
function fixture() {
  const state: BoardState = {
    columns: [{ id: "todo", title: "Todo", position: "a0", starting: true }, { id: "work", title: "Work", position: "a1" }, { id: "done", title: "Done", position: "a2", completed: true }],
    // Keys deliberately interleave while the board groups P,C1,C2 then R.
    cards: [card("P", "a0"), card("R", "a2"), card("C1", "a4"), card("C2", "a6"), card("return", "a8", "work"), card("G", "a9")],
    relations: [{ id: "r1", kind: "subtask", sourceCardId: "P", targetCardId: "C1" }, { id: "r2", kind: "subtask", sourceCardId: "P", targetCardId: "C2" }, { id: "r3", kind: "subtask", sourceCardId: "P", targetCardId: "return" }, { id: "r4", kind: "subtask", sourceCardId: "C2", targetCardId: "G" }],
    archivedCards: [], checklistItems: [], attachments: [], comments: [], activities: [], labels: [], cardLabels: [],
  };
  return { state, hierarchy: buildSubtaskHierarchy(state.cards, state.relations) };
}
test("self-drop and parent over its own descendant are no-ops", () => {
  const { state, hierarchy } = fixture();
  expect(resolveCardDrop(state, hierarchy, "C2", "C2")).toBeNull();
  expect(resolveCardDrop(state, hierarchy, "P", "G")).toBeNull();
});
test("roots use the visible family boundary, not a descendant's flat key", () => {
  const { state, hierarchy } = fixture();
  const drop = resolveCardDrop(state, hierarchy, "R", "G")!;
  expect(drop.position < "a0").toBe(true);
  expect(drop.hint).toEqual({ cardId: "P", placement: "before" });
});
test("a returning child joins its own family even when hovering an unrelated root", () => {
  const { state, hierarchy } = fixture();
  const drop = resolveCardDrop(state, hierarchy, "return", "R")!;
  expect(drop.columnId).toBe("todo");
  expect(drop.position > "a6").toBe(true);
  expect(drop.hint).toEqual({ cardId: "P", placement: "inside" });
});
test("child reorder compares direct peers and accepts grandchild targets", () => {
  const { state, hierarchy } = fixture();
  const down = resolveCardDrop(state, hierarchy, "C1", "G")!;
  expect(down.position > "a6").toBe(true);
  expect(down.hint).toEqual({ cardId: "C2", placement: "after" });
  const up = resolveCardDrop(state, hierarchy, "C2", "C1")!;
  expect(up.position < "a4").toBe(true);
});
test("a child leaving its parent's column orders among destination roots", () => {
  const { state, hierarchy } = fixture();
  const drop = resolveCardDrop(state, hierarchy, "C1", "return")!;
  expect(drop.columnId).toBe("work");
  expect(drop.position < "a8").toBe(true);
});
test("empty columns accept one row and unknown targets cancel", () => {
  const { state, hierarchy } = fixture();
  expect(resolveCardDrop(state, hierarchy, "C1", "column-drop:done")?.columnId).toBe("done");
  expect(resolveCardDrop(state, hierarchy, "C1", "missing")).toBeNull();
});
test("column-body drops append among the full unfiltered displayed peers", () => {
  const { state, hierarchy } = fixture();
  const drop = resolveCardDrop(state, hierarchy, "return", "column-drop:todo")!;
  expect(drop.position > "a6").toBe(true);
  expect(resolveCardDrop(state, hierarchy, "C2", "P")).toBeNull();
});
test("pointer midpoint chooses the exact peer boundary independent of travel direction", () => {
  const { state, hierarchy } = fixture();
  const before = resolveCardDrop(state, hierarchy, "C2", "C1", "before")!;
  expect(before.position < "a4").toBe(true);
  expect(before.hint?.placement).toBe("before");
  expect(resolveCardDrop(state, hierarchy, "C2", "C1", "after")).toBeNull();
});
test("concurrent equal keys retain the non-throwing one-row fallback", () => {
  const { state, hierarchy } = fixture();
  state.cards.find(card => card.id === "C2")!.position = "a4";
  const drop = resolveCardDrop(state, hierarchy, "return", "C2", "before")!;
  expect(drop.position > "a4").toBe(true);
});

// A peer-only tail ignores keys held by non-peers in the column (a parent, or a root's nested
// children); every drop must still mint a key no other card in the destination holds.
const uniqueIn = (state: BoardState, columnId: string, cardId: string, position: string) =>
  !state.cards.some(other => other.id !== cardId && other.columnId === columnId && other.position === position);
test("reopening children into their parent's column never ties the parent or a later root", () => {
  const state: BoardState = { ...fixture().state, cards: [card("P", "a0"), card("X", "a1"), card("C1", "a0", "done"), card("C2", "a1", "done")], relations: [{ id: "r1", kind: "subtask", sourceCardId: "P", targetCardId: "C1" }, { id: "r2", kind: "subtask", sourceCardId: "P", targetCardId: "C2" }] };
  for (const id of ["C1", "C2"]) {
    const drop = resolveCardDrop(state, buildSubtaskHierarchy(state.cards, state.relations), id, "column-drop:todo")!;
    expect(drop.hint).toEqual({ cardId: "P", placement: "inside" });
    expect(uniqueIn(state, "todo", id, drop.position)).toBe(true);
    state.cards.find(c => c.id === id)!.columnId = "todo";
    state.cards.find(c => c.id === id)!.position = drop.position;
  }
  const keys = state.cards.filter(c => c.columnId === "todo").map(c => c.position);
  expect(new Set(keys).size).toBe(keys.length);
});
test("a root dropped on a column body never ties the last root's nested child", () => {
  const state: BoardState = { ...fixture().state, cards: [card("R", "a0"), card("K", "a1"), card("N", "a0", "work")], relations: [{ id: "r1", kind: "subtask", sourceCardId: "R", targetCardId: "K" }] };
  const drop = resolveCardDrop(state, buildSubtaskHierarchy(state.cards, state.relations), "N", "column-drop:todo")!;
  expect(drop.position > "a0").toBe(true);
  expect(uniqueIn(state, "todo", "N", drop.position)).toBe(true);
});
