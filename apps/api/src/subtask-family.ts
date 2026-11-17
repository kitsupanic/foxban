import {
  buildSubtaskHierarchy,
  familyCompletionRows,
  type Card,
  type CardRelation,
  type ClientMessage,
  type SubtaskHierarchy,
} from "@foxban/shared";
import { MutationRefusal } from "./mutation-gate";

/**
 * The subtask family rules (ADRs 0019, 0057, 0059, 0067) as plain reads over a
 * board's SQLite. Each check throws the refusal the DO has always sent; none writes.
 * The BoardDO applies the writes, and its migrations keep their own frozen copies.
 */

type CardPlacement = Pick<Card, "id" | "columnId" | "position">;

function placements(sql: SqlStorage, scope: "active" | "retained"): CardPlacement[] {
  return sql
    .exec<CardPlacement>(
      `SELECT id, column_id AS columnId, position FROM cards${scope === "active" ? " WHERE archived_at IS NULL" : ""}`,
    )
    .toArray();
}

function relations(sql: SqlStorage): CardRelation[] {
  return sql
    .exec<CardRelation>(
      `SELECT id, source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
         FROM card_relations`,
    )
    .toArray();
}

/**
 * The board's forest by the shared resolver the web reducer also runs. `active`
 * is the live family; `retained` also counts archived cards, whose links survive.
 */
export function loadFamily(sql: SqlStorage, scope: "active" | "retained"): SubtaskHierarchy {
  return buildSubtaskHierarchy(placements(sql, scope), relations(sql));
}

/** The column holding a workflow role, or undefined while the board has none (fewer than two columns). */
export function roleColumn(sql: SqlStorage, role: "starting" | "completed"): string | undefined {
  return sql.exec<{ id: string }>(`SELECT id FROM columns WHERE ${role} = 1 LIMIT 1`).toArray()[0]?.id;
}

/** An active card is done exactly when it sits in the completed column (ADR 0067). */
export function isCompleted(sql: SqlStorage, columnId: string): boolean {
  return sql.exec<{ completed: number }>("SELECT completed FROM columns WHERE id = ?", columnId).toArray()[0]?.completed === 1;
}

/**
 * ADR 0059: `card.finish` is accepted only against the family the client reviewed.
 * The parent's placement, every active descendant's placement and parentage, and
 * the exact set of children to move (every open one, or none) must all match.
 */
export function checkFinish(sql: SqlStorage, message: Extract<ClientMessage, { type: "card.finish" }>): void {
  if (!isCompleted(sql, message.columnId)) throw new Error("Completed status changed. Review the move again.");
  const cards = placements(sql, "active");
  const parent = cards.find(card => card.id === message.id);
  if (!parent || parent.columnId !== message.expectedParentColumnId || parent.position !== message.expectedParentPosition) throw new Error("Parent changed. Review the move again.");
  const family = familyCompletionRows(cards, relations(sql), message.id);
  if (JSON.stringify(family) !== JSON.stringify([...message.expectedFamily].sort((a,b) => a.id.localeCompare(b.id)))) throw new Error("Subtasks changed. Review the completion choices again.");
  const open = family.filter(card => !isCompleted(sql, card.columnId));
  const childIds = message.children.map(card => card.id).sort();
  const expected = message.scope === "family" ? open.map(card => card.id).sort() : [];
  if (new Set(childIds).size !== childIds.length || JSON.stringify(childIds) !== JSON.stringify(expected)) throw new Error("Review every unfinished subtask before finishing the family.");
}

/**
 * Where MCP `complete_subtask` sends a card. Completion is the child's own column
 * and it needs a live parent: a root has no subtask state, and an archived parent
 * leaves the link inactive.
 */
export function completionFor(sql: SqlStorage, cardId: string, done: boolean): string {
  if (!loadFamily(sql, "active").parentByChild.has(cardId)) {
    throw new MutationRefusal("subtask_unavailable", "Subtask is unavailable.");
  }
  const destination = roleColumn(sql, done ? "completed" : "starting");
  if (destination === undefined) throw new MutationRefusal("column_not_found", "The board has no starting and completed columns yet.");
  return destination;
}

/** `subtask.create` needs an active parent that is not itself a subtask: families are one level. */
export function checkSubtaskParent(sql: SqlStorage, parentId: string): void {
  const parent = sql
    .exec<{ archivedAt: number | null; taskType: Card["taskType"] }>(
      "SELECT archived_at AS archivedAt, task_type AS taskType FROM cards WHERE id = ?",
      parentId,
    )
    .toArray()[0];
  if (!parent || parent.archivedAt !== null) {
    throw new Error("Parent task is unavailable.");
  }
  if (parent.taskType === "subtask") {
    throw new Error("Subtasks cannot have subtasks.");
  }
}

/**
 * A new child never takes a column from the client. It starts in the starting
 * column, or in the completed one when a done checklist item became it; a board
 * without roles has no such column, so it joins its parent's.
 */
export function placementFor(sql: SqlStorage, parentId: string, done: boolean): string {
  return (
    roleColumn(sql, done ? "completed" : "starting") ??
    sql.exec<{ columnId: string }>("SELECT column_id AS columnId FROM cards WHERE id = ?", parentId).toArray()[0]!.columnId
  );
}

/**
 * Boards written before this validation can hold anything; new subtask links may
 * not. Endpoints must be live cards, the parent no subtask, the child may claim
 * only one parent — including a retained link to an archived one — the pair cannot
 * repeat, and walking up from the new parent must never reach the child. Every
 * structural refusal is the same error, so the client reads it as "this link is
 * impossible", not as a specific guess.
 */
export function checkSubtaskLink(sql: SqlStorage, sourceCardId: string, targetCardId: string): void {
  const endpoints = sql
    .exec<{ id: string; archivedAt: number | null; taskType: Card["taskType"] }>(
      `SELECT id, archived_at AS archivedAt, task_type AS taskType
         FROM cards WHERE id IN (?, ?)`,
      sourceCardId,
      targetCardId,
    )
    .toArray();
  const source = endpoints.find((row) => row.id === sourceCardId);
  const target = endpoints.find((row) => row.id === targetCardId);
  const stored = sql
    .exec<{ sourceCardId: string; targetCardId: string }>(
      `SELECT source_card_id AS sourceCardId, target_card_id AS targetCardId
         FROM card_relations
        WHERE kind = 'subtask'`,
    )
    .toArray();
  // Reachability across EVERY stored parent edge: a legacy board may hold
  // several edges into the same child, and keeping only one of them would
  // accept a cycle that runs through a discarded edge. The visited set keeps
  // a malformed cycle from spinning the walk.
  const parentsByChild = new Map<string, string[]>();
  for (const row of stored) {
    const parents = parentsByChild.get(row.targetCardId) ?? [];
    parents.push(row.sourceCardId);
    parentsByChild.set(row.targetCardId, parents);
  }
  const visited = new Set<string>();
  const pending = [sourceCardId];
  let reachesChild = false;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node === targetCardId) {
      reachesChild = true;
      break;
    }
    if (visited.has(node)) continue;
    visited.add(node);
    for (const parent of parentsByChild.get(node) ?? []) pending.push(parent);
  }

  const invalid =
    !source ||
    !target ||
    source.archivedAt !== null ||
    target.archivedAt !== null ||
    source.taskType === "subtask" ||
    stored.some((row) => row.sourceCardId === targetCardId) ||
    sourceCardId === targetCardId ||
    stored.some(
      (row) =>
        row.targetCardId === targetCardId ||
        (row.sourceCardId === sourceCardId && row.targetCardId === targetCardId),
    ) ||
    reachesChild;
  if (invalid) throw new Error("Invalid subtask hierarchy.");
}
