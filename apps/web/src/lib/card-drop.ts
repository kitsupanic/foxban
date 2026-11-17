import type { SubtaskHierarchy } from "@foxban/shared";
import { generateKeyBetween } from "fractional-indexing";
import { byPosition, boardAncestors, columnCards, columnRootCards, type BoardState } from "./apply-mutation";

export interface CardDrop {
  columnId: string;
  position: string;
  /** The visible boundary affected by the move, rather than a flat-key neighbour. */
  hint: { cardId: string; placement: "before" | "after" | "inside" } | null;
}

/** Direct peers of the dragged row at a prospective status, in full key order. */
export function cardDropPeers(state: BoardState, hierarchy: SubtaskHierarchy, cardId: string, columnId: string) {
  const parentId = hierarchy.parentByChild.get(cardId);
  const nested = parentId !== undefined && state.cards.some(card => card.id === parentId && card.columnId === columnId);
  return nested ? columnCards(state, columnId).filter(card => hierarchy.parentByChild.get(card.id) === parentId) : columnRootCards(state, columnId, hierarchy);
}

/** A drop orders one row among its displayed peers; it never changes parentage. */
export function resolveCardDrop(state: BoardState, hierarchy: SubtaskHierarchy, cardId: string, targetId: string, side?: "before" | "after"): CardDrop | null {
  const card = state.cards.find(candidate => candidate.id === cardId);
  if (!card || targetId === cardId) return null;
  const columnId = targetId.startsWith("column-drop:") ? targetId.slice("column-drop:".length) : targetId;
  const column = state.columns.find(candidate => candidate.id === columnId);
  const target = column ? undefined : state.cards.find(candidate => candidate.id === targetId);
  const destination = column?.id ?? target?.columnId;
  if (!destination) return null;
  const parentId = hierarchy.parentByChild.get(cardId);
  const nested = parentId !== undefined && state.cards.some(candidate => candidate.id === parentId && candidate.columnId === destination);
  const peers = cardDropPeers(state, hierarchy, cardId, destination).filter(candidate => candidate.id !== cardId);

  // A descendant body belongs to its containing peer. For children returning to
  // their parent's status, only that parent's direct siblings define order.
  let boundary = target?.id;
  if (boundary) {
    const chain = [boundary, ...boardAncestors(state, hierarchy, boundary)];
    if (chain.includes(cardId)) return null;
    boundary = chain.find(id => peers.some(candidate => candidate.id === id));
  }
  let index = peers.length;
  let hint: CardDrop["hint"] = nested ? { cardId: parentId, placement: "inside" } : null;
  if (boundary) {
    const targetIndex = peers.findIndex(candidate => candidate.id === boundary);
    const movingDown = boundary === target?.id && side !== undefined ? side === "after" : destination === card.columnId && byPosition(card, peers[targetIndex]!) < 0;
    index = targetIndex + (movingDown ? 1 : 0);
    hint = { cardId: boundary, placement: movingDown ? "after" : "before" };
  } else if (!nested && peers.length) {
    hint = { cardId: peers[peers.length - 1]!.id, placement: "after" };
  }
  const currentIndex = peers.filter(candidate => byPosition(candidate, card) < 0).length;
  if (destination === card.columnId && index === currentIndex) return null;
  // Peers are a subset of the column, so the gap after `lower` may hold other rows' keys
  // (a nested child's, or a parent's). Bounding by the first key above `lower` in the whole
  // column keeps the new key unique; it still sorts after the previous peer and before the next.
  const nextPeer = peers[index]?.position ?? null;
  // A first child sorts after its parent rather than before the whole column, but only
  // when the parent's key is below the next peer (a parent can sort after its children).
  const parentPosition = nested ? state.cards.find(candidate => candidate.id === parentId)!.position : null;
  const lower = peers[index - 1]?.position ?? (parentPosition !== null && (nextPeer === null || parentPosition < nextPeer) ? parentPosition : null);
  const columnAbove = columnCards(state, destination).find(candidate => candidate.id !== cardId && (lower === null || candidate.position > lower))?.position ?? null;
  const upper = nextPeer !== null && (columnAbove === null || nextPeer < columnAbove) ? nextPeer : columnAbove;
  try {
    return { columnId: destination, position: generateKeyBetween(lower, upper), hint };
  } catch {
    // Concurrent equal peer keys: the next peer ties `lower`, so append past it in the column.
    try { return { columnId: destination, position: generateKeyBetween(lower, columnAbove), hint }; } catch { return null; }
  }
}
