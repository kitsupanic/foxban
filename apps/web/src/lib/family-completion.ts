import { familyCompletionRows, type ClientMessage } from "@foxban/shared";
import { generateKeyBetween } from "fractional-indexing";
import { byPosition, type BoardState } from "./apply-mutation";

export function completionFamily(state: BoardState, id: string) {
  const family = familyCompletionRows(state.cards, state.relations, id);
  const completed = new Set(state.columns.filter(column => column.completed).map(column => column.id));
  return { family, open: family.filter(card => !completed.has(card.columnId)) };
}
export function finishMessage(state: BoardState, id: string, columnId: string, position: string, scope: "parent" | "family"): Extract<ClientMessage, { type: "card.finish" }> {
  const parent = state.cards.find(card => card.id === id);
  if (!parent || !state.columns.some(column => column.starting) || !state.columns.some(column => column.id === columnId && column.completed)) throw new Error("Parent or completed status changed. Cancel and review the move again.");
  const { family, open } = completionFamily(state, id);
  let tail = state.cards.filter(card => card.columnId === columnId).sort(byPosition).at(-1)?.position ?? null;
  if (tail === null || tail < position) tail = position;
  const children = scope === "family" ? open.slice().sort(byPosition).map(card => { tail = generateKeyBetween(tail, null); return { id: card.id, position: tail }; }) : [];
  return { type: "card.finish", mutationId: crypto.randomUUID(), id, columnId, position, scope, expectedParentColumnId: parent.columnId, expectedParentPosition: parent.position, expectedFamily: family, children };
}
