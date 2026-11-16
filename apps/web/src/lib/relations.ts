import type { Card, CardRelation, RelationKind } from "@foxban/shared";

/** A relation as seen from ONE card: the label to render and the card at the
 * other end. `blocks` rows read "Blocks" from the source and "Blocked by"
 * from the target; `relates` is symmetric. Subtask rows are excluded — they
 * render in the Subtasks section, not here. */
export interface RelationView {
  relation: CardRelation;
  label: "Related to" | "Blocks" | "Blocked by";
  otherCardId: string;
}

export function relationViews(relations: CardRelation[], cardId: string): RelationView[] {
  const views: RelationView[] = [];
  for (const relation of relations) {
    if (relation.kind === "subtask") continue;
    if (relation.sourceCardId === cardId) {
      views.push({
        relation,
        label: relation.kind === "blocks" ? "Blocks" : "Related to",
        otherCardId: relation.targetCardId,
      });
    } else if (relation.targetCardId === cardId) {
      views.push({
        relation,
        label: relation.kind === "blocks" ? "Blocked by" : "Related to",
        otherCardId: relation.sourceCardId,
      });
    }
  }
  return views;
}

/** True when some other card blocks this one — the card-front warning state. */
export function isBlocked(relations: CardRelation[], cardId: string): boolean {
  return relations.some((r) => r.kind === "blocks" && r.targetCardId === cardId);
}

/** The composer's three options map onto the two stored kinds: "Blocked by"
 * stores the reversed `blocks` row. */
export const RELATION_OPTIONS = [
  { value: "relates", label: "Related to", reversed: false },
  { value: "blocks", label: "Blocks", reversed: false },
  { value: "blocked-by", label: "Blocked by", reversed: true },
] as const;
export type RelationOptionValue = (typeof RELATION_OPTIONS)[number]["value"];

export function buildRelation(
  option: RelationOptionValue,
  cardId: string,
  otherCardId: string,
): { sourceCardId: string; targetCardId: string; kind: RelationKind } {
  const meta = RELATION_OPTIONS.find((o) => o.value === option)!;
  return {
    sourceCardId: meta.reversed ? otherCardId : cardId,
    targetCardId: meta.reversed ? cardId : otherCardId,
    kind: option === "relates" ? "relates" : "blocks",
  };
}

/** Duplicate = same unordered pair AND same stored kind ("relates" matches
 * either direction; "blocks" is directional, so A→B and B→A both count as
 * already-linked to keep the pair unambiguous, like Jira). */
export function alreadyLinked(
  relations: CardRelation[],
  kind: RelationKind,
  a: string,
  b: string,
): boolean {
  return relations.some(
    (r) =>
      r.kind === kind &&
      ((r.sourceCardId === a && r.targetCardId === b) ||
        (r.sourceCardId === b && r.targetCardId === a)),
  );
}

export function cardTitle(cards: Card[], cardId: string): string {
  return cards.find((c) => c.id === cardId)?.title ?? "(deleted card)";
}

/** Links shown by the relations badge: everything except subtask rows, which have
 * their own subtask badge on the parent side only. */
export function nonSubtaskLinks(relations: CardRelation[]): CardRelation[] {
  return relations.filter((r) => r.kind !== "subtask");
}
