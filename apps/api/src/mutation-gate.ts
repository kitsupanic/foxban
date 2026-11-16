/**
 * The mutation gate: decides whether a ClientMessage is refused before `apply`
 * runs. One exhaustive map says which cards a message touches; the gate then
 * applies the archived and transfer-lock fences to them, so a new message type
 * cannot ship without saying what it touches (the switch stops compiling).
 *
 * Plain functions over `SqlStorage`: no Durable Object state, no I/O but reads.
 */
import type { ClientMessage } from "@foxban/shared";
import type { McpError } from "./mcp-contract";

export class MutationRefusal extends Error {
  constructor(
    readonly code: McpError["code"],
    message: string,
    readonly closeCode?: number,
  ) {
    super(message);
  }
}

export type MutationContext = {
  actorId: string;
  boardId: string | null;
  canManageColumns: unknown;
};

export function isCardArchived(sql: SqlStorage, cardId: string): boolean {
  return sql
    .exec<{ id: string }>("SELECT id FROM cards WHERE id = ? AND archived_at IS NOT NULL", cardId)
    .toArray().length > 0;
}

export function isCardLocked(sql: SqlStorage, cardId: string): boolean {
  return sql
    .exec<{ card_id: string }>("SELECT card_id FROM card_transfer_locks WHERE card_id = ?", cardId)
    .toArray().length > 0;
}

type Touched = {
  /** Cards whose own content the mutation changes: refused when archived or locked. */
  written: string[];
  /** Cards changed only as a side effect: refused when locked. "board" is every card. */
  swept: string[] | "board";
};

const NONE: Touched = { written: [], swept: [] };
const writes = (...ids: string[]): Touched => ({ written: ids, swept: [] });

/** The card a child row belongs to; a missing row touches nothing. */
function ownerOf(sql: SqlStorage, table: "checklist_items" | "attachments" | "comments" | "card_labels", id: string): string[] {
  return sql
    .exec<{ cardId: string }>(`SELECT card_id AS cardId FROM ${table} WHERE id = ?`, id)
    .toArray().map((row) => row.cardId);
}

function touchedCards(sql: SqlStorage, message: ClientMessage): Touched {
  switch (message.type) {
    case "column.create":
    case "column.rename":
    case "column.move":
    case "card.create":
    case "card.restore":
    case "card.purge":
    case "label.create":
      return NONE;

    case "workflow.configure":
      return { written: [], swept: "board" };

    case "column.delete":
      // Every active card in this column leaves with it.
      return {
        written: [],
        swept: sql
          .exec<{ id: string }>("SELECT id FROM cards WHERE column_id = ? AND archived_at IS NULL", message.id)
          .toArray().map((row) => row.id),
      };

    case "label.update":
    case "label.delete":
      return {
        written: [],
        swept: sql
          .exec<{ id: string }>(
            `SELECT cards.id AS id FROM card_labels
               JOIN cards ON cards.id = card_labels.card_id
              WHERE card_labels.label_id = ? AND cards.archived_at IS NULL`,
            message.id,
          )
          .toArray().map((row) => row.id),
      };

    case "card.update":
    case "card.move":
    case "card.delete":
    case "card.assign":
    case "card.prioritize":
    case "card.retype":
    case "card.schedule":
      return writes(message.id);

    case "card.finish":
      return writes(message.id, ...message.children.map((child) => child.id));

    // Creation owns its archived refusal: it names exactly what is unavailable
    // ("Parent task is unavailable."), which the generic read-only answer would
    // only blur. It still refuses the write — `apply` validates the live parent —
    // and the transfer fence still covers it.
    case "subtask.create":
      return { written: [], swept: [message.parentCardId] };

    case "checklist.create":
    case "attachment.create":
    case "comment.create":
    case "label.assign":
      return writes(message.cardId);

    case "checklist.update":
    case "checklist.delete":
      return writes(...ownerOf(sql, "checklist_items", message.id));
    case "attachment.delete":
      return writes(...ownerOf(sql, "attachments", message.id));
    case "comment.update":
    case "comment.delete":
      return writes(...ownerOf(sql, "comments", message.id));
    case "label.unassign":
      return writes(...ownerOf(sql, "card_labels", message.id));

    case "relation.create":
      return writes(message.sourceCardId, message.targetCardId);
    case "relation.delete":
      return writes(
        ...sql
          .exec<{ a: string; b: string }>(
            "SELECT source_card_id AS a, target_card_id AS b FROM card_relations WHERE id = ?",
            message.id,
          )
          .toArray().flatMap((row) => [row.a, row.b]),
      );
  }
}

function refuseIfBlocked(sql: SqlStorage, touched: Touched): void {
  if (touched.written.some((id) => isCardArchived(sql, id))) {
    throw new MutationRefusal("task_archived", "archived cards are read-only");
  }
  const locked =
    touched.swept === "board"
      ? sql.exec("SELECT card_id FROM card_transfer_locks LIMIT 1").toArray().length > 0
      : [...touched.written, ...touched.swept].some((id) => isCardLocked(sql, id));
  if (locked) throw new MutationRefusal("transfer_conflict", "card transfer in progress");
}

/**
 * The card-level fences for a command that may turn out to be a no-op (and so
 * sends no message), checked against the one card it names.
 */
export function checkCardWritable(sql: SqlStorage, cardId: string): void {
  refuseIfBlocked(sql, writes(cardId));
}

/** Throws MutationRefusal when `message` must not reach `apply`. */
export function checkMutation(sql: SqlStorage, message: ClientMessage, context: MutationContext): void {
  switch (message.type) {
    case "workflow.configure":
    case "column.create":
    case "column.rename":
    case "column.move":
    case "column.delete":
      if (context.canManageColumns !== true) {
        const legacy = typeof context.canManageColumns !== "boolean";
        throw new MutationRefusal(
          "forbidden",
          legacy ? "Reconnect to change board columns." : "Only the board owner or an admin can change columns.",
          legacy ? 1012 : undefined,
        );
      }
      break;
  }
  refuseIfBlocked(sql, touchedCards(sql, message));
  if (
    message.type === "attachment.delete" &&
    context.boardId === null &&
    sql.exec<{ id: string }>(
      `SELECT cards.id FROM attachments
         JOIN cards ON cards.id = attachments.card_id
        WHERE attachments.id = ? AND cards.archived_at IS NULL`,
      message.id,
    ).toArray().length > 0
  ) {
    throw new MutationRefusal("forbidden", "Reconnect to delete attachments.", 1012);
  }
}
