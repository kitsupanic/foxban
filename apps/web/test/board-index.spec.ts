import { expect, test } from "@playwright/test";
import {
  activeCardComments,
  buildBoardIndex,
  cardAttachments,
  cardChecklist,
  cardFace,
  cardLabelViews,
  cardRelations,
  type BoardState,
} from "../src/lib/apply-mutation";

// The index must answer, per card, exactly what the per-card scans answer.
const card = (id: string) => ({ id, columnId: "c", title: id, description: "", position: "a0" });

const state = {
  workflowRolesExplicit: true,
  columns: [],
  cards: [card("a"), card("b"), card("c")],
  archivedCards: [],
  checklistItems: [
    { id: "i1", cardId: "a", text: "x", done: true, position: "a0" },
    { id: "i2", cardId: "a", text: "y", done: false, position: "a1" },
    { id: "i3", cardId: "b", text: "z", done: false, position: "a0" },
  ],
  attachments: [{ id: "f1", cardId: "a" }, { id: "f2", cardId: "a" }, { id: "f3", cardId: "c" }],
  comments: [
    { id: "m1", cardId: "a", createdAt: 1, deleted: false },
    { id: "m2", cardId: "a", createdAt: 2, deleted: true },
    { id: "m3", cardId: "b", createdAt: 3, deleted: false },
  ],
  relations: [
    { id: "r1", sourceCardId: "a", targetCardId: "b", kind: "blocks" },
    { id: "r2", sourceCardId: "b", targetCardId: "gone", kind: "relates" },
    { id: "r3", sourceCardId: "c", targetCardId: "c", kind: "relates" },
  ],
  labels: [
    { id: "l1", name: "Zeta", color: "red" },
    { id: "l2", name: "alpha", color: "blue" },
  ],
  cardLabels: [
    { id: "j1", cardId: "a", labelId: "l1" },
    { id: "j2", cardId: "a", labelId: "l2" },
    { id: "j3", cardId: "a", labelId: "l1" },
    { id: "j4", cardId: "b", labelId: "missing" },
  ],
} as unknown as BoardState;

test("the board index matches the per-card helpers for every card", () => {
  const index = buildBoardIndex(state);
  const activeIds = new Set(state.cards.map((c) => c.id));
  for (const { id } of state.cards) {
    const face = cardFace(index, id);
    const items = cardChecklist(state, id);
    expect(face.checklistTotal).toBe(items.length);
    expect(face.checklistDone).toBe(items.filter((item) => item.done).length);
    expect(face.attachmentCount).toBe(cardAttachments(state, id).length);
    expect(face.commentCount).toBe(activeCardComments(state, id).length);
    expect(face.relations).toEqual(cardRelations(state, id, activeIds));
    expect(face.labels).toEqual(cardLabelViews(state, id).map((view) => view.label));
    expect(index.cardsById.get(id)?.id).toBe(id);
  }
  expect(cardFace(index, "unknown").checklistTotal).toBe(0);
});
