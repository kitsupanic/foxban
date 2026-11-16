import type { Card, CardRelation } from "./protocol";

/**
 * A board's subtask forest as the server and every client must read it.
 *
 * A subtask is a full card linked by a `subtask` relation whose source is the
 * parent; the child has its own stored `columnId`. Building this once per state
 * change keeps both sides of the wire agreeing on who parents whom.
 */
export interface SubtaskHierarchy {
  /** Child card id → its one effective parent. Absent for roots. */
  parentByChild: ReadonlyMap<string, string>;
  /** Parent card id → its direct children, in `byPosition` order. */
  childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** Any card id → the highest active ancestor of its chain (itself for roots). */
  rootByCard: ReadonlyMap<string, string>;
}

/** Position strings can collide; the id tiebreak matches `byPosition` in the web reducer. */
function byPosition(
  positionOf: ReadonlyMap<string, string>,
  a: string,
  b: string,
): number {
  const positionA = positionOf.get(a) ?? "";
  const positionB = positionOf.get(b) ?? "";
  if (positionA !== positionB) return positionA < positionB ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Derives the hierarchy from active cards and the board's stored relations.
 *
 * An edge is usable only when its kind is `subtask` and both endpoints are
 * active; self-links, duplicate identical pairs and a child with more than one
 * distinct parent are ignored rather than resolved by guesswork, and cycles left
 * behind by boards written before `relation.create` validated subtask structure
 * lose every edge that forms them. Nothing is deleted or hidden: a card without
 * a usable parent is a root.
 */
export function buildSubtaskHierarchy(
  cards: readonly Pick<Card, "id" | "columnId" | "position">[],
  relations: readonly CardRelation[],
): SubtaskHierarchy {
  const storedPosition = new Map<string, string>();
  for (const card of cards) storedPosition.set(card.id, card.position);

  const parentsByChild = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.kind !== "subtask") continue;
    const parent = relation.sourceCardId;
    const child = relation.targetCardId;
    if (parent === child) continue;
    if (!storedPosition.has(parent) || !storedPosition.has(child)) continue;
    const parents = parentsByChild.get(child) ?? new Set<string>();
    parents.add(parent);
    parentsByChild.set(child, parents);
  }

  const parentByChild = new Map<string, string>();
  for (const [child, parents] of parentsByChild) {
    // Two distinct parents claim this child: neither is authoritative, so the
    // card stays a root until someone unlinks one of them.
    if (parents.size !== 1) continue;
    for (const parent of parents) parentByChild.set(child, parent);
  }

  // Walk every chain once. Revisiting a node inside the same walk means the
  // stored edges form a cycle; dropping all of its edges terminates the forest
  // and leaves each of its members visible as a root.
  const settled = new Set<string>();
  for (const start of [...parentByChild.keys()].sort()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const indexOnPath = new Map<string, number>();
    let node: string | undefined = start;
    while (node !== undefined && !settled.has(node)) {
      const seenAt = indexOnPath.get(node);
      if (seenAt !== undefined) {
        for (let i = seenAt; i < path.length; i += 1) parentByChild.delete(path[i]!);
        break;
      }
      indexOnPath.set(node, path.length);
      path.push(node);
      node = parentByChild.get(node);
    }
    for (const member of path) settled.add(member);
  }

  const pendingChildren = new Map<string, string[]>();
  for (const [child, parent] of parentByChild) {
    const children = pendingChildren.get(parent) ?? [];
    children.push(child);
    pendingChildren.set(parent, children);
  }
  const childrenByParent = new Map<string, readonly string[]>();
  for (const [parent, children] of pendingChildren) {
    children.sort((a, b) => byPosition(storedPosition, a, b));
    childrenByParent.set(parent, children);
  }

  // Memoized upward walks: each card is resolved once, so a deep family costs
  // the same as a flat one and no row re-scans its ancestors.
  const rootByCard = new Map<string, string>();
  const rootOf = (cardId: string): string => {
    const chain: string[] = [];
    let node = cardId;
    let root = cardId;
    for (;;) {
      const known = rootByCard.get(node);
      if (known !== undefined) {
        root = known;
        break;
      }
      chain.push(node);
      const parent = parentByChild.get(node);
      if (parent === undefined) {
        root = node;
        break;
      }
      node = parent;
    }
    for (const member of chain) rootByCard.set(member, root);
    return root;
  };

  for (const card of cards) rootOf(card.id);

  return { parentByChild, childrenByParent, rootByCard };
}

/** Root plus every active descendant in deterministic hierarchy order. */
export function subtaskSubtreeIds(
  hierarchy: Pick<SubtaskHierarchy, "childrenByParent">,
  rootId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const cardId = pending.pop()!;
    if (visited.has(cardId)) continue;
    visited.add(cardId);
    result.push(cardId);
    const children = hierarchy.childrenByParent.get(cardId) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
  return result;
}

/** Active descendants across every status, including retained multilevel families. */
export function familyCompletionRows(cards: readonly Pick<Card, "id" | "columnId" | "position">[], relations: readonly CardRelation[], parentId: string) {
  const hierarchy = buildSubtaskHierarchy(cards, relations);
  const ids = new Set(subtaskSubtreeIds(hierarchy, parentId).slice(1));
  return cards.filter(card => ids.has(card.id)).map(card => ({ id: card.id, parentId: hierarchy.parentByChild.get(card.id)!, columnId: card.columnId, position: card.position })).sort((a, b) => a.id.localeCompare(b.id));
}
