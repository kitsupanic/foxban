import type { Card, CardRelation, SubtaskHierarchy } from "@foxban/shared";

/**
 * One subtask row plus its already-ordered descendants. `relationId` is the
 * parent→child link the row can unlink, so a view never has to search the
 * board's relations again.
 */
export interface SubtaskNode {
  card: Card;
  relationId: string;
  children: readonly SubtaskNode[];
}

/**
 * Assembles the tree under one parent from the shared hierarchy. `includeCard`
 * keeps a filtered board honest: a row survives when it matches, and a row that
 * is only the path to a match survives as context for it. `directOnly` is the
 * detail view, which lists one level and navigates for the rest.
 *
 * Pure data shaping: this file never imports React, so the board, the card detail
 * and the service-free logic specs all read one implementation.
 */
export function buildSubtaskNodes(
  state: { cards: readonly Card[]; relations: readonly CardRelation[] },
  hierarchy: SubtaskHierarchy,
  parentCardId: string,
  options: { includeCard?: (cardId: string) => boolean; directOnly?: boolean; sameColumn?: boolean } = {},
): SubtaskNode[] {
  const cardById = new Map(state.cards.map((card) => [card.id, card]));
  const relationByChild = new Map<string, string>();
  for (const relation of state.relations) {
    if (relation.kind === "subtask" && !relationByChild.has(relation.targetCardId)) {
      relationByChild.set(relation.targetCardId, relation.id);
    }
  }

  const build = (cardId: string): SubtaskNode[] => {
    const nodes: SubtaskNode[] = [];
    for (const childId of hierarchy.childrenByParent.get(cardId) ?? []) {
      const card = cardById.get(childId);
      const relationId = relationByChild.get(childId);
      if (!card || relationId === undefined) continue;
      if (options.sameColumn && card.columnId !== cardById.get(cardId)?.columnId) continue;
      const children = options.directOnly === true ? [] : build(childId);
      if (
        options.includeCard !== undefined &&
        !options.includeCard(childId) &&
        children.length === 0
      ) {
        continue;
      }
      nodes.push({ card, relationId, children });
    }
    return nodes;
  };
  return build(parentCardId);
}

/**
 * Completion of one card's direct active children. Checking a child never
 * completes its parent and never counts a grandchild: each level owns its own
 * count, which is why this is always the direct children of one card.
 */
export function directSubtaskCounts(
  cards: readonly Card[],
  hierarchy: SubtaskHierarchy,
  parentCardId: string,
): { done: number; total: number } {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const children = hierarchy.childrenByParent.get(parentCardId) ?? [];
  let done = 0;
  for (const childId of children) {
    if (cardById.get(childId)?.subtaskDone === true) done += 1;
  }
  return { done, total: children.length };
}
