/**
 * The board's mutation pipeline: gate, derive activities, apply, record them.
 * Plain functions over the board's `SqlStorage`: no Durable Object state and no
 * I/O but SQL, so the BoardDO imports this and never the other way round.
 */
import { generateNKeysBetween } from "fractional-indexing";
import {
  removeAttachmentReferences,
  type Activity,
  type ArchivedCard,
  type Card,
  type ClientMessage,
  type PositionsRebalanced,
  type Comment,
} from "@foxban/shared";
import { activityDrafts, insertActivities } from "./activity";
import { attachmentObjectKey } from "./attachment-lifecycle";
import { checkMutation, type MutationContext } from "./mutation-gate";
import {
  checkFinish,
  checkSubtaskLink,
  checkSubtaskParent,
  isCompleted,
  placementFor,
} from "./subtask-family";

/** The development pull requests and branches a delete held: what the caller settles once its transaction commits. */
export type HeldRoutes = {
  pullRequests: { repositoryId: number; number: number }[];
  branches: { repositoryId: number; name: string }[];
};

/** SQLite has no boolean type: `subtask_done` reads back as 0/1, so a SELECT declares this row shape and maps it. */
export type ArchivedCardRow = Omit<ArchivedCard, "subtaskDone"> & { subtaskDone: number };

/** The one SELECT that reads an `ArchivedCardRow`; callers append their own WHERE. */
export const ARCHIVED_CARD_SELECT = `SELECT id, column_id AS columnId, title, description, position,
       task_number AS taskNumber, subtask_done AS subtaskDone,
       assignee_id AS assigneeId, priority, task_type AS taskType, due_date AS dueDate,
       created_at AS createdAt, updated_at AS updatedAt,
       archived_at AS archivedAt, archived_column_title AS archivedColumnTitle
  FROM cards`;

type MutationOutcome = {
  activities: Activity[];
  archivedCards: ArchivedCard[];
  purgedCardIds: string[];
  numberedCard?: { id: string; taskNumber: number };
  /** What a purge held; empty for every other mutation. */
  heldRoutes: HeldRoutes;
  /** The new keys when the mutation's list was rewritten (ADR 0076): the verbatim frame alone leaves peers with the old ones. */
  rebalanced: PositionsRebalanced | null;
};

type ApplyResult = {
  archivedCards: ArchivedCard[];
  purgedCardIds: string[];
  numberedCard?: { id: string; taskNumber: number };
  /**
   * Set when the mutation was an idempotent replay that wrote nothing: the
   * activity drafts were derived from the same pre-state, so inserting them
   * would duplicate history the first accept already recorded.
   */
  skipActivities?: boolean;
  heldRoutes?: HeldRoutes;
};

const NO_LIFECYCLE_CHANGES: ApplyResult = { archivedCards: [], purgedCardIds: [] };

/**
 * ADR 0076: dropping again and again into one gap lengthens its key until the
 * wire's 64-character bound refuses every further drop there. A mutation that
 * writes a key longer than this has its whole list rewritten with short keys.
 */
export const REBALANCE_KEY_LENGTH = 40;

/** The list a mutation's position keys landed in, and the keys it wrote there; null when it wrote none. */
function keyedList(message: ClientMessage): { table: "cards" | "columns"; where: string; args: string[]; written: string[]; id: string } | null {
  const inColumn = (columnId: string, written: string[], id: string) => ({ table: "cards" as const, where: "column_id = ? AND archived_at IS NULL", args: [columnId], written, id });
  switch (message.type) {
    case "card.create":
    case "card.move":
    case "card.restore":
      return inColumn(message.columnId, [message.position], message.id);
    case "card.finish":
      return inColumn(message.columnId, [message.position, ...message.children.map((child) => child.position)], message.id);
    case "column.create":
    case "column.move":
      return { table: "columns", where: "1", args: [], written: [message.position], id: message.id };
    default:
      return null;
  }
}

/**
 * Rewrites the active cards of the column (or the columns of the board) the
 * mutation just wrote a long key into, in the order they already have and with
 * evenly spaced keys. Archived cards keep theirs: restore brings its own.
 * Returns the rewritten keys for the frame that tells peers, or null when it wrote none.
 */
function rebalanceLongKeys(sql: SqlStorage, message: ClientMessage): PositionsRebalanced | null {
  const list = keyedList(message);
  if (!list?.written.some((key) => key.length > REBALANCE_KEY_LENGTH)) return null;
  const rows = sql.exec<{ id: string }>(`SELECT id FROM ${list.table} WHERE ${list.where} ORDER BY position, id`, ...list.args).toArray();
  if (!rows.some((row) => row.id === list.id)) return null; // a stale move of a card or column that is gone wrote nothing
  const keys = generateNKeysBetween(null, null, rows.length);
  const positions = rows.map((row, index) => ({ id: row.id, position: keys[index]! }));
  for (const { id, position } of positions) sql.exec(`UPDATE ${list.table} SET position = ? WHERE id = ?`, position, id);
  return { type: "positions.rebalanced", table: list.table, positions };
}

/**
 * Runs one mutation: the gate, then the activity drafts, then the write, then the
 * activities (skipped for an idempotent replay). Call it inside the caller's
 * transaction: a throw, a refusal included, means the caller's transaction rolls
 * back, so nothing it wrote survives.
 */
export function runMutation(
  sql: SqlStorage,
  message: ClientMessage,
  context: MutationContext,
  now: number,
): MutationOutcome {
  checkMutation(sql, message, context, now);
  const drafts = activityDrafts(sql, message);
  const { skipActivities, heldRoutes, ...changes } = apply(sql, message, now, context.boardId);
  return {
    activities: skipActivities ? [] : insertActivities(sql, drafts, context.actorId, now),
    heldRoutes: heldRoutes ?? { pullRequests: [], branches: [] },
    rebalanced: rebalanceLongKeys(sql, message),
    ...changes,
  };
}

/** One card's comments, tombstones included, oldest first: the card modal's read (ADR 0078) and the transfer bundle's. */
export function readCardComments(sql: SqlStorage, cardId: string): Comment[] {
  return sql
    .exec<Omit<Comment, "deleted"> & { deleted: number }>(
      `SELECT id, card_id AS cardId, author_id AS authorId,
              parent_comment_id AS parentCommentId, deleted, body,
              created_at AS createdAt, updated_at AS updatedAt
         FROM comments
        WHERE card_id = ?
        ORDER BY created_at, id`,
      cardId,
    )
    .toArray()
    .map((c) => ({ ...c, deleted: c.deleted === 1 }));
}

/** The comment `update` / `delete` names must be on the card the frame names: peers route the broadcast by it (ADR 0078). */
function requireCommentOnCard(sql: SqlStorage, id: string, cardId: string): { parent_comment_id: string | null; deleted: number } | undefined {
  const row = sql
    .exec<{ card_id: string; parent_comment_id: string | null; deleted: number }>(
      "SELECT card_id, parent_comment_id, deleted FROM comments WHERE id = ?",
      id,
    )
    .toArray()[0];
  if (row && row.card_id !== cardId) throw new Error("Comment is not on that card.");
  return row;
}

/** True for the mutations that may enqueue cleanup keys or create an archive deadline, so the caller schedules the lifecycle alarm before the write. */
export function createsLifecycleWork(message: ClientMessage): boolean {
  return (
    message.type === "attachment.delete" ||
    message.type === "card.delete" ||
    message.type === "card.purge" ||
    message.type === "column.delete"
  );
}

/** Deletes these cards and everything they own, and returns the pull requests and branches they held for the caller to settle. */
export function deleteCards(sql: SqlStorage, cardIds: readonly string[]): HeldRoutes {
  if (cardIds.length === 0) return { pullRequests: [], branches: [] };
  const PURGE_CARD_CHUNK_SIZE = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < cardIds.length; i += PURGE_CARD_CHUNK_SIZE) {
    chunks.push(cardIds.slice(i, i + PURGE_CARD_CHUNK_SIZE));
  }

  for (const chunk of chunks) {
    const placeholders = chunk.map(() => "?").join(", ");
    sql.exec(`UPDATE cards SET task_type = 'task' WHERE id IN (SELECT target_card_id FROM card_relations WHERE kind = 'subtask' AND source_card_id IN (${placeholders}))`, ...chunk);
    sql.exec(
      `DELETE FROM card_relations
        WHERE source_card_id IN (${placeholders})
           OR target_card_id IN (${placeholders})`,
      ...chunk,
      ...chunk,
    );
  }

  // The pull requests and branches these cards hold, so the webhook router can drop the
  // pointers this board no longer needs.
  const heldPullRequests = chunks.flatMap((chunk) =>
    sql
      .exec<{ repositoryId: number; number: number }>(
        `SELECT DISTINCT repository_id AS repositoryId, number FROM card_development_pull_requests
          WHERE card_id IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      )
      .toArray(),
  );
  const heldBranches = chunks.flatMap((chunk) =>
    sql
      .exec<{ repositoryId: number; name: string }>(
        `SELECT DISTINCT repository_id AS repositoryId, name FROM card_development_branches
          WHERE card_id IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      )
      .toArray(),
  );

  const deleteChunks = (table: string, column = "card_id") => {
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(", ");
      sql.exec(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, ...chunk);
    }
  };

  deleteChunks("activities");
  deleteChunks("comments");
  deleteChunks("attachments");
  deleteChunks("checklist_items");
  deleteChunks("card_labels");
  deleteChunks("card_github_pull_requests");
  deleteChunks("card_development_pull_requests");
  deleteChunks("card_development_unlinks");
  deleteChunks("card_development_branches");
  deleteChunks("cards", "id");
  return { pullRequests: heldPullRequests, branches: heldBranches };
}

export function setWorkflowRoles(sql: SqlStorage, startingId: string, completedId: string): void {
  sql.exec(
    "UPDATE columns SET starting = CASE WHEN id = ? THEN 1 ELSE 0 END, completed = CASE WHEN id = ? THEN 1 ELSE 0 END",
    startingId,
    completedId,
  );
}

/** The leftmost and rightmost columns by position; a board needs two to have them. Names carry no meaning. */
export function endColumns(sql: SqlStorage): { starting: string; completed: string } | undefined {
  const columns = sql.exec<{ id: string }>("SELECT id FROM columns ORDER BY position, id").toArray();
  return columns.length < 2 ? undefined : { starting: columns[0]!.id, completed: columns.at(-1)!.id };
}

const ROLES_EXPLICIT_KEY = "workflow_roles_explicit";

/** True once an admin chose the roles (or the board held real data when roles first came); from then on they never drift. */
export function rolesExplicit(sql: SqlStorage): boolean {
  return sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = ?", ROLES_EXPLICIT_KEY).toArray()[0]?.value === 1;
}

export function markRolesExplicit(sql: SqlStorage): void {
  sql.exec(
    "INSERT INTO meta(key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = 1",
    ROLES_EXPLICIT_KEY,
  );
}

/**
 * Until an admin chooses, the roles follow the board's ends: leftmost starting,
 * rightmost completed, and none below two columns. Run after anything that adds,
 * removes or reorders a column. Moves no card: completion is derived from the column.
 */
function syncAutoRoles(sql: SqlStorage): void {
  if (rolesExplicit(sql)) return;
  const ends = endColumns(sql);
  if (ends) setWorkflowRoles(sql, ends.starting, ends.completed);
  else sql.exec("UPDATE columns SET starting = 0, completed = 0");
}

/** Reads, consumes and increments the board's monotonic task number. */
export function allocateTaskNumber(sql: SqlStorage): number {
  let nextNumberRow = sql
    .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_task_number'")
    .toArray()[0];
  if (!nextNumberRow) {
    const maxRow = sql
      .exec<{ maxNum: number | null }>("SELECT MAX(task_number) AS maxNum FROM cards")
      .toArray()[0];
    const initialNext = (maxRow?.maxNum ?? 0) + 1;
    sql.exec("INSERT INTO meta(key, value) VALUES ('next_task_number', ?)", initialNext);
    nextNumberRow = { value: initialNext };
  }
  const taskNumber = nextNumberRow.value;
  sql.exec("UPDATE meta SET value = ? WHERE key = 'next_task_number'", taskNumber + 1);
  return taskNumber;
}

/**
 * Inserts one active card row and returns its allocated task number. Every
 * creation path (the create dialog, subtask, checklist conversion) goes
 * through here, so there is exactly one counter. Type, priority and assignee
 * are the creation draft's own values; an omitted one takes the same default
 * a card has always been created with.
 */
function insertCard(
  sql: SqlStorage,
  card: {
    id: string;
    columnId: string;
    title: string;
    position: string;
    subtaskDone?: boolean;
    taskType?: Card["taskType"];
    priority?: Card["priority"];
    assigneeId?: string | null;
  },
  now: number,
): number {
  const taskNumber = allocateTaskNumber(sql);
  sql.exec(
    `INSERT INTO cards(id, column_id, title, description, position, task_number,
                       subtask_done, task_type, priority, assignee_id, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
    card.id,
    card.columnId,
    card.title,
    card.position,
    taskNumber,
    card.subtaskDone ? 1 : 0,
    card.taskType ?? "task",
    card.priority ?? "medium",
    card.assigneeId ?? null,
    now,
    now,
  );
  return taskNumber;
}

/**
 * A child row needs a live card to belong to. The gate refuses archived and locked
 * cards but lets a missing one through (a card a transfer finalized away): there are
 * no foreign keys, so the write would commit an orphan. Throwing rolls it back.
 */
function requireLiveCard(sql: SqlStorage, cardId: string, message = "card is unavailable"): void {
  if (!sql.exec("SELECT 1 FROM cards WHERE id = ? AND archived_at IS NULL", cardId).toArray()[0]) {
    throw new Error(message);
  }
}

/**
 * Applies mutations to SQLite. Card creation transactionally reads, assigns,
 * and increments the monotonic task_number counter alongside row creation.
 * Deletes cascade their dependent rows by hand. An UPDATE or DELETE matching
 * no rows is a silent no-op — e.g. moving a card whose column was just deleted.
 * That is the last-write-wins outcome we want, not an error.
 */
function apply(sql: SqlStorage, message: ClientMessage, now: number, boardId: string | null): ApplyResult {
  switch (message.type) {
    case "card.finish": {
      checkFinish(sql, message);
      // executeMutation owns the surrounding SQLite transaction: no partial
      // family movement, activity insertion, or broadcast can escape a refusal.
      for (const move of [{ id: message.id, position: message.position }, ...message.children]) {
        sql.exec("UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", message.columnId, move.position, now, move.id);
      }
      return NO_LIFECYCLE_CHANGES;
    }
    case "workflow.configure": {
      const configured = sql.exec<{ id: string; starting: number; completed: number }>("SELECT id, starting, completed FROM columns").toArray();
      if ((configured.find(c => c.starting)?.id ?? null) !== message.expectedStartingColumnId || (configured.find(c => c.completed)?.id ?? null) !== message.expectedCompletedColumnId) throw new Error("Workflow changed. Review the configuration again.");
      if (message.startingColumnId === message.completedColumnId || ![message.startingColumnId, message.completedColumnId].every(id => configured.some(c => c.id === id))) throw new Error("Choose distinct existing starting and completed columns.");
      setWorkflowRoles(sql, message.startingColumnId, message.completedColumnId);
      // An admin chose: the roles stay put from here on.
      markRolesExplicit(sql);
      return NO_LIFECYCLE_CHANGES;
    }
    case "column.create": {
      sql.exec(
        "INSERT INTO columns(id, title, position) VALUES (?, ?, ?)",
        message.id,
        message.title,
        message.position,
      );
      // Until an admin chooses, the roles follow the board's ends. The web reducer
      // applies the same rule, so peers see them without a snapshot.
      syncAutoRoles(sql);
      return NO_LIFECYCLE_CHANGES;
    }
    case "column.rename":
      sql.exec("UPDATE columns SET title = ? WHERE id = ?", message.title, message.id);
      return NO_LIFECYCLE_CHANGES;
    case "column.move":
      sql.exec("UPDATE columns SET position = ? WHERE id = ?", message.position, message.id);
      syncAutoRoles(sql);
      return NO_LIFECYCLE_CHANGES;
    case "column.delete": {
      // Roles an admin chose need replacements first; automatic ones follow the ends.
      if (rolesExplicit(sql) && sql.exec("SELECT id FROM columns WHERE id = ? AND (starting = 1 OR completed = 1)", message.id).toArray().length) throw new Error("Choose replacement workflow columns before deleting this column.");
      const column = sql
        .exec<{ title: string }>("SELECT title FROM columns WHERE id = ?", message.id)
        .toArray()[0];
      if (!column) {
        sql.exec("DELETE FROM columns WHERE id = ?", message.id);
        syncAutoRoles(sql);
        return NO_LIFECYCLE_CHANGES;
      }

      // Archived completion is frozen as history, so the derived value is
      // stored before the cards leave with their column.
      sql.exec("UPDATE cards SET subtask_done = ? WHERE column_id = ? AND archived_at IS NULL", isCompleted(sql, message.id) ? 1 : 0, message.id);
      sql.exec(
        `UPDATE cards
            SET archived_at = ?, archived_column_title = ?
          WHERE column_id = ? AND archived_at IS NULL`,
        now,
        column.title,
        message.id,
      );

      const archivedCards = sql
        .exec<ArchivedCardRow>(`${ARCHIVED_CARD_SELECT} WHERE column_id = ? AND archived_at = ?`, message.id, now)
        .toArray()
        .map((row) => ({ ...row, subtaskDone: isCompleted(sql, row.columnId) }));

      sql.exec("DELETE FROM columns WHERE id = ?", message.id);
      syncAutoRoles(sql);
      return { archivedCards, purgedCardIds: [] };
    }
    case "card.create": {
      const column = sql
        .exec<{ id: string }>("SELECT id FROM columns WHERE id = ?", message.columnId)
        .toArray()[0];
      if (!column) {
        throw new Error("destination column does not exist");
      }
      const taskNumber = insertCard(
        sql,
        {
          id: message.id,
          columnId: message.columnId,
          title: message.title,
          position: message.position,
          taskType: message.taskType,
          priority: message.priority,
          assigneeId: message.assigneeId,
        },
        now,
      );
      return { archivedCards: [], purgedCardIds: [], numberedCard: { id: message.id, taskNumber } };
    }
    case "card.update":
      sql.exec(
        `UPDATE cards
         SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ?
         WHERE id = ?`,
        message.title ?? null,
        message.description ?? null,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "card.move": {
      const card = sql
        .exec<{ id: string }>("SELECT id FROM cards WHERE id = ? AND archived_at IS NULL", message.id)
        .toArray()[0];
      if (card) {
        const column = sql
          .exec<{ id: string }>("SELECT id FROM columns WHERE id = ?", message.columnId)
          .toArray()[0];
        if (!column) {
          throw new Error("destination column does not exist");
        }
      }
      sql.exec(
        "UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?",
        message.columnId,
        message.position,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    }
    case "card.assign":
      sql.exec(
        "UPDATE cards SET assignee_id = ?, updated_at = ? WHERE id = ?",
        message.assigneeId,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "card.prioritize":
      sql.exec(
        "UPDATE cards SET priority = ?, updated_at = ? WHERE id = ?",
        message.priority,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "card.retype": {
      const target = sql
        .exec<{ taskType: Card["taskType"] }>(
          "SELECT task_type AS taskType FROM cards WHERE id = ? AND archived_at IS NULL",
          message.id,
        )
        .toArray()[0];
      if (target?.taskType === "subtask") {
        throw new Error("Subtask type cannot be changed.");
      }
      sql.exec(
        "UPDATE cards SET task_type = ?, updated_at = ? WHERE id = ?",
        message.taskType,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    }
    case "card.schedule":
      sql.exec(
        "UPDATE cards SET due_date = ?, updated_at = ? WHERE id = ?",
        message.dueDate,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "card.delete": {
      // Archive is per card: children stay in their own columns, and the links
      // remain for restore/purge.
      const target = sql
        .exec<{ columnId: string }>(
          "SELECT column_id AS columnId FROM cards WHERE id = ? AND archived_at IS NULL",
          message.id,
        )
        .toArray()[0];
      if (target === undefined) return NO_LIFECYCLE_CHANGES;
      const column = sql
        .exec<{ title: string }>("SELECT title FROM columns WHERE id = ?", target.columnId)
        .toArray()[0];
      sql.exec(
        "UPDATE cards SET subtask_done = ?, archived_at = ?, archived_column_title = ? WHERE id = ?",
        isCompleted(sql, target.columnId) ? 1 : 0,
        now,
        column?.title ?? "(deleted column)",
        message.id,
      );
      const archivedCards = sql
        .exec<ArchivedCardRow>(`${ARCHIVED_CARD_SELECT} WHERE id = ?`, message.id)
        .toArray()
        .map((row) => ({ ...row, subtaskDone: row.subtaskDone === 1 }));
      return { archivedCards, purgedCardIds: [] };
    }
    case "card.purge": {
      const archived = sql
        .exec<{ id: string }>(
          "SELECT id FROM cards WHERE id = ? AND archived_at IS NOT NULL",
          message.id,
        )
        .toArray()[0];
      if (!archived) return NO_LIFECYCLE_CHANGES;
      const heldRoutes = deleteCards(sql, [message.id]);
      return { archivedCards: [], purgedCardIds: [message.id], heldRoutes };
    }
    case "card.restore": {
      const card = sql
        .exec<{ id: string }>(
          "SELECT id FROM cards WHERE id = ? AND archived_at IS NOT NULL",
          message.id,
        )
        .toArray()[0];
      if (!card) {
        throw new Error("archived card or destination column no longer exists");
      }

      const destination = sql
        .exec<{ id: string }>("SELECT id FROM columns WHERE id = ?", message.columnId)
        .toArray()[0];
      if (!destination) {
        throw new Error("archived card or destination column no longer exists");
      }

      sql.exec(
        `UPDATE cards
            SET column_id = ?, position = ?, updated_at = ?,
                archived_at = NULL, archived_column_title = NULL
          WHERE id = ?`,
        message.columnId,
        message.position,
        now,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    }
    case "checklist.create":
      requireLiveCard(sql, message.cardId);
      sql.exec(
        "INSERT INTO checklist_items(id, card_id, text, done, position) VALUES (?, ?, ?, 0, ?)",
        message.id,
        message.cardId,
        message.text,
        message.position,
      );
      return NO_LIFECYCLE_CHANGES;
    case "checklist.update":
      sql.exec(
        "UPDATE checklist_items SET text = COALESCE(?, text), done = COALESCE(?, done) WHERE id = ?",
        message.text ?? null,
        message.done === undefined ? null : message.done ? 1 : 0,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "checklist.delete":
      sql.exec("DELETE FROM checklist_items WHERE id = ?", message.id);
      return NO_LIFECYCLE_CHANGES;
    case "attachment.create": {
      const effectiveBoardId =
        boardId ??
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'").toArray()[0]?.value;
      if (!effectiveBoardId) {
        throw new Error("board identity unknown");
      }
      const expectedKey = attachmentObjectKey(effectiveBoardId, message.id);
      const lease = sql
        .exec<{ object_key: string; delete_after: number; claim_token: string | null; reason: string; deleted_at: number | null }>(
          "SELECT object_key, delete_after, claim_token, reason, deleted_at FROM attachment_cleanup WHERE object_key = ?",
          expectedKey,
        )
        .toArray()[0];

      if (
        !lease ||
        lease.reason !== "staged" ||
        lease.delete_after <= now ||
        lease.claim_token !== null ||
        lease.deleted_at !== null
      ) {
        throw new Error("attachment staging lease is expired, claimed, or missing");
      }

      // A purged or archived card cannot own a new attachment: refusing here rolls
      // the whole mutation back, so the lease survives and expires into the collector.
      requireLiveCard(sql, message.cardId, "attachment card is unavailable");

      sql.exec(
        "DELETE FROM attachment_cleanup WHERE object_key = ? AND reason = 'staged' AND claim_token IS NULL AND deleted_at IS NULL",
        expectedKey,
      );

      sql.exec(
        "INSERT INTO attachments(id, card_id, file_name, content_type, size, object_key) VALUES (?, ?, ?, ?, ?, ?)",
        message.id,
        message.cardId,
        message.fileName,
        message.contentType,
        message.size,
        expectedKey,
      );
      return NO_LIFECYCLE_CHANGES;
    }
    case "attachment.delete": {
      const owner = sql
        .exec<{ id: string; description: string }>(
          `SELECT cards.id, cards.description FROM attachments
           JOIN cards ON cards.id = attachments.card_id
           WHERE attachments.id = ? AND cards.archived_at IS NULL`,
          message.id,
        )
        .toArray()[0];
      if (owner) {
        // checkMutation (the only way here) already refused a board-less delete of a live card's attachment.
        const description = removeAttachmentReferences(
          owner.description,
          boardId!,
          message.id,
        );
        if (description !== owner.description) {
          sql.exec(
            "UPDATE cards SET description = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
            description,
            now,
            owner.id,
          );
        }
      }
      // The v9 delete trigger durably queues the R2 object in the same SQLite
      // statement; archived-card retention purges pass through it too.
      sql.exec("DELETE FROM attachments WHERE id = ?", message.id);
      return NO_LIFECYCLE_CHANGES;
    }
    // The wire's author and timestamps are kept for compatibility (ADR 0015);
    // the gate holds them to the socket's user and the board's clock (ADR 0074, 0077).
    case "comment.create": {
      requireLiveCard(sql, message.cardId);
      if (message.parentCommentId !== null) {
        const parent = sql
          .exec<{ card_id: string; parent_comment_id: string | null }>(
            "SELECT card_id, parent_comment_id FROM comments WHERE id = ?",
            message.parentCommentId,
          )
          .toArray()[0];
        if (!parent || parent.card_id !== message.cardId || parent.parent_comment_id !== null) {
          throw new Error("Reply target is unavailable.");
        }
      }
      sql.exec(
        `INSERT INTO comments(id, card_id, author_id, parent_comment_id, deleted, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        message.id,
        message.cardId,
        message.authorId,
        message.parentCommentId,
        message.body,
        message.createdAt,
        message.createdAt,
      );
      return NO_LIFECYCLE_CHANGES;
    }
    case "comment.update":
      requireCommentOnCard(sql, message.id, message.cardId);
      sql.exec(
        "UPDATE comments SET body = ?, updated_at = ? WHERE id = ? AND deleted = 0",
        message.body,
        message.updatedAt,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "comment.delete": {
      const row = requireCommentOnCard(sql, message.id, message.cardId);
      // Refused, not a no-op, so every broadcast delete removes exactly one active comment and peers can count by it (ADR 0078).
      if (!row || row.deleted === 1) throw new Error("Comment is already deleted.");
      const target = { id: message.id, parent_comment_id: row.parent_comment_id };

      if (target.parent_comment_id === null) {
        // Root comment
        const replyCount = sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM comments WHERE parent_comment_id = ?",
            target.id,
          )
          .toArray()[0]?.count ?? 0;

        if (replyCount > 0) {
          sql.exec("UPDATE comments SET body = '', deleted = 1 WHERE id = ?", target.id);
        } else {
          sql.exec("DELETE FROM comments WHERE id = ?", target.id);
        }
      } else {
        // Reply
        sql.exec("DELETE FROM comments WHERE id = ?", target.id);
        const parentId = target.parent_comment_id;
        const parent = sql
          .exec<{ id: string; deleted: number }>(
            "SELECT id, deleted FROM comments WHERE id = ?",
            parentId,
          )
          .toArray()[0];
        if (parent && parent.deleted === 1) {
          const remainingReplies = sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM comments WHERE parent_comment_id = ?",
              parentId,
            )
            .toArray()[0]?.count ?? 0;
          if (remainingReplies === 0) {
            sql.exec("DELETE FROM comments WHERE id = ?", parentId);
          }
        }
      }
      return NO_LIFECYCLE_CHANGES;
    }
    case "subtask.create": {
      checkSubtaskParent(sql, message.parentCardId);

      const existingChild = sql
        .exec<{ taskNumber: number; title: string }>(
          "SELECT task_number AS taskNumber, title FROM cards WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      const existingRelation = sql
        .exec<{ sourceCardId: string; targetCardId: string; kind: string }>(
          `SELECT source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
             FROM card_relations
            WHERE id = ?`,
          message.relationId,
        )
        .toArray()[0];

      if (existingChild || existingRelation) {
        // A deliberate retry keeps the same child/relation ids. It is the same
        // creation only when the stored relation is exactly the requested
        // parent→child link and no other parent claims the child; anything else
        // is somebody else's identity and is never overwritten.
        const otherParent = sql
          .exec<{ id: string }>(
            `SELECT id FROM card_relations
              WHERE kind = 'subtask' AND target_card_id = ? AND id <> ?
              LIMIT 1`,
            message.id,
            message.relationId,
          )
          .toArray()[0];
        // The whole requested identity has to match — child id, stored title,
        // parent, relation and the absence of any other parent. Only then is this
        // a deliberate retry of the same creation rather than a colliding id.
        const isSameCreation =
          existingChild !== undefined &&
          existingChild.title === message.title &&
          existingRelation !== undefined &&
          existingRelation.kind === "subtask" &&
          existingRelation.sourceCardId === message.parentCardId &&
          existingRelation.targetCardId === message.id &&
          otherParent === undefined;
        if (!isSameCreation) throw new Error("Subtask identity is already in use.");
        return {
          archivedCards: [],
          purgedCardIds: [],
          numberedCard: { id: message.id, taskNumber: existingChild.taskNumber },
          skipActivities: true,
        };
      }

      let subtaskDone = false;
      if (message.checklistItemId !== undefined) {
        const item = sql
          .exec<{ cardId: string; text: string; done: number }>(
            "SELECT card_id AS cardId, text, done FROM checklist_items WHERE id = ?",
            message.checklistItemId,
          )
          .toArray()[0];
        if (!item || item.cardId !== message.parentCardId) {
          throw new Error("Checklist item is unavailable.");
        }
        if (item.text !== message.title) {
          throw new Error("Checklist item changed. Try converting it again.");
        }
        subtaskDone = item.done === 1;
      }

      const columnId = placementFor(sql, message.parentCardId, subtaskDone);
      const taskNumber = insertCard(
        sql,
        {
          id: message.id,
          columnId,
          title: message.title,
          position: message.position,
          subtaskDone,
          taskType: "subtask",
        },
        now,
      );
      sql.exec(
        "INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES (?, ?, ?, 'subtask')",
        message.relationId,
        message.parentCardId,
        message.id,
      );
      if (message.checklistItemId !== undefined) {
        sql.exec("DELETE FROM checklist_items WHERE id = ?", message.checklistItemId);
      }
      return { archivedCards: [], purgedCardIds: [], numberedCard: { id: message.id, taskNumber } };
    }
    case "relation.create": {
      if (message.kind === "subtask") {
        checkSubtaskLink(sql, message.sourceCardId, message.targetCardId);
      }
      if (message.sourceCardId === message.targetCardId) throw new Error("a card cannot be linked to itself");
      requireLiveCard(sql, message.sourceCardId);
      requireLiveCard(sql, message.targetCardId);
      sql.exec(
        "INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES (?, ?, ?, ?)",
        message.id,
        message.sourceCardId,
        message.targetCardId,
        message.kind,
      );
      if (message.kind === "subtask") {
        sql.exec(
          "UPDATE cards SET task_type = 'subtask', updated_at = ? WHERE id = ?",
          now,
          message.targetCardId,
        );
      }
      return NO_LIFECYCLE_CHANGES;
    }
    case "relation.delete": {
      const relation = sql
        .exec<{ targetCardId: string; kind: string }>(
          "SELECT target_card_id AS targetCardId, kind FROM card_relations WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      sql.exec("DELETE FROM card_relations WHERE id = ?", message.id);
      if (relation?.kind === "subtask") {
        sql.exec("UPDATE cards SET task_type = 'task' WHERE id = ?", relation.targetCardId);
      }
      return NO_LIFECYCLE_CHANGES;
    }
    case "label.create":
      sql.exec(
        "INSERT INTO labels(id, name, color) VALUES (?, ?, ?)",
        message.id,
        message.name,
        message.color,
      );
      return NO_LIFECYCLE_CHANGES;
    case "label.update":
      sql.exec(
        "UPDATE labels SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?",
        message.name ?? null,
        message.color ?? null,
        message.id,
      );
      return NO_LIFECYCLE_CHANGES;
    case "label.delete":
      // The definition is board-scoped: dropping it strips the label from
      // every card that carries it.
      sql.exec("DELETE FROM card_labels WHERE label_id = ?", message.id);
      sql.exec("DELETE FROM labels WHERE id = ?", message.id);
      return NO_LIFECYCLE_CHANGES;
    case "label.assign":
      requireLiveCard(sql, message.cardId);
      // A label deleted while this frame was in flight must not leave an orphan join row.
      if (!sql.exec("SELECT 1 FROM labels WHERE id = ?", message.labelId).toArray()[0]) throw new Error("label is unavailable");
      sql.exec(
        "INSERT INTO card_labels(id, card_id, label_id) VALUES (?, ?, ?)",
        message.id,
        message.cardId,
        message.labelId,
      );
      return NO_LIFECYCLE_CHANGES;
    case "label.unassign":
      sql.exec("DELETE FROM card_labels WHERE id = ?", message.id);
      return NO_LIFECYCLE_CHANGES;
  }
}
