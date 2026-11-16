import { expect, test } from "@playwright/test";
import { buildSubtaskHierarchy, type Card, type SubtaskHierarchy } from "@foxban/shared";
import { generateKeyBetween } from "fractional-indexing";
import { byPosition, columnCards, columnRootCards, type BoardState } from "../src/lib/apply-mutation";
import { resolveCardDrop } from "../src/lib/card-drop";

const card = (id: string, position: string, columnId: string): Card => ({ id, title: id, position, columnId, description: "", taskNumber: 1, taskType: "task", priority: "medium", assigneeId: null, dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1 });
const sub = (parent: string, child: string) => ({ id: `${parent}>${child}`, kind: "subtask" as const, sourceCardId: parent, targetCardId: child });
const board = (cards: Card[], relations: ReturnType<typeof sub>[]): BoardState => ({
  columns: [{ id: "todo", title: "Todo", position: "a0", starting: true }, { id: "work", title: "Work", position: "a1" }, { id: "done", title: "Done", position: "a2", completed: true }],
  cards, relations, archivedCards: [], checklistItems: [], attachments: [], comments: [], activities: [], labels: [], cardLabels: [],
});

/** The rendered column: roots by key, each followed depth-first by its same-column descendants. */
function rendered(state: BoardState, hierarchy: SubtaskHierarchy, columnId: string): string[] {
  const inColumn = columnCards(state, columnId);
  const walk = (id: string): string[] => [id, ...inColumn.filter(c => hierarchy.parentByChild.get(c.id) === id).sort(byPosition).flatMap(c => walk(c.id))];
  return columnRootCards(state, columnId, hierarchy).flatMap(c => walk(c.id));
}
function placeBoth(state: BoardState, cardId: string, columnId: string) {
  const hierarchy = buildSubtaskHierarchy(state.cards, state.relations);
  // Today's CardModal rule: after the flat tail of every card in the target column.
  const flat = generateKeyBetween(state.cards.filter(c => c.columnId === columnId && c.id !== cardId).sort(byPosition).at(-1)?.position ?? null, null);
  const peer = resolveCardDrop(state, hierarchy, cardId, `column-drop:${columnId}`)!.position;
  const after = (position: string) => {
    const next = { ...state, cards: state.cards.map(c => c.id === cardId ? { ...c, columnId, position } : c) };
    return rendered(next, buildSubtaskHierarchy(next.cards, next.relations), columnId);
  };
  return { flat, peer, flatOrder: after(flat), peerOrder: after(peer) };
}

const cases: { name: string; state: BoardState; cardId: string; columnId: string }[] = [
  { name: "completing a subtask whose parent is already in Done", cardId: "C", columnId: "done",
    state: board([card("P", "a0", "done"), card("S", "a1", "done"), card("R", "a5", "done"), card("C", "a2", "todo")], [sub("P", "S"), sub("P", "C")]) },
  { name: "completing a subtask whose parent sits before a later root", cardId: "C", columnId: "done",
    state: board([card("R", "a9", "done"), card("P", "a1", "done"), card("C", "a0", "work")], [sub("P", "C")]) },
  { name: "reopening a subtask into a column holding its parent", cardId: "C", columnId: "todo",
    state: board([card("P", "a0", "todo"), card("X", "a3", "todo"), card("C", "a1", "done")], [sub("P", "C")]) },
  { name: "moving a root whose column holds deep families", cardId: "R", columnId: "done",
    state: board([card("P", "a0", "done"), card("C", "a5", "done"), card("G", "a8", "done"), card("R", "a1", "todo")], [sub("P", "C"), sub("C", "G")]) },
];

for (const { name, state, cardId, columnId } of cases) {
  test(`flat tail and peer-aware placement render the same order: ${name}`, () => {
    const { flatOrder, peerOrder, peer } = placeBoth(state, cardId, columnId);
    expect(flatOrder).toEqual(peerOrder);
    // Peer-aware placement must not tie any key already in the destination.
    expect(state.cards.some(c => c.id !== cardId && c.columnId === columnId && c.position === peer)).toBe(false);
  });
}
test("the two rules do mint different keys for a nested child", () => {
  const { flat, peer } = placeBoth(cases[0]!.state, "C", "done");
  expect(flat > "a5").toBe(true); // past the unrelated root R
  expect(peer > "a1" && peer < "a5").toBe(true); // just past its last sibling
});
test("the key difference surfaces once the parent leaves: the child re-ranks among roots differently", () => {
  const { state } = cases[0]!;
  const { flat, peer } = placeBoth(state, "C", "done");
  const rootsAfterParentLeaves = (position: string) => {
    const next = { ...state, cards: state.cards.map(c => c.id === "C" ? { ...c, columnId: "done", position } : c.id === "P" ? { ...c, columnId: "work" } : c) };
    return rendered(next, buildSubtaskHierarchy(next.cards, next.relations), "done");
  };
  expect(rootsAfterParentLeaves(flat)).toEqual(["S", "R", "C"]);
  expect(rootsAfterParentLeaves(peer)).toEqual(["S", "C", "R"]);
});
