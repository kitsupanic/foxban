import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  CARD_ARCHIVE_RETENTION_MS,
  ClientMessageSchema,
  Identifier,
  REALTIME_PROTOCOL_VERSION,
  buildSubtaskHierarchy,
  descriptionByteLength,
  type Activity,
  type ArchivedCard,
  type Attachment,
  type Card,
  type BoardDevelopment,
  type CardDevelopment,
  type CardLabel,
  type CardRelation,
  type ChecklistItem,
  type ClientMessage,
  type Column,
  type Label,
  type LabelColor,
  type PositionsRebalanced,
  type ServerMessage,
  type SubtaskHierarchy,
  TRANSFER_TERMINAL_CODE,
  type TransferTerminalCode,
} from "@foxban/shared";
import {
  ATTACHMENT_BOARD_ID,
  ATTACHMENT_ID,
  STAGED_ATTACHMENT_TTL_MS,
  attachmentObjectKey,
  attachmentTransferObjectKey,
  parseAttachmentObjectKey,
} from "./attachment-lifecycle";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_USER_ID_HEADER,
} from "./internal-headers";
import { readCardActivities } from "./activity";
import {
  completionFor,
  isCompleted,
  loadFamily,
  roleColumn,
} from "./subtask-family";
import {
  ARCHIVED_CARD_SELECT,
  allocateTaskNumber,
  createsLifecycleWork,
  deleteCards,
  endColumns,
  markRolesExplicit,
  readCardComments,
  rolesExplicit,
  runMutation,
  setWorkflowRoles,
  type ArchivedCardRow,
  type HeldRoutes,
} from "./board-mutations";
import {
  MutationRefusal,
  checkCardWritable,
  checkMutation,
  isCardLocked,
  type MutationContext,
} from "./mutation-gate";
import {
  linkPullRequestToCard,
  importCardBranches,
  importCardPullRequests,
  importCardUnlinks,
  readBoardPullRequests,
  readCardUnlinks,
  readCardBranches,
  readCardBranchesForTransfer,
  readCardPullRequests,
  readLegacyAssociations,
  unlinkBranchFromCard,
  unlinkPullRequestFromCard,
  writeBranch,
  writePullRequest,
} from "./development-info";
import { syncBranchRoute } from "./github-branch-routes";
import { syncPullRequestRoute } from "./github-pr-routes";
import { boardMemberSql, canManageBoard, canOpenBoard, isAdminEmail } from "./auth";
import { closeRevokedSockets, sessionHashOf } from "./session-revocation";
import { generateKeyBetween } from "fractional-indexing";
import {
  AddCommentOutputSchema,
  AssignLabelOutputSchema,
  LabelMutationOutputSchema,
  McpBoardReadRequestSchema,
  McpTaskListRequestSchema,
  McpTaskReadRequestSchema,
  TaskRecordSchema,
  TaskSummarySchema,
  TaskMutationOutputSchema,
  UnassignLabelOutputSchema,
  McpToolResultSchema,
  decodeCursor,
  encodeCursor,
  type McpBoardIdentity,
  type McpCommand,
  type McpToolResult,
  type TaskRecord,
} from "./mcp-contract";

import {
  decodeParams,
  matchRoute,
  type CardTransferReceipt,
  type Gate,
  type PreparedCardTransferBundle,
  type RouteGate,
  type RouteInput,
  type RouteMatch,
  type RouteName,
  type WriteBackCard,
} from "./board-api";
import { boardDestination, settle, type SourceParticipant } from "./card-transfer";
// The bundle is the transfer's wire contract and lives with the routes; tests and the coordinator read it from here.
export { PreparedCardTransferBundleSchema, type PreparedCardTransferBundle } from "./board-api";
/** One card's explicit association row, as stored. */
const CardPullRequestRowSchema = z.strictObject({
  repositoryId: z.number().int().positive(),
  number: z.number().int().positive(),
  revision: z.uuid(),
});
export class ImportConflictError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: TransferTerminalCode,
  ) {
    super(message);
  }
}


const ATTACHMENT_CLEANUP_RETRY_MS = 60_000;
const TRANSFER_LOCK_TTL_MS = 5 * 60 * 1000;
const TRANSFER_RETRY_DELAY_MS = 60_000;
const ATTACHMENT_KEYS_BACKFILLED_KEY = "attachment_keys_backfilled";
/** An MCP operation receipt answers a retry of its operation key for this long; the alarm prunes older ones. */
const MCP_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Outbound transfer locks an access fence settles in one prepare pass. */
const FENCE_TRANSFER_SETTLE_LIMIT = 50;
type TransferLock = { cardId: string; transferId: string; destinationBoardId: string };
/**
 * Schema version bookkeeping. workerd's SQLite refuses `PRAGMA user_version`
 * (SQLITE_AUTH), so the version lives in a table of our own. Boards created
 * before this table existed read as version 0 and replay from the start —
 * every v1 statement is `IF NOT EXISTS`, so that is a no-op for them.
 */
const META_TABLE = `CREATE TABLE IF NOT EXISTS meta(
     key TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`;

type MigrationStep = string | ((sql: SqlStorage) => void);

function addColumnIfNotExists(
  table: string,
  column: string,
  definition: string,
): MigrationStep {
  return (sql: SqlStorage) => {
    const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
    if (!columns.some((c) => c.name.toLowerCase() === column.toLowerCase())) {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
}

/**
 * Before ADR 0067 a subtask displayed in its topmost active ancestor's column.
 * Only migrations read that rule; live code reads each card's own column.
 */
function inheritedColumns(
  cards: readonly Pick<Card, "id" | "columnId">[],
  hierarchy: SubtaskHierarchy,
): Map<string, string> {
  const stored = new Map(cards.map((card) => [card.id, card.columnId]));
  return new Map(
    cards.map((card) => [
      card.id,
      stored.get(hierarchy.rootByCard.get(card.id) ?? card.id) ?? card.columnId,
    ]),
  );
}

/** A key that sorts after `tail`. A migration must not throw, or the board never wakes. */
function positionAfter(tail: string | null): string {
  try {
    return generateKeyBetween(tail, null);
  } catch {
    // shortcut: a stored key the library rejects gets a suffix instead of a repair, which still sorts last; repair keys if one ever needs a midpoint.
    // Capped at the 64-char Identifier limit; equal keys tie-break by id (ADR 0010).
    return tail!.length < 64 ? `${tail}V` : tail!;
  }
}

/**
 * ADR 0067: one subtask mode. A board with no starting column still holds the
 * inherited placement, where a subtask displays in its root's column and
 * completion is the stored `subtask_done`. Give such a board its roles and every
 * active subtask its own column. A board that already has a starting column was
 * configured by an admin: its roles are explicit and nothing else changes.
 */
function convertToIndependentSubtasks(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM columns WHERE starting = 1 LIMIT 1").toArray().length > 0) {
    markRolesExplicit(sql);
    return;
  }
  const roles = endColumns(sql);
  if (roles) {
    setWorkflowRoles(sql, roles.starting, roles.completed);
    // A board with real data keeps these roles until an admin changes them.
    if (sql.exec("SELECT 1 FROM cards LIMIT 1").toArray().length > 0) markRolesExplicit(sql);
  }

  const allCards = sql
    .exec<Pick<Card, "id" | "columnId" | "position"> & { archivedAt: number | null }>(
      "SELECT id, column_id AS columnId, position, archived_at AS archivedAt FROM cards",
    )
    .toArray();
  const cards = allCards.filter((card) => card.archivedAt === null);
  const relations = sql
    .exec<CardRelation>(
      `SELECT id, source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
         FROM card_relations`,
    )
    .toArray();
  const hierarchy = buildSubtaskHierarchy(cards, relations);
  // A parent that is archived still counts: the link is retained, and restoring
  // the parent reattaches the child.
  const withArchived = buildSubtaskHierarchy(allCards, relations);
  const inherited = inheritedColumns(cards, hierarchy);
  const tails = new Map<string, string>();
  for (const card of cards) {
    const tail = tails.get(card.columnId);
    if (tail === undefined || card.position > tail) tails.set(card.columnId, card.position);
  }

  const subtasks = sql
    .exec<{ id: string; columnId: string; done: number }>(
      `SELECT id, column_id AS columnId, subtask_done AS done FROM cards
        WHERE task_type = 'subtask' AND archived_at IS NULL ORDER BY position, id`,
    )
    .toArray();
  for (const child of subtasks) {
    // An active parent wins even when an archived second parent makes the full forest drop the edge.
    if (!hierarchy.parentByChild.has(child.id) && !withArchived.parentByChild.has(child.id)) {
      // No parent at all, or none the forest accepts (two parents, a cycle): an
      // ordinary task, and the links it kept go too.
      sql.exec("UPDATE cards SET task_type = 'task' WHERE id = ?", child.id);
      sql.exec("DELETE FROM card_relations WHERE kind = 'subtask' AND target_card_id = ?", child.id);
      continue;
    }
    // A child of an archived parent was displayed in its own stored column.
    let columnId = inherited.get(child.id) ?? child.columnId;
    if (roles) {
      if (child.done === 1) columnId = roles.completed;
      // Open work under a finished parent stays open instead of finishing silently.
      else if (columnId === roles.completed) columnId = roles.starting;
    }
    if (columnId === child.columnId) continue;
    const position = positionAfter(tails.get(columnId) ?? null);
    tails.set(columnId, position);
    sql.exec("UPDATE cards SET column_id = ?, position = ? WHERE id = ?", columnId, position, child.id);
  }
}

/** One batch per schema version, applied in order; index + 1 is the version it produces. */
const MIGRATIONS: MigrationStep[][] = [
  [
    `CREATE TABLE IF NOT EXISTS columns(
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     position TEXT NOT NULL
   )`,
    `CREATE TABLE IF NOT EXISTS cards(
     id TEXT PRIMARY KEY,
     column_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     position TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  ],
  [
    `ALTER TABLE cards ADD COLUMN assignee_id TEXT`,
    `CREATE TABLE IF NOT EXISTS checklist_items(
     id TEXT PRIMARY KEY,
     card_id TEXT NOT NULL,
     text TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     position TEXT NOT NULL
   )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS attachments(
     id TEXT PRIMARY KEY,
     card_id TEXT NOT NULL,
     file_name TEXT NOT NULL,
     content_type TEXT NOT NULL,
     size INTEGER NOT NULL
   )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS comments(
     id TEXT PRIMARY KEY,
     card_id TEXT NOT NULL,
     author_id TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  ],
  [
    // SQLite requires the DEFAULT on a NOT NULL add: existing rows backfill to 'medium'.
    `ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`,
  ],
  [`ALTER TABLE cards ADD COLUMN due_date TEXT`],
  [
    `CREATE TABLE IF NOT EXISTS card_relations(
     id TEXT PRIMARY KEY,
     source_card_id TEXT NOT NULL,
     target_card_id TEXT NOT NULL,
     kind TEXT NOT NULL
   )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS labels(
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     color TEXT NOT NULL
   )`,
    `CREATE TABLE IF NOT EXISTS card_labels(
     id TEXT PRIMARY KEY,
     card_id TEXT NOT NULL,
     label_id TEXT NOT NULL
   )`,
  ],
  [
    `ALTER TABLE attachments ADD COLUMN object_key TEXT`,
    `CREATE TABLE IF NOT EXISTS attachment_cleanup(
     object_key TEXT PRIMARY KEY,
     attachment_id TEXT NOT NULL,
     reason TEXT NOT NULL CHECK(reason IN ('staged', 'deleted')),
     delete_after INTEGER NOT NULL
   )`,
    `CREATE INDEX IF NOT EXISTS attachment_cleanup_due
     ON attachment_cleanup(delete_after)`,
    `CREATE INDEX IF NOT EXISTS attachment_cleanup_attachment
     ON attachment_cleanup(attachment_id)`,
    `CREATE TRIGGER IF NOT EXISTS attachments_claim_staged_object
     AFTER INSERT ON attachments
     BEGIN
       UPDATE attachments
          SET object_key = (
            SELECT object_key
              FROM attachment_cleanup
             WHERE attachment_id = NEW.id AND reason = 'staged'
             LIMIT 1
          )
        WHERE id = NEW.id;
       DELETE FROM attachment_cleanup
        WHERE attachment_id = NEW.id AND reason = 'staged';
     END`,
    `CREATE TRIGGER IF NOT EXISTS attachments_queue_object_delete
     AFTER DELETE ON attachments
     WHEN OLD.object_key IS NOT NULL
     BEGIN
       INSERT OR REPLACE INTO attachment_cleanup(
         object_key, attachment_id, reason, delete_after
       ) VALUES (OLD.object_key, OLD.id, 'deleted', 0);
     END`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS activities(
     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     card_id TEXT NOT NULL,
     actor_id TEXT NOT NULL,
     detail_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
    `CREATE INDEX IF NOT EXISTS activities_card_sequence
     ON activities(card_id, sequence)`,
  ],
  [
    addColumnIfNotExists("cards", "archived_at", "INTEGER"),
    addColumnIfNotExists("cards", "archived_column_title", "TEXT"),
    `CREATE INDEX IF NOT EXISTS cards_archived_at ON cards(archived_at)`,
  ],
  [
    addColumnIfNotExists("cards", "task_number", "INTEGER"),
    (sql: SqlStorage) => {
      // Backfill existing active and archived cards oldest-first by created_at, id
      sql.exec(`
        WITH numbered_cards AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS assigned_number
            FROM cards
        )
        UPDATE cards
           SET task_number = (
             SELECT assigned_number
               FROM numbered_cards
              WHERE numbered_cards.id = cards.id
           )
         WHERE task_number IS NULL
      `);
      const maxRow = sql
        .exec<{ maxNum: number | null }>("SELECT MAX(task_number) AS maxNum FROM cards")
        .toArray()[0];
      const nextTaskNumber = (maxRow?.maxNum ?? 0) + 1;
      sql.exec(
        `INSERT INTO meta(key, value) VALUES ('next_task_number', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        nextTaskNumber,
      );
    },
    `CREATE UNIQUE INDEX IF NOT EXISTS cards_task_number ON cards(task_number)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS card_transfer_locks(
       card_id TEXT PRIMARY KEY,
       transfer_id TEXT NOT NULL UNIQUE,
       expires_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS card_transfer_receipts(
       source_board_id TEXT NOT NULL,
       card_id TEXT NOT NULL,
       transfer_id TEXT NOT NULL,
       task_number INTEGER NOT NULL,
       PRIMARY KEY(source_board_id, card_id),
       UNIQUE(transfer_id)
     )`,
  ],
  [
    addColumnIfNotExists("comments", "parent_comment_id", "TEXT"),
    addColumnIfNotExists("comments", "deleted", "INTEGER NOT NULL DEFAULT 0"),
  ],
  [
    addColumnIfNotExists("cards", "task_type", "TEXT NOT NULL DEFAULT 'task'"),
  ],
  [
    (sql: SqlStorage) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS card_transfer_receipts_v2(
        transfer_id TEXT PRIMARY KEY,
        source_board_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        task_number INTEGER NOT NULL
      )`);
      sql.exec(`INSERT OR IGNORE INTO card_transfer_receipts_v2(transfer_id, source_board_id, card_id, task_number)
        SELECT transfer_id, source_board_id, card_id, task_number FROM card_transfer_receipts`);
      sql.exec(`DROP TABLE card_transfer_receipts`);
      sql.exec(`ALTER TABLE card_transfer_receipts_v2 RENAME TO card_transfer_receipts`);
    },
    (sql: SqlStorage) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS card_transfer_locks_v2(
        card_id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL UNIQUE,
        destination_board_id TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'prepared',
        expires_at INTEGER NOT NULL
      )`);
      sql.exec(`INSERT OR IGNORE INTO card_transfer_locks_v2(card_id, transfer_id, destination_board_id, phase, expires_at)
        SELECT card_id, transfer_id, '', 'prepared', expires_at FROM card_transfer_locks`);
      sql.exec(`DROP TABLE card_transfer_locks`);
      sql.exec(`ALTER TABLE card_transfer_locks_v2 RENAME TO card_transfer_locks`);
    },
    `DROP TRIGGER IF EXISTS attachments_claim_staged_object`,
    `DROP TRIGGER IF EXISTS attachments_preserve_imported_object`,
    `CREATE TRIGGER IF NOT EXISTS attachments_preserve_imported_object
     AFTER INSERT ON attachments
     WHEN NEW.object_key IS NOT NULL
     BEGIN
       DELETE FROM attachment_cleanup
        WHERE object_key = NEW.object_key AND reason = 'staged';
     END`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS card_transfer_operations(
       transfer_id TEXT PRIMARY KEY,
       card_id TEXT NOT NULL,
       destination_board_id TEXT NOT NULL,
       generation INTEGER NOT NULL,
       state TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    addColumnIfNotExists("card_transfer_locks", "generation", "INTEGER NOT NULL DEFAULT 1"),
  ],
  [
    addColumnIfNotExists("attachment_cleanup", "claim_token", "TEXT"),
    addColumnIfNotExists("attachment_cleanup", "claimed_at", "INTEGER"),
    `DROP TRIGGER IF EXISTS attachments_claim_staged_object`,
    `DROP TRIGGER IF EXISTS attachments_preserve_imported_object`,
    `CREATE TRIGGER IF NOT EXISTS attachments_preserve_imported_object
     AFTER INSERT ON attachments
     WHEN NEW.object_key IS NOT NULL
     BEGIN
       DELETE FROM attachment_cleanup
        WHERE object_key = NEW.object_key AND reason = 'staged';
     END`,
    `DROP TRIGGER IF EXISTS attachments_queue_object_delete`,
    `CREATE TRIGGER IF NOT EXISTS attachments_queue_object_delete
     AFTER DELETE ON attachments
     WHEN OLD.object_key IS NOT NULL
     BEGIN
       INSERT INTO attachment_cleanup(
         object_key, attachment_id, reason, delete_after
       ) VALUES (OLD.object_key, OLD.id, 'deleted', 0)
       ON CONFLICT(object_key) DO UPDATE SET
         reason = 'deleted',
         delete_after = 0
       WHERE attachment_cleanup.claim_token IS NULL;
     END`,
  ],
  [
    addColumnIfNotExists("attachment_cleanup", "deleted_at", "INTEGER"),
    `CREATE INDEX IF NOT EXISTS attachment_cleanup_deleted_at ON attachment_cleanup(deleted_at)`,
    `DROP TRIGGER IF EXISTS attachments_queue_object_delete`,
    `CREATE TRIGGER IF NOT EXISTS attachments_queue_object_delete
     AFTER DELETE ON attachments
     WHEN OLD.object_key IS NOT NULL
     BEGIN
       INSERT INTO attachment_cleanup(
         object_key, attachment_id, reason, delete_after
       ) VALUES (OLD.object_key, OLD.id, 'deleted', 0)
       ON CONFLICT(object_key) DO UPDATE SET
         reason = 'deleted',
         delete_after = 0
       WHERE attachment_cleanup.claim_token IS NULL
         AND attachment_cleanup.deleted_at IS NULL;
     END`,
    `DROP TRIGGER IF EXISTS attachments_preserve_imported_object`,
    `CREATE TRIGGER IF NOT EXISTS attachments_preserve_imported_object
     AFTER INSERT ON attachments
     WHEN NEW.object_key IS NOT NULL
     BEGIN
       DELETE FROM attachment_cleanup
        WHERE object_key = NEW.object_key AND reason = 'staged' AND deleted_at IS NULL;
     END`,
  ],
  [
    // Exactly one explicit pull request per card, and no GitHub state beyond the
    // identity: title, body, head, token and status all stay on GitHub. `revision`
    // is the compare-and-set token that makes replacement safe between peers.
    `CREATE TABLE IF NOT EXISTS card_github_pull_requests(
       card_id TEXT PRIMARY KEY,
       repository_id INTEGER NOT NULL,
       pull_number INTEGER NOT NULL,
       revision TEXT NOT NULL
     )`,
  ],
  [
    // Subtask completion is the child's own flag, independent of its parent and
    // of its checklist. Existing cards start incomplete: there is no historical
    // source for this state, and a column name or checklist percentage is not one.
    addColumnIfNotExists("cards", "subtask_done", "INTEGER NOT NULL DEFAULT 0"),
  ],
  [
    (sql: SqlStorage) => {
      // Earlier releases allowed recursive subtask relations. Cleanly unlink
      // every edge whose parent is itself a child, preserving each active
      // descendant's effective column before removing the edge.
      const cards = sql
        .exec<Pick<Card, "id" | "columnId" | "position">>(
          "SELECT id, column_id AS columnId, position FROM cards WHERE archived_at IS NULL",
        )
        .toArray();
      const relations = sql
        .exec<CardRelation>(
          `SELECT id, source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
             FROM card_relations`,
        )
        .toArray();
      const hierarchy = buildSubtaskHierarchy(cards, relations);
      const inherited = inheritedColumns(cards, hierarchy);
      // Preserve the identity of every card that entered this migration as a
      // subtask, including descendants whose now-forbidden nested edge is about
      // to be unlinked.
      sql.exec(
        `UPDATE cards
            SET task_type = 'subtask'
          WHERE id IN (
            SELECT target_card_id FROM card_relations WHERE kind = 'subtask'
          )`,
      );
      const childIds = new Set(
        relations
          .filter((relation) => relation.kind === "subtask")
          .map((relation) => relation.targetCardId),
      );
      for (const relation of relations) {
        if (relation.kind !== "subtask" || !childIds.has(relation.sourceCardId)) continue;
        const columnId = inherited.get(relation.targetCardId);
        if (columnId !== undefined) {
          sql.exec("UPDATE cards SET column_id = ? WHERE id = ?", columnId, relation.targetCardId);
        }
        sql.exec("DELETE FROM card_relations WHERE id = ?", relation.id);
      }
      // Every remaining linked child has the immutable Subtask type. Unrelated
      // roots keep their existing type.
      sql.exec(
        `UPDATE cards
            SET task_type = 'subtask'
          WHERE id IN (
            SELECT target_card_id FROM card_relations WHERE kind = 'subtask'
          )`,
      );
    },
  ],
  [
    `CREATE TABLE IF NOT EXISTS mcp_operation_receipts(
       credential_id TEXT NOT NULL,
       operation_key TEXT NOT NULL,
       actor_id TEXT NOT NULL,
       operation TEXT NOT NULL,
       input_hash TEXT NOT NULL,
       result_json TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (credential_id, operation_key)
     )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS board_access_state(
       id INTEGER PRIMARY KEY CHECK(id=1),
       generation INTEGER NOT NULL,
       pending_operation_id TEXT,
       frozen INTEGER NOT NULL CHECK(frozen IN (0,1))
     )`,
    `INSERT OR IGNORE INTO board_access_state(id,generation,pending_operation_id,frozen) VALUES(1,0,NULL,0)`,
  ],
  [
    (sql: SqlStorage) => {
      const names = new Set(sql.exec<{ name: string }>("PRAGMA table_info(columns)").toArray().map(c => c.name));
      if (!names.has("completed")) sql.exec("ALTER TABLE columns ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
      if (!names.has("starting")) sql.exec("ALTER TABLE columns ADD COLUMN starting INTEGER NOT NULL DEFAULT 0");
    },
  ],
  [
    // Development info (ADR 0064): the pull requests webhooks linked to a card, one
    // row per (card, PR) holding the PR's last accepted state. `updated_at` is
    // GitHub's `updated_at` in epoch ms and orders writes, so a late or repeated
    // event cannot roll a row back. No history, body or branches here.
    `CREATE TABLE IF NOT EXISTS card_development_pull_requests(
       card_id TEXT NOT NULL,
       repository_id INTEGER NOT NULL,
       number INTEGER NOT NULL,
       repository TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL CHECK(state IN ('open','draft','merged','closed')),
       url TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (card_id, repository_id, number)
     )`,
    `CREATE INDEX IF NOT EXISTS card_development_pull_requests_pr
       ON card_development_pull_requests(repository_id, number)`,
  ],
  [
    // Development info (ADR 0064): the branches whose names linked them to a card, one
    // row per (card, branch) holding only the branch's latest commit. Branch events carry
    // no clock, so `observed_at` is when the Worker's re-read of the branch began; it
    // orders writes. `committed_at` is the commit's own time and is for display.
    `CREATE TABLE IF NOT EXISTS card_development_branches(
       card_id TEXT NOT NULL,
       repository_id INTEGER NOT NULL,
       name TEXT NOT NULL,
       repository TEXT NOT NULL,
       url TEXT NOT NULL,
       sha TEXT NOT NULL,
       message TEXT NOT NULL,
       committed_at INTEGER NOT NULL,
       observed_at INTEGER NOT NULL,
       PRIMARY KEY (card_id, repository_id, name)
     )`,
    `CREATE INDEX IF NOT EXISTS card_development_branches_branch
       ON card_development_branches(repository_id, name)`,
  ],
  [
    // Unlink tombstones (ADR 0064): `(card, kind, repository, ref)` that key matching must skip,
    // so an unlink holds. `ref` is a PR number as text, or a branch name for kind 'branch'.
    `CREATE TABLE IF NOT EXISTS card_development_unlinks(
       card_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK(kind IN ('pull_request','branch')),
       repository_id INTEGER NOT NULL,
       ref TEXT NOT NULL,
       PRIMARY KEY (card_id, kind, repository_id, ref)
     )`,
  ],
  [convertToIndependentSubtasks],
  [
    // Looked up by a scan until now: a card's comments (opening it, the cascade), a comment's replies
    // (comment.delete), an attachment by its R2 key (cleanup, reconcile) and a card's attachments (the cascade).
    `CREATE INDEX IF NOT EXISTS comments_card ON comments(card_id)`,
    `CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_comment_id)`,
    `CREATE INDEX IF NOT EXISTS attachments_object_key ON attachments(object_key)`,
    `CREATE INDEX IF NOT EXISTS attachments_card ON attachments(card_id)`,
  ],
];

type MutationRequest =
  | { source: "websocket"; message: ClientMessage; rawFrame: string }
  | {
      source: "mcp";
      command: McpCommand;
      credentialId: string;
      inputHash: string;
      board: McpBoardIdentity;
      assigneeAllowed: boolean;
    };

/**
 * SQLite has no boolean type: `subtask_done` reads back as 0/1 exactly like
 * checklist `done`, so every card SELECT declares the row shape and maps it
 * before the row leaves the DO.
 */
type CardRow = Omit<Card, "subtaskDone"> & { subtaskDone: number };

/**
 * What the DO knows about one caller's access at the moment it acts: granted with
 * the management capability that comes with it, denied, or blocked because a
 * membership attempt already owns this board's policy in D1.
 */
type BoardAccessVerdict =
  | { kind: "granted"; canManageColumns: boolean; operator: boolean }
  | { kind: "transition" }
  | { kind: "denied" };

/**
 * What one protected path's admission settled on: the verdict, or the reason none was
 * usable. `transition` is the only member that means the policy moved; `unavailable`
 * means the object could not settle the question in its bounded window, which is an
 * ordinary retry and never evidence of a changed or refused policy.
 */
type ProtectedAdmission =
  | { kind: "granted"; canManageColumns: boolean; probeAllowed: boolean }
  | { kind: "transition" }
  | { kind: "denied" }
  | { kind: "unavailable" };

/**
 * One instance per board. Owns the board's state (SQLite-backed DO storage —
 * board state never lives in D1) and every live connection to that board.
 *
 * Uses the WebSocket Hibernation API exclusively: sockets are handed to
 * `ctx.acceptWebSocket` and delivered back through the `webSocket*` handlers,
 * so an idle board can hibernate. Never `ws.addEventListener`.
 */
/** Why a member's link change cannot run on this card now, or null: the card must be active and not in a transfer. */
function linkChangeRefusal(sql: SqlStorage, cardId: string) {
  const active = sql.exec("SELECT 1 FROM cards WHERE id = ? AND task_number IS NOT NULL AND archived_at IS NULL", cardId).toArray().length > 0;
  if (!active) return { status: 404, code: "card_unavailable", error: "card not found or archived" } as const;
  if (isCardLocked(sql, cardId)) return { status: 409, code: "card_transfer_locked", error: "card transfer in progress" } as const;
  return null;
}

/** What a handler is given, whatever its route: the request, the board it was admitted for and the path's parameters. */
type RouteContext = { request: Request; boardId: string; params: Record<string, string> };
/** A protected route's handler also gets the actor and the facts of the verdict that admitted them. */
type ProtectedContext = RouteContext & { userId: string; canManageColumns: boolean; probeAllowed: boolean };
type Handlers = {
  [K in RouteName]: (
    ctx: RouteGate<K> extends "protected" ? ProtectedContext : RouteContext,
    input: RouteInput<K>,
  ) => Response | Promise<Response>;
};

export class BoardDO extends DurableObject<Env> {
  private readonly attachmentBucket: R2Bucket;
  private deleting = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.attachmentBucket = env.ATTACHMENTS;
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(META_TABLE);
      this.deleting = sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'deleted'").toArray()[0]?.value === 1;
      const stored = sql
        .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'")
        .toArray()[0];
      const version = stored?.value ?? 0;
      if (version >= MIGRATIONS.length) return;

      for (let i = version; i < MIGRATIONS.length; i++) {
        const targetVersion = i + 1;
        const batch = MIGRATIONS[i]!;
        ctx.storage.transactionSync(() => {
          for (const step of batch) {
            if (typeof step === "function") {
              step(sql);
            } else {
              sql.exec(step);
            }
          }
          sql.exec(
            `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            targetVersion,
          );
        });
      }
      const nextLock = sql
        .exec<{ expireAt: number | null }>(
          "SELECT MIN(expires_at) AS expireAt FROM card_transfer_locks",
        )
        .toArray()[0]?.expireAt;
      const nextAttachment = this.nextAttachmentWake();
      const candidates: number[] = [];
      if (nextLock !== null && nextLock !== undefined) candidates.push(nextLock);
      if (nextAttachment !== null && nextAttachment !== undefined) candidates.push(nextAttachment);
      if (candidates.length > 0) {
        await this.scheduleAlarmAt(Math.max(Date.now(), Math.min(...candidates)));
      }
    });
  }

  /**
   * The local policy boundary: this board's generation, whether it is frozen, and
   * the attempt that owns the fence. Read at the moment of use and never cached
   * across an await, because a prepare, commit or release can land while any
   * request is still in flight.
   */
  private policyBoundary(): {
    generation: number;
    frozen: number;
    pendingOperationId: string | null;
  } | null {
    return (
      this.ctx.storage.sql
        .exec<{ generation: number; frozen: number; pendingOperationId: string | null }>(
          `SELECT generation,frozen,pending_operation_id AS pendingOperationId FROM board_access_state WHERE id=1`,
        )
        .toArray()[0] ?? null
    );
  }

  /** The single refusal for a request that arrives while this board's access is changing. */
  private accessChangingResponse(): Response {
    return Response.json(
      { code: "access_change_pending", error: "Board access is changing. Please retry." },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }

  /**
   * The refusal for an admission the object could not settle: the dependency did not
   * answer in time or failed. It is an ordinary retryable failure — never the
   * transition signal (nothing is known to have changed) and never a denial.
   */
  private accessUnavailableResponse(): Response {
    return Response.json(
      { code: "internal_error", error: "Board access could not be confirmed. Please retry." },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }

  /**
   * Current access for one user, resolved in the DO from D1. The Worker's internal
   * headers describe the request it accepted, not the policy in force when this
   * event finally runs: a member can be removed or a board moved while a body is
   * buffered or a socket upgrade waits, so every protected path resolves for itself.
   */
  private async currentBoardAccess(
    boardId: string,
    userId: string,
  ): Promise<BoardAccessVerdict> {
    const row = await this.env.DB.prepare(
      `SELECT b.owner_id AS ownerId,b.access_mode AS accessMode,u.email,
              b.pending_access_operation_id AS pendingOperationId,
              bm.role AS explicitRole,wm.role AS workspaceRole
         FROM boards b JOIN users u ON u.id=?
         LEFT JOIN board_members bm ON bm.board_id=b.id AND bm.user_id=?
         LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
        WHERE b.id=?`,
    )
      .bind(userId, userId, userId, boardId)
      .first<{
        ownerId: string;
        accessMode: string;
        email: string;
        pendingOperationId: string | null;
        explicitRole: string | null;
        workspaceRole: string | null;
      }>();
    if (!row) return { kind: "denied" };
    const facts = {
      operator: isAdminEmail(this.env, row.email),
      owner: row.ownerId === userId,
      accessMode: row.accessMode,
      explicitRole: row.explicitRole,
      workspaceRole: row.workspaceRole,
    };
    if (!canOpenBoard(facts)) return { kind: "denied" };
    // Authorized, but a membership attempt has already claimed this board in D1 and
    // may not have reached its prepare yet: the caller must retry, not be denied.
    if (row.pendingOperationId !== null) return { kind: "transition" };
    return {
      kind: "granted",
      canManageColumns: canManageBoard(facts),
      operator: facts.operator,
    };
  }

  /**
   * Whether `assigneeId` may be assigned work on this board right now: an explicit
   * grant, or a workspace membership while the board is workspace-access. The Worker
   * resolves the same relation when it builds the command, but that answer can be
   * old by the time this object runs, so an assignment is admitted on this read.
   */
  private async currentAssigneeEligible(boardId: string, assigneeId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT 1 AS present FROM boards b WHERE b.id=? AND ${boardMemberSql("b", "?")}`,
    )
      .bind(boardId, assigneeId, assigneeId)
      .first();
    return row !== null;
  }

  /**
   * The socket path's own eligibility read, the one an MCP creation gets at admission.
   * Bounded the same way, and held in one input-gate window so the sender's next
   * message cannot overtake the assignment it follows. Every refusal is a
   * `MutationRefusal`, which `webSocketMessage` already answers.
   */
  private async requireAssigneeEligible(boardId: string | null, assigneeId: string): Promise<void> {
    if (boardId === null) throw new MutationRefusal("forbidden", "Reconnect to assign tasks.", 1012);
    const eligible = await this.ctx.blockConcurrencyWhile(() =>
      withDeadline(this.currentAssigneeEligible(boardId, assigneeId), ADMISSION_DEADLINE_MS),
    );
    if (eligible === null) throw new MutationRefusal("internal_error", "Assignee could not be confirmed. Try again.");
    if (!eligible) throw new MutationRefusal("assignee_not_member", "Assignee is not a board member.");
  }

  /**
   * The admission every protected asynchronous path shares. The boundary is read
   * before the D1 verdicts and again after them, and the whole window runs inside
   * one `blockConcurrencyWhile`, so a prepare, commit or release cannot be delivered
   * between the verdict and the effect that consumes it: an authorization answer
   * that arrives after the policy moved is discarded, never applied.
   *
   * Bounded by construction — the actor's verdict plus at most one `probe` read
   * (the assignee of an MCP creation). No R2 access, transfer saga or multi-board
   * orchestration belongs inside this window.
   */
  private async admitProtectedPath(
    boardId: string,
    userId: string,
    probe?: () => Promise<boolean>,
  ): Promise<
    | { admitted: true; canManageColumns: boolean; probeAllowed: boolean }
    | { admitted: false; response: Response }
  > {
    const outcome = await this.ctx.blockConcurrencyWhile<ProtectedAdmission>(async () => {
      const before = this.policyBoundary();
      if (!before || before.frozen === 1 || before.pendingOperationId !== null)
        return { kind: "transition" };
      // The plan's bounded authorization wait: the D1 verdicts are raced against a
      // five-second deadline *inside* the window, so the gate this request holds can
      // never stay closed on a slow dependency. The raced work reports a dependency
      // failure as an answer instead of throwing, so this callback — and therefore the
      // object — never sees a rejection from it, and an answer that arrives after the
      // deadline is discarded by construction: the abandoned continuation only reads
      // D1, and its value is never consumed.
      const answered = await withDeadline(
        (async (): Promise<ProtectedAdmission> => {
          const access = await this.currentBoardAccess(boardId, userId);
          if (access.kind !== "granted") return access;
          const probeAllowed = probe ? await probe() : true;
          const after = this.policyBoundary();
          if (
            !after ||
            after.frozen === 1 ||
            after.pendingOperationId !== null ||
            after.generation !== before.generation
          )
            return { kind: "transition" };
          return {
            kind: "granted",
            canManageColumns: access.canManageColumns,
            probeAllowed,
          };
        })().catch((): ProtectedAdmission => ({ kind: "unavailable" })),
        ADMISSION_DEADLINE_MS,
      );
      // A deadline is the same class of answer as a dependency failure: retryable, and
      // no evidence at all that the policy moved or that the caller was denied.
      return answered ?? { kind: "unavailable" };
    });
    if (outcome.kind === "unavailable")
      return { admitted: false, response: this.accessUnavailableResponse() };
    if (outcome.kind === "transition")
      return { admitted: false, response: this.accessChangingResponse() };
    if (outcome.kind === "denied")
      return { admitted: false, response: new Response("forbidden", { status: 403 }) };
    return {
      admitted: true,
      canManageColumns: outcome.canManageColumns,
      probeAllowed: outcome.probeAllowed,
    };
  }

  /**
   * One handler per route of `boardRoutes`, so a route cannot be added to the table
   * without one. By the time a handler runs, `dispatch` has done everything the route's
   * gate class promises: the gates, the identity checks, the body parse and, for a
   * protected route, the admission.
   */
  private readonly handlers: Handlers = {
    accessPrepare: ({ boardId }, input) => this.changeAccess("prepare", boardId, input),
    accessRelease: ({ boardId }, input) => this.changeAccess("release", boardId, input),
    boardDelete: ({ boardId }) => this.deleteBoard(boardId),
    sessionRevoke: (_, input) => Response.json({ closed: closeRevokedSockets(this.ctx.getWebSockets(), input) }),
    transferReceipt: (_, input) => this.readTransferReceipt(input),
    transferAbort: (_, input) => this.abortTransfer(input),
    transferFinalize: (_, input) => this.finalizeTransfer(input),
    transferRelease: ({ boardId }, input) => this.releaseTransfer(boardId, input),
    attachmentsReconcile: ({ boardId }, input) => this.reconcileAttachments(boardId, input),
    writeBack: ({ params }) => this.readWriteBackCard(params.cardId),
    boardDevelopment: () => Response.json({ cards: readBoardPullRequests(this.ctx.storage.sql) } satisfies BoardDevelopment),
    cardDevelopment: ({ params }) => this.readCardDevelopment(params.cardId),
    cardActivity: ({ params }) => Response.json({ activities: readCardActivities(this.ctx.storage.sql, params.cardId) }),
    cardComments: ({ params }) => Response.json({ comments: readCardComments(this.ctx.storage.sql, params.cardId) }),
    pullRequestWrite: ({ boardId }, input) => this.acceptPullRequestWrite(boardId, input),
    branchWrite: ({ boardId }, input) => this.acceptBranchWrite(boardId, input),
    attachmentKey: ({ params }) => this.readAttachmentKey(params.attachmentId),
    transferOptions: () => this.readTransferOptions(),
    mcpBoard: (_, input) => this.mcpResponse(() => this.readMcpBoard(input)),
    mcpTasks: (_, input) => this.mcpResponse(() => this.readMcpTasks(input)),
    mcpTask: (_, input) => this.mcpResponse(() => this.readMcpTask(input)),
    mcpCommand: (ctx, input) => this.mcpResponse(() => this.executeMcpRequest(ctx, input)),
    pullRequestLink: ({ boardId, params }, input) => this.changePullRequestLink(boardId, params.cardId, input),
    pullRequestUnlink: ({ boardId, params }, input) => this.changePullRequestLink(boardId, params.cardId, input),
    branchUnlink: ({ boardId, params }, input) => this.unlinkBranch(boardId, params.cardId, input),
    attachmentStage: ({ boardId }, input) => this.stageAttachment(boardId, input),
    transferPrepare: ({ boardId, userId }, input) => this.prepareTransfer(boardId, userId, input),
    transferImport: ({ boardId, userId }, input) => this.importTransfer(boardId, userId, input),
  };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const boardId = request.headers.get(INTERNAL_BOARD_ID_HEADER);
    const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
    const match = matchRoute(url.pathname, request.method);

    // A fence is how a board enters and leaves the gates, so it is dispatched ahead of them.
    // Everything else, a path no route owns included, stands behind them.
    if (match?.spec.gate !== "fence") {
      const refused = this.gateRefusal(match?.spec.gate);
      if (refused) return refused;
      if (boardId !== null && ATTACHMENT_BOARD_ID.test(boardId) && (match === null || match.spec.stamp)) {
        await this.stampIdentity(boardId);
      }
    }
    // The realtime socket is the one thing the table does not own: it is every other path.
    if (match === null) return this.acceptSocket(request, boardId, userId);
    return this.dispatch(match, request, boardId, userId);
  }

  /**
   * The gates that stand in front of every route but a fence. Settlement of a transfer
   * that already exists (receipt, abort, finalize, release) runs even behind an access
   * fence: it is identity-bound, creates no card content, and is how a frozen board
   * drains its own in-flight transfers. New transfers (options, prepare, import) stay
   * behind the gate. A deleted board still collects its objects (cleanup).
   */
  private gateRefusal(gate: Gate | undefined): Response | null {
    const settlement = gate === "settlement";
    const deletedCleanup = this.deleting && gate === "cleanup";
    if (this.deleting && !settlement && !deletedCleanup) return new Response("board deleted", { status: 410 });
    if (settlement || deletedCleanup) return null;
    const policyState = this.policyBoundary();
    return !policyState || policyState.frozen === 1 ? this.accessChangingResponse() : null;
  }

  /**
   * The checks every route owes its gate class, in the order they have always run:
   * method, identity, body, then (protected routes) admission, and only then the handler.
   */
  private async dispatch(
    match: RouteMatch,
    request: Request,
    boardId: string | null,
    userId: string | null,
  ): Promise<Response> {
    const { name, spec } = match;
    if (!(spec.methods as readonly string[]).includes(request.method)) return new Response("method not allowed", { status: 405 });
    if (boardId === null || !ATTACHMENT_BOARD_ID.test(boardId)) {
      return new Response(spec.joinedIdentity ? "invalid identity" : "invalid board id", { status: 400 });
    }
    let actor: string | null = null;
    if (spec.gate === "protected") {
      if (userId === null || !Identifier.safeParse(userId).success) return new Response("invalid identity", { status: 400 });
      actor = userId;
    }
    const params = decodeParams(match.params);
    let input: unknown;
    if (spec.input) {
      const parsed = spec.input.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return spec.invalid!();
      input = parsed.data;
      if (spec.boardOf && spec.boardOf(input) !== boardId) return new Response("invalid board identity", { status: 400 });
    }
    const handler = this.handlers[name] as (ctx: RouteContext | ProtectedContext, input: unknown) => Response | Promise<Response>;
    if (actor === null) return handler({ request, boardId, params }, input);
    // One admission for every protected path: the boundary before the D1 verdicts, the
    // verdicts (including the current eligibility of an assignee the body names), and the
    // boundary after, all inside one bounded window, so a verdict a later prepare, commit
    // or release invalidated is discarded instead of being consumed by this request.
    // Receipts are replayed under this verdict too, so a stored result is never served to
    // a caller who lost access while its body was arriving.
    const assigneeId: string | null = spec.assignee?.(input) ?? null;
    const admitted = await this.admitProtectedPath(
      boardId,
      actor,
      assigneeId === null ? undefined : () => this.currentAssigneeEligible(boardId, assigneeId),
    );
    if (!admitted.admitted) return admitted.response;
    return handler(
      { request, boardId, params, userId: actor, canManageColumns: admitted.canManageColumns, probeAllowed: admitted.probeAllowed },
      input,
    );
  }

  /**
   * Records which board this object is, before the route's own checks. The Worker names
   * the board in a header on every request, so this is how an object learns its id, how a
   * row from before attachments had internal keys gets one, and how a board whose locks
   * expired while nothing named it wakes to settle them. Idempotent, and a no-op
   * once the id and the key backfill below are both on record.
   */
  private async stampIdentity(boardId: string): Promise<void> {
    const stored = new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string | number }>("SELECT key, value FROM meta WHERE key IN ('board_id', ?)", ATTACHMENT_KEYS_BACKFILLED_KEY)
        .toArray()
        .map((row) => [row.key, row.value]),
    );
    const priorBoardId = stored.get("board_id");
    if (priorBoardId === boardId && stored.get(ATTACHMENT_KEYS_BACKFILLED_KEY) === 1) return;

    this.ctx.storage.sql.exec(
      `INSERT INTO meta(key, value) VALUES ('board_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      boardId,
    );
    // v9 rows created before this deployment have no internal R2 key. The
    // membership-checked Worker supplies the board id on every socket fetch,
    // so the first reconnect backfills them before any delete can arrive.
    // Once is enough: every later attachment row is written with its key. The
    // marker is separate from `board_id`, which an alarm can record on its own.
    this.ctx.storage.sql.exec(
      "UPDATE attachments SET object_key = ? || '/' || id WHERE object_key IS NULL",
      boardId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO meta(key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = 1",
      ATTACHMENT_KEYS_BACKFILLED_KEY,
    );

    if (!priorBoardId) {
      const hasExpiredLocks = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM card_transfer_locks WHERE expires_at <= ?",
          Date.now(),
        )
        .toArray()[0]?.count ?? 0;
      if (hasExpiredLocks > 0) {
        await this.scheduleAlarmAt(Date.now());
        this.ctx.waitUntil(this.recoverExpiredTransferLocks(Date.now()));
      }
    }
  }

  /** Runs one MCP request the dispatcher admitted; a refusal, a bad request and a crash each answer in the contract's shape. */
  private mcpResponse(run: () => McpToolResult): Response {
    try {
      return Response.json(run());
    } catch (error) {
      if (error instanceof MutationRefusal) return Response.json(this.mcpFailure(error));
      if (error instanceof z.ZodError) return new Response("invalid request", { status: 400 });
      return Response.json({
        ok: false,
        error: {
          code: "internal_error",
          message: "Unexpected failure; retry with the same operationKey.",
          retryable: true,
        },
      } satisfies McpToolResult);
    }
  }

  private executeMcpRequest(
    { request, boardId, userId, canManageColumns, probeAllowed }: ProtectedContext,
    input: RouteInput<"mcpCommand">,
  ): McpToolResult {
    const executed = this.executeMutation(
      {
        source: "mcp",
        command: input.command,
        credentialId: input.credentialId,
        inputHash: input.inputHash,
        board: input.board,
        assigneeAllowed: probeAllowed,
      },
      {
        actorId: userId,
        boardId,
        canManageColumns: canManageColumns && request.headers.get(INTERNAL_CAN_MANAGE_COLUMNS_HEADER) === "true",
      },
    );
    if (executed === undefined) throw new Error("missing MCP result");
    return executed;
  }

  /** Moves this board into (`prepare`) or out of (`release`) the access fence of an operation D1's journal says it takes part in. */
  private async changeAccess(
    op: "prepare" | "release",
    boardId: string,
    { operationId, generation }: RouteInput<"accessPrepare">,
  ): Promise<Response> {
    const participant = await this.env.DB.prepare(
      `SELECT o.phase,b.next_version AS generation FROM access_change_operations o JOIN access_change_boards b ON b.operation_id=o.id WHERE o.id=? AND b.board_id=?`,
    ).bind(operationId,boardId).first<{phase:string;generation:number}>();
    if (!participant || participant.generation !== generation) return new Response("access operation not found",{status:409});
    if (op === "prepare") {
      if (participant.phase !== "preparing") return new Response("operation is terminal",{status:409});
      let conflicted = false;
      this.ctx.storage.transactionSync(()=>{
        const state=this.policyBoundary();
        // A newer generation, or a different pending operation, always wins: this
        // message must not refreeze a fence it no longer owns. Reaching this
        // operation's own generation is likewise only possible once — a prepare
        // that arrives after its release must not refreeze a boundary nothing will
        // ever release again, leaving the board permanently unusable.
        if (state) {
          if (state.generation > generation) { conflicted = true; return; }
          if (state.generation === generation) {
            if (state.frozen === 1 && state.pendingOperationId === operationId) return;
            conflicted = true;
            return;
          }
          if (state.frozen === 1 && state.pendingOperationId !== operationId) { conflicted = true; return; }
        }
        this.ctx.storage.sql.exec(`UPDATE board_access_state SET generation=?,pending_operation_id=?,frozen=1 WHERE id=1`,generation,operationId);
      });
      if (conflicted) return new Response("stale access operation",{status:409});
      for(const socket of this.ctx.getWebSockets())try{socket.close(4010,"Board access is changing");}catch{}
      // A card copied to another board under the old policy must not land after the
      // change commits: every outbound transfer is settled (finalized or aborted at
      // its destination) before this board claims to be prepared.
      const locks = this.ctx.storage.sql
        .exec<TransferLock>(
          `SELECT card_id AS cardId, transfer_id AS transferId, destination_board_id AS destinationBoardId
             FROM card_transfer_locks ORDER BY card_id LIMIT ?`,
          FENCE_TRANSFER_SETTLE_LIMIT + 1,
        )
        .toArray();
      let pending = locks.length > FENCE_TRANSFER_SETTLE_LIMIT;
      const now = Date.now();
      for (const lock of locks.slice(0, FENCE_TRANSFER_SETTLE_LIMIT)) {
        if ((await this.settleTransferLock(lock, boardId, now, false)) === "retry") pending = true;
      }
      if (pending) return new Response("transfer settlement pending", { status: 503 });
      return Response.json({prepared:true});
    }
    if (!["committed","aborted","completed"].includes(participant.phase)) return new Response("operation is not terminal",{status:409});
    this.ctx.storage.transactionSync(()=>{
      const state=this.ctx.storage.sql.exec<{generation:number;pendingOperationId:string|null}>(`SELECT generation,pending_operation_id AS pendingOperationId FROM board_access_state WHERE id=1`).toArray()[0];
      if (!state || state.generation > generation || (state.pendingOperationId!==null&&state.pendingOperationId!==operationId)) return;
      this.ctx.storage.sql.exec(`UPDATE board_access_state SET generation=?,pending_operation_id=NULL,frozen=0 WHERE id=1`,generation);
    });
    return Response.json({released:true});
  }

  private async deleteBoard(boardId: string): Promise<Response> {
    this.deleting = true;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES ('deleted',1)");
        // Receipts must outlive content: a source may still need to finish a committed move.
        for (const table of [
          "attachments", "checklist_items", "comments", "activities", "card_relations",
          "card_labels", "labels", "card_github_pull_requests", "card_development_pull_requests", "card_development_branches", "card_development_unlinks", "cards", "columns",
          "card_transfer_locks", "card_transfer_operations", "mcp_operation_receipts", "attachment_cleanup",
        ]) sql.exec(`DELETE FROM ${table}`);
        sql.exec("DELETE FROM meta WHERE key NOT IN ('schema_version','board_id','deleted')");
      });
      await this.ctx.storage.deleteAlarm();
    });

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, "board deleted");
      } catch {
        // A failed close must not abort closing remaining sockets.
      }
    }

    let cursor: string | undefined;
    do {
      const listed = await this.attachmentBucket.list({
        prefix: `${boardId}/`,
        cursor,
      });
      if (listed.objects.length > 0) {
        await this.attachmentBucket.delete(listed.objects.map((obj) => obj.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);

    return new Response(null, { status: 204 });
  }

  /** The identity a write-back route reads before and after it talks to GitHub. */
  private readWriteBackCard(cardId: string): Response {
    if (!cardId) {
      return new Response("invalid card id", { status: 400 });
    }
    const card = this.ctx.storage.sql
      .exec<{ id: string; title: string; taskNumber: number }>(
        `SELECT id, title, task_number AS taskNumber
           FROM cards
          WHERE id = ? AND task_number IS NOT NULL AND archived_at IS NULL`,
        cardId,
      )
      .toArray()[0];

    if (!card) {
      return Response.json({ error: "card not found" }, { status: 404 });
    }
    return Response.json({ id: card.id, title: card.title, taskNumber: card.taskNumber } satisfies WriteBackCard);
  }

  private readCardDevelopment(cardId: string): Response {
    const sql = this.ctx.storage.sql;
    const active = sql
      .exec("SELECT 1 FROM cards WHERE id = ? AND task_number IS NOT NULL AND archived_at IS NULL", cardId)
      .toArray().length > 0;
    if (!active) return Response.json({ error: "card not found" }, { status: 404 });
    // `legacy` is for the Worker only: old manual links it should read from GitHub and write back.
    return Response.json({
      pullRequests: readCardPullRequests(sql, cardId),
      branches: readCardBranches(sql, cardId),
      legacy: readLegacyAssociations(sql, cardId),
    });
  }

  private async acceptPullRequestWrite(boardId: string, input: RouteInput<"pullRequestWrite">): Promise<Response> {
    const { changedCardIds, linked } = this.ctx.storage.transactionSync(() =>
      writePullRequest(this.ctx.storage.sql, input),
    );
    // An accepted write is announced; the receiver answers with an authoritative read.
    for (const cardId of changedCardIds) {
      this.broadcast({ type: "github.invalidated", scope: "card", cardId, revision: null });
    }
    const { repositoryId, number } = input.pullRequest;
    await syncPullRequestRoute(this.env, boardId, repositoryId, number, linked);
    return Response.json({ changed: changedCardIds.length > 0 });
  }

  private async acceptBranchWrite(boardId: string, input: RouteInput<"branchWrite">): Promise<Response> {
    const { changedCardIds, linked } = this.ctx.storage.transactionSync(() => writeBranch(this.ctx.storage.sql, input));
    for (const cardId of changedCardIds) {
      this.broadcast({ type: "github.invalidated", scope: "card", cardId, revision: null });
    }
    await syncBranchRoute(this.env, boardId, input.repositoryId, input.name, linked);
    return Response.json({ changed: changedCardIds.length > 0 });
  }

  /** A member links a pull request by hand (POST) or unlinks one (DELETE), on the boundary the dispatcher admitted, after the Worker's GitHub round trip. */
  private async changePullRequestLink(
    boardId: string,
    cardId: string,
    change: RouteInput<"pullRequestLink"> | RouteInput<"pullRequestUnlink">,
  ): Promise<Response> {
    const outcome = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const refusal = linkChangeRefusal(sql, cardId);
      if (refusal) return refusal;
      if ("pullRequest" in change) {
        const { pullRequest } = change;
        const { changed } = linkPullRequestToCard(sql, cardId, pullRequest);
        return { status: 200, changed, linked: true, ref: pullRequest } as const;
      }
      const { repositoryId, number } = change;
      const { unlinked, stillLinked } = unlinkPullRequestFromCard(sql, cardId, repositoryId, number);
      if (!unlinked) return { status: 404, code: "not_linked", error: "this card does not link that pull request" } as const;
      return { status: 200, changed: true, linked: stillLinked, ref: { repositoryId, number } } as const;
    });
    if (outcome.status !== 200) {
      return Response.json({ code: outcome.code, error: outcome.error }, { status: outcome.status });
    }
    if (outcome.changed) this.broadcast({ type: "github.invalidated", scope: "card", cardId, revision: null });
    await syncPullRequestRoute(this.env, boardId, outcome.ref.repositoryId, outcome.ref.number, outcome.linked);
    const sql = this.ctx.storage.sql;
    return Response.json({ pullRequests: readCardPullRequests(sql, cardId), branches: readCardBranches(sql, cardId) } satisfies CardDevelopment);
  }

  /** A member unlinks a branch by hand. Branches are linked by name only, so there is no link counterpart. */
  private async unlinkBranch(boardId: string, cardId: string, input: RouteInput<"branchUnlink">): Promise<Response> {
    const { repositoryId, name } = input;
    const outcome = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const refusal = linkChangeRefusal(sql, cardId);
      if (refusal) return refusal;
      const { unlinked, stillLinked } = unlinkBranchFromCard(sql, cardId, repositoryId, name);
      if (!unlinked) return { status: 404, code: "not_linked", error: "this card does not link that branch" } as const;
      return { status: 200, stillLinked } as const;
    });
    if (outcome.status !== 200) {
      return Response.json({ code: outcome.code, error: outcome.error }, { status: outcome.status });
    }
    this.broadcast({ type: "github.invalidated", scope: "card", cardId, revision: null });
    await syncBranchRoute(this.env, boardId, repositoryId, name, outcome.stillLinked);
    const sql = this.ctx.storage.sql;
    return Response.json({ pullRequests: readCardPullRequests(sql, cardId), branches: readCardBranches(sql, cardId) } satisfies CardDevelopment);
  }

  private readAttachmentKey(attId: string): Response {
    if (!ATTACHMENT_ID.test(attId)) return new Response("not found", { status: 404 });
    const row = this.ctx.storage.sql
      .exec<{ object_key: string | null }>(
        "SELECT object_key FROM attachments WHERE id = ?",
        attId,
      )
      .toArray()[0];
    if (row && row.object_key) {
      return Response.json({ objectKey: row.object_key });
    }
    const stagedRow = this.ctx.storage.sql
      .exec<{ object_key: string }>(
        "SELECT object_key FROM attachment_cleanup WHERE attachment_id = ? AND reason = 'staged' AND delete_after > ? AND claim_token IS NULL AND deleted_at IS NULL",
        attId,
        Date.now(),
      )
      .toArray()[0];
    if (stagedRow && stagedRow.object_key) {
      return Response.json({ objectKey: stagedRow.object_key });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Staging writes durable state, so it is admitted on the same boundary as every
   * other write, and on the uploader's access as it stands now: the upload route
   * may have spent a long time buffering the body first, and the D1 verdict itself
   * can be answered after a prepare landed.
   */
  private async stageAttachment(boardId: string, input: RouteInput<"attachmentStage">): Promise<Response> {
    const attachmentId = input.id;
    let objectKey = attachmentObjectKey(boardId, attachmentId);
    if (typeof input.objectKey === "string" && input.objectKey.startsWith(`${boardId}/`)) {
      objectKey = input.objectKey;
    }

    const existingConflict = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM attachment_cleanup
          WHERE object_key = ?
            AND (claim_token IS NOT NULL OR deleted_at IS NOT NULL OR reason = 'deleted')`,
        objectKey,
      )
      .toArray()[0]?.count ?? 0;
    if (existingConflict > 0) {
      return Response.json(
        { error: "attachment object is currently being collected" },
        { status: 409 },
      );
    }

    const deleteAfter = Date.now() + STAGED_ATTACHMENT_TTL_MS;
    // Schedule before persisting the lease. If the event dies between these
    // operations, an empty alarm is harmless; the reverse order could strand
    // a lease forever.
    await this.scheduleAlarmAt(deleteAfter);
    this.ctx.storage.sql.exec(
      `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after)
       VALUES (?, ?, 'staged', ?)
       ON CONFLICT(object_key) DO UPDATE SET
         attachment_id = excluded.attachment_id,
         reason = excluded.reason,
         delete_after = excluded.delete_after
       WHERE attachment_cleanup.claim_token IS NULL
         AND attachment_cleanup.deleted_at IS NULL
         AND attachment_cleanup.reason = 'staged'`,
      objectKey,
      attachmentId,
      deleteAfter,
    );
    return new Response(null, { status: 204 });
  }

  private async reconcileAttachments(boardId: string, input: RouteInput<"attachmentsReconcile">): Promise<Response> {
    const items: { objectKey: string; attachmentId: string }[] = [];
    const seenKeys = new Set<string>();

    const rawObj = input;
    if ("objects" in rawObj && Array.isArray(rawObj.objects)) {
      for (const obj of rawObj.objects) {
        if (
          typeof obj === "object" &&
          obj !== null &&
          "key" in obj &&
          "attachmentId" in obj &&
          typeof obj.key === "string" &&
          typeof obj.attachmentId === "string"
        ) {
          const parsed = parseAttachmentObjectKey(obj.key);
          if (parsed && parsed.boardId === boardId && parsed.attachmentId === obj.attachmentId) {
            if (!seenKeys.has(obj.key)) {
              seenKeys.add(obj.key);
              items.push({ objectKey: obj.key, attachmentId: obj.attachmentId });
            }
          }
        }
      }
    }

    if (items.length === 0) return Response.json({ queued: 0 });

    const now = Date.now();
    const orphanItems: { objectKey: string; attachmentId: string }[] = [];
    const redeleteItems: { objectKey: string; attachmentId: string }[] = [];

    for (const item of items) {
      const isOwned = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM attachments
             JOIN cards ON cards.id = attachments.card_id
            WHERE attachments.object_key = ?
               OR (attachments.object_key IS NULL AND attachments.id = ? AND ? = ?)`,
          item.objectKey,
          item.attachmentId,
          item.objectKey,
          attachmentObjectKey(boardId, item.attachmentId),
        )
        .toArray()[0]?.count ?? 0;

      if (isOwned > 0) continue;

      if (this.isStagedLease(item.objectKey, now)) continue;

      const isTombstone = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM attachment_cleanup
            WHERE object_key = ?
              AND deleted_at IS NOT NULL`,
          item.objectKey,
        )
        .toArray()[0]?.count ?? 0;

      if (isTombstone > 0) {
        redeleteItems.push(item);
        continue;
      }

      orphanItems.push(item);
    }

    if (orphanItems.length > 0 || redeleteItems.length > 0) {
      this.ctx.storage.setAlarm(now);
      for (const item of orphanItems) {
        this.ctx.storage.sql.exec(
          `INSERT INTO attachment_cleanup(
             object_key, attachment_id, reason, delete_after
           ) VALUES (?, ?, 'deleted', 0)
           ON CONFLICT(object_key) DO UPDATE SET
             reason = 'deleted',
             delete_after = 0
           WHERE attachment_cleanup.claim_token IS NULL
             AND attachment_cleanup.deleted_at IS NULL`,
          item.objectKey,
          item.attachmentId,
        );
      }
      for (const item of redeleteItems) {
        this.ctx.storage.sql.exec(
          `UPDATE attachment_cleanup
              SET delete_after = ?,
                  reason = 'deleted'
            WHERE object_key = ?
              AND deleted_at IS NOT NULL`,
          now,
          item.objectKey,
        );
      }
      this.ctx.waitUntil(this.drainAttachmentCleanup());
    }
    return Response.json({ queued: orphanItems.length + redeleteItems.length });
  }

  private readTransferOptions(): Response {
    const columns = this.ctx.storage.sql
      .exec<Pick<Column, "id" | "title" | "position">>("SELECT id, title, position FROM columns ORDER BY position, id")
      .toArray();
    return Response.json({ columns });
  }

  /**
   * The dispatcher has admitted the actor already, to fail fast on one the board no
   * longer admits; the binding verdict is the second admission below, taken after every
   * await and right before the lock.
   */
  private async prepareTransfer(
    boardId: string,
    userId: string,
    input: RouteInput<"transferPrepare">,
  ): Promise<Response> {
    const { transferId, cardId, destinationBoardId } = input;
    const now = Date.now();

    // Check if this transferId is already bound in operations history
    const existingOp = this.ctx.storage.sql
      .exec<{
        cardId: string;
        destinationBoardId: string;
        state: string;
      }>(
        `SELECT card_id AS cardId, destination_board_id AS destinationBoardId, state
           FROM card_transfer_operations
          WHERE transfer_id = ?`,
        transferId,
      )
      .toArray()[0];
    if (existingOp) {
      if (existingOp.cardId !== cardId) {
        return Response.json({ error: "transfer id already used for another card", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
      }
      if (existingOp.destinationBoardId !== destinationBoardId) {
        return Response.json({ error: "transfer id cannot change destination board", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
      }
      if (existingOp.state === "finalized" || existingOp.state === "aborted") {
        return Response.json({ error: "transfer id already used for a terminated transfer", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
      }
    }

    // Check if this transferId is already bound to another card or destination in active locks
    const existingByTransferId = this.ctx.storage.sql
      .exec<{ card_id: string; destination_board_id: string }>(
        "SELECT card_id, destination_board_id FROM card_transfer_locks WHERE transfer_id = ?",
        transferId,
      )
      .toArray()[0];
    if (existingByTransferId) {
      if (existingByTransferId.card_id !== cardId) {
        return Response.json({ error: "transfer id already used for another card", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
      }
      if (
        existingByTransferId.destination_board_id &&
        existingByTransferId.destination_board_id !== destinationBoardId
      ) {
        return Response.json({ error: "transfer id cannot change destination board", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
      }
    }

    const existingLock = this.ctx.storage.sql
      .exec<{ transfer_id: string; destination_board_id: string; expires_at: number }>(
        "SELECT transfer_id, destination_board_id, expires_at FROM card_transfer_locks WHERE card_id = ?",
        cardId,
      )
      .toArray()[0];

    if (existingLock && existingLock.transfer_id !== transferId) {
      // Another operation holds the card. Only an expired lock may be taken over,
      // and only once its destination settles it.
      if (existingLock.expires_at > now) {
        return Response.json({ error: "card transfer already in progress" }, { status: 409 });
      }
      if (!existingLock.destination_board_id) {
        await this.recoverExpiredTransferLocks(now);
        const recheckLock = this.ctx.storage.sql
          .exec<{ transfer_id: string }>(
            "SELECT transfer_id FROM card_transfer_locks WHERE card_id = ?",
            cardId,
          )
          .toArray()[0];
        if (recheckLock && recheckLock.transfer_id !== transferId) {
          return Response.json({ error: "card transfer already in progress" }, { status: 409 });
        }
      } else {
        const heldIds = { transferId: existingLock.transfer_id, sourceBoardId: boardId, cardId };
        const outcome = await settle(
          heldIds,
          this.localTransferSource(cardId, existingLock.transfer_id, existingLock.destination_board_id, true),
          [boardDestination(this.env, { ...heldIds, destinationBoardId: existingLock.destination_board_id })],
        );
        // The earlier operation moved the card: there is nothing left to transfer.
        if (outcome.kind === "finalized") return Response.json({ error: "not found" }, { status: 404 });
        if (outcome.kind !== "released" || !outcome.cleared) {
          return Response.json({ error: "card transfer already in progress" }, { status: 409 });
        }
      }
    }

    const expiresAt = now + TRANSFER_LOCK_TTL_MS;
    // Schedule before persisting the lock to durably arrange alarm recovery.
    await this.scheduleAlarmAt(expiresAt);
    // The actor's access is resolved against this board's current generation with
    // no await between the verdict and the synchronous lock write, so a revocation
    // that landed during settlement or scheduling refuses the transfer.
    const admission = await this.admitProtectedPath(boardId, userId);
    if (!admission.admitted) return admission.response;
    try {
      const bundle = this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;

        const cardRow = sql
          .exec<CardRow>(
            `SELECT id, column_id AS columnId, title, description, position,
                    task_number AS taskNumber, subtask_done AS subtaskDone,
                    assignee_id AS assigneeId,
                    priority, task_type AS taskType, due_date AS dueDate, created_at AS createdAt,
                    updated_at AS updatedAt
               FROM cards
              WHERE id = ? AND archived_at IS NULL`,
            cardId,
          )
          .toArray()[0];
        if (!cardRow) {
          return { status: 404, error: "not found" } as const;
        }
        const card: Card = { ...cardRow, subtaskDone: isCompleted(sql, cardRow.columnId) };

        const relationRow = sql
          .exec<{ id: string }>(
            "SELECT id FROM card_relations WHERE source_card_id = ? OR target_card_id = ? LIMIT 1",
            cardId,
            cardId,
          )
          .toArray()[0];
        if (relationRow) {
          return { status: 409, error: "remove card links before transferring" } as const;
        }

        const lockRow = sql
          .exec<{ transfer_id: string; destination_board_id: string }>(
            "SELECT transfer_id, destination_board_id FROM card_transfer_locks WHERE card_id = ?",
            cardId,
          )
          .toArray()[0];
        if (lockRow) {
          if (lockRow.transfer_id !== transferId) {
            return { status: 409, error: "card transfer already in progress" } as const;
          }
          if (lockRow.destination_board_id && lockRow.destination_board_id !== destinationBoardId) {
            return { status: 409, error: "transfer id cannot change destination board", code: TRANSFER_TERMINAL_CODE } as const;
          }
        }

        const existingOpInTx = sql
          .exec<{ card_id: string; destination_board_id: string; state: string; generation: number }>(
            "SELECT card_id, destination_board_id, state, generation FROM card_transfer_operations WHERE transfer_id = ?",
            transferId,
          )
          .toArray()[0];
        if (existingOpInTx) {
          if (existingOpInTx.card_id !== cardId || existingOpInTx.destination_board_id !== destinationBoardId) {
            return { status: 409, error: "transfer id already used for another transfer", code: TRANSFER_TERMINAL_CODE } as const;
          }
          if (existingOpInTx.state === "finalized" || existingOpInTx.state === "aborted") {
            return { status: 409, error: "transfer id already used for a terminated transfer", code: TRANSFER_TERMINAL_CODE } as const;
          }
        }

        const maxGenRow = sql
          .exec<{ maxGen: number | null }>(
            "SELECT MAX(generation) AS maxGen FROM card_transfer_operations WHERE card_id = ?",
            cardId,
          )
          .toArray()[0];
        const generation = existingOpInTx ? existingOpInTx.generation : ((maxGenRow?.maxGen ?? 0) + 1);

        sql.exec(
          `INSERT INTO card_transfer_operations(transfer_id, card_id, destination_board_id, generation, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'prepared', ?, ?)
           ON CONFLICT(transfer_id) DO UPDATE SET
             updated_at = excluded.updated_at`,
          transferId,
          cardId,
          destinationBoardId,
          generation,
          now,
          now,
        );

        sql.exec(
          `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at, generation)
           VALUES (?, ?, ?, 'prepared', ?, ?)
           ON CONFLICT(card_id) DO UPDATE SET
             destination_board_id = CASE
               WHEN card_transfer_locks.destination_board_id = '' THEN excluded.destination_board_id
               ELSE card_transfer_locks.destination_board_id
             END,
             phase = excluded.phase,
             expires_at = excluded.expires_at,
             generation = excluded.generation`,
          cardId,
          transferId,
          destinationBoardId,
          expiresAt,
          generation,
        );

        const checklistItems = sql
          .exec<Omit<ChecklistItem, "done"> & { done: number }>(
            "SELECT id, card_id AS cardId, text, done, position FROM checklist_items WHERE card_id = ? ORDER BY position, id",
            cardId,
          )
          .toArray()
          .map((item) => ({ ...item, done: item.done === 1 }));

        const attachments = sql
          .exec<{
            id: string;
            cardId: string;
            fileName: string;
            contentType: string;
            size: number;
            objectKey: string;
          }>(
            `SELECT id, card_id AS cardId, file_name AS fileName,
                    content_type AS contentType, size,
                    COALESCE(object_key, ? || '/' || id) AS objectKey
               FROM attachments
              WHERE card_id = ?
              ORDER BY id`,
            boardId,
            cardId,
          )
          .toArray();

        const comments = readCardComments(sql, cardId);

        const activities = sql
          .exec<{
            id: string;
            cardId: string;
            actorId: string;
            sequence: number;
            createdAt: number;
            detailJson: string;
          }>(
            `SELECT id, card_id AS cardId, actor_id AS actorId, sequence,
                    created_at AS createdAt, detail_json AS detailJson
               FROM activities
              WHERE card_id = ?
              ORDER BY sequence`,
            cardId,
          )
          .toArray()
          .map((row) => ({
            id: row.id,
            cardId: row.cardId,
            actorId: row.actorId,
            sequence: row.sequence,
            createdAt: row.createdAt,
            detail: JSON.parse(row.detailJson),
          }));

        const labels = sql
          .exec<{
            id: string;
            name: string;
            color: LabelColor;
            joinId: string;
          }>(
            `SELECT labels.id AS id, labels.name AS name, labels.color AS color,
                    card_labels.id AS joinId
               FROM card_labels
               JOIN labels ON labels.id = card_labels.label_id
              WHERE card_labels.card_id = ?
              ORDER BY labels.name, labels.id`,
            cardId,
          )
          .toArray();

        const pullRequestRow = sql
          .exec<{ repositoryId: number; number: number; revision: string }>(
            `SELECT repository_id AS repositoryId, pull_number AS number, revision
               FROM card_github_pull_requests
              WHERE card_id = ?`,
            cardId,
          )
          .toArray()[0];
        const pulledAssociation = CardPullRequestRowSchema.safeParse(pullRequestRow);

        const bundleResult: PreparedCardTransferBundle = {
          card,
          checklistItems,
          attachments,
          comments,
          activities,
          labels,
          pullRequestAssociation: pulledAssociation.success ? pulledAssociation.data : null,
          developmentPullRequests: readCardPullRequests(sql, cardId),
          developmentBranches: readCardBranchesForTransfer(sql, cardId),
          developmentUnlinks: readCardUnlinks(sql, cardId),
        };
        return { status: 200, bundle: bundleResult } as const;
      });

      if (bundle.status !== 200) {
        return Response.json(
          { error: bundle.error, ...(bundle.code ? { code: bundle.code } : {}) },
          { status: bundle.status },
        );
      }
      return Response.json({ bundle: bundle.bundle });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "could not prepare transfer" },
        { status: 500 },
      );
    }
  }

  private async importTransfer(
    boardId: string,
    userId: string,
    input: RouteInput<"transferImport">,
  ): Promise<Response> {
    const { transferId, sourceBoardId, destinationColumnId, bundle } = input;
    const assigneeId = input.assigneeId ?? null;
    // The webhook router must know this board before the card arrives: a transferred
    // card's PR or branch text names the old board's key, so the pointer is its only way in. Written
    // first so a D1 failure fails the import cleanly; a pointer to an import that never
    // commits is harmless, the next event for that PR or branch drops it. Before admission, which
    // must stay right against the transaction.
    try {
      await Promise.all([
        ...bundle.developmentPullRequests.map((pr) => syncPullRequestRoute(this.env, boardId, pr.repositoryId, pr.number, true)),
        ...bundle.developmentBranches.map((branch) => syncBranchRoute(this.env, boardId, branch.repositoryId, branch.name, true)),
      ]);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "could not route pull requests and branches" }, { status: 500 });
    }
    // Admission comes after the body so no await separates the verdict from the
    // synchronous import transaction.
    const admission = await this.admitProtectedPath(boardId, userId);
    if (!admission.admitted) return admission.response;
    try {
      const importOutcome = this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;

        const existingReceipt = sql
          .exec<CardTransferReceipt>(
            `SELECT source_board_id AS sourceBoardId, card_id AS cardId,
                    transfer_id AS transferId, task_number AS taskNumber
               FROM card_transfer_receipts
              WHERE transfer_id = ?`,
            transferId,
          )
          .toArray()[0];
        if (existingReceipt) {
          if (
            existingReceipt.sourceBoardId !== sourceBoardId ||
            existingReceipt.cardId !== bundle.card.id
          ) {
            throw new ImportConflictError(409, "transfer id already used for another transfer", TRANSFER_TERMINAL_CODE);
          }
          if (existingReceipt.taskNumber < 0) {
            throw new ImportConflictError(409, "transfer operation was aborted", TRANSFER_TERMINAL_CODE);
          }
          return { status: 200, receipt: existingReceipt, existingReceipt: true } as const;
        }

        const existingCard = sql
          .exec<{ id: string }>(
            "SELECT id FROM cards WHERE id = ?",
            bundle.card.id,
          )
          .toArray()[0];
        if (existingCard) {
          throw new ImportConflictError(409, "card already exists on destination board");
        }

        const column = sql
          .exec<{ id: string }>("SELECT id FROM columns WHERE id = ?", destinationColumnId)
          .toArray()[0];
        if (!column) {
          throw new ImportConflictError(400, "destination column not found");
        }

        const nowMs = Date.now();
        const resolvedDestKeys = new Map<string, string>();
        for (const att of bundle.attachments) {
          const transferKey = attachmentTransferObjectKey(boardId, transferId, att.id);
          if (this.isStagedLease(transferKey, nowMs)) {
            resolvedDestKeys.set(att.id, transferKey);
          } else {
            const legacyKey = attachmentObjectKey(boardId, att.id);
            if (this.isStagedLease(legacyKey, nowMs)) {
              resolvedDestKeys.set(att.id, legacyKey);
            } else {
              throw new ImportConflictError(409, "attachment staging lease expired before import");
            }
          }
        }
        const destinationCards = sql
          .exec<{ position: string }>(
            "SELECT position FROM cards WHERE column_id = ? AND archived_at IS NULL ORDER BY position, id",
            destinationColumnId,
          )
          .toArray();
        const lastPosition = destinationCards.at(-1)?.position ?? null;
        const position = generateKeyBetween(lastPosition, null);

        const taskNumber = allocateTaskNumber(sql);

        sql.exec(
          `INSERT INTO cards(id, column_id, title, description, position,
                             task_number, subtask_done, assignee_id, priority, task_type, due_date,
                             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bundle.card.id,
          destinationColumnId,
          bundle.card.title,
          bundle.card.description,
          position,
          taskNumber,
          bundle.card.subtaskDone ? 1 : 0,
          assigneeId,
          bundle.card.priority,
          bundle.card.taskType === "subtask" ? "task" : bundle.card.taskType,
          bundle.card.dueDate ?? null,
          bundle.card.createdAt,
          bundle.card.updatedAt,
        );

        for (const item of bundle.checklistItems) {
          sql.exec(
            `INSERT INTO checklist_items(id, card_id, text, done, position)
             VALUES (?, ?, ?, ?, ?)`,
            item.id,
            bundle.card.id,
            item.text,
            item.done ? 1 : 0,
            item.position,
          );
        }

        for (const att of bundle.attachments) {
          const destObjectKey = resolvedDestKeys.get(att.id)!;
          sql.exec(
            "DELETE FROM attachment_cleanup WHERE object_key = ? AND reason = 'staged' AND claim_token IS NULL AND deleted_at IS NULL",
            destObjectKey,
          );
          sql.exec(
            `INSERT INTO attachments(id, card_id, file_name, content_type, size, object_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
            att.id,
            bundle.card.id,
            att.fileName,
            att.contentType,
            att.size,
            destObjectKey,
          );
        }

        for (const comment of bundle.comments) {
          sql.exec(
            `INSERT INTO comments(id, card_id, author_id, parent_comment_id, deleted, body, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            comment.id,
            bundle.card.id,
            comment.authorId,
            comment.parentCommentId,
            comment.deleted ? 1 : 0,
            comment.body,
            comment.createdAt,
            comment.updatedAt,
          );
        }

        for (const act of bundle.activities) {
          sql.exec(
            `INSERT INTO activities(id, card_id, actor_id, detail_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            act.id,
            bundle.card.id,
            act.actorId,
            JSON.stringify(act.detail),
            act.createdAt,
          );
        }

        const existingLabels = sql
          .exec<Label>("SELECT id, name, color FROM labels")
          .toArray();

        for (const srcLabel of bundle.labels) {
          const match = existingLabels.find(
            (l) => l.name === srcLabel.name && l.color === srcLabel.color,
          );
          let targetLabelId: string;
          if (match) {
            targetLabelId = match.id;
          } else {
            targetLabelId = crypto.randomUUID();
            sql.exec(
              "INSERT INTO labels(id, name, color) VALUES (?, ?, ?)",
              targetLabelId,
              srcLabel.name,
              srcLabel.color,
            );
            existingLabels.push({
              id: targetLabelId,
              name: srcLabel.name,
              color: srcLabel.color,
            });
          }
          const freshJoinId = crypto.randomUUID();
          sql.exec(
            "INSERT INTO card_labels(id, card_id, label_id) VALUES (?, ?, ?)",
            freshJoinId,
            bundle.card.id,
            targetLabelId,
          );
        }

        // The link travels with the card. A fresh revision marks the destination's
        // own identity for it; a link naming another repository stays dormant.
        if (bundle.pullRequestAssociation) {
          sql.exec(
            `INSERT INTO card_github_pull_requests(card_id, repository_id, pull_number, revision)
             VALUES (?, ?, ?, ?)`,
            bundle.card.id,
            bundle.pullRequestAssociation.repositoryId,
            bundle.pullRequestAssociation.number,
            crypto.randomUUID(),
          );
        }
        importCardPullRequests(sql, bundle.card.id, bundle.developmentPullRequests);
        importCardBranches(sql, bundle.card.id, bundle.developmentBranches);
        importCardUnlinks(sql, bundle.card.id, bundle.developmentUnlinks);

        sql.exec(
          `INSERT INTO card_transfer_receipts(transfer_id, source_board_id, card_id, task_number)
           VALUES (?, ?, ?, ?)`,
          transferId,
          sourceBoardId,
          bundle.card.id,
          taskNumber,
        );

        const newReceipt: CardTransferReceipt = {
          sourceBoardId,
          cardId: bundle.card.id,
          transferId,
          taskNumber,
        };
        return { status: 200, receipt: newReceipt, existingReceipt: false } as const;
      });


      // Re-asserts the pointers written above, in case an event for one of these PRs or branches
      // arrived in between and dropped it while the card was not here yet.
      this.ctx.waitUntil(this.settleDevelopmentRoutes({ pullRequests: bundle.developmentPullRequests, branches: bundle.developmentBranches }));

      // A replay changed nothing, so live sockets have nothing to learn: a snapshot would read to them as a reconnect.
      if (!importOutcome.existingReceipt) this.broadcast(this.snapshot());

      return Response.json({ receipt: importOutcome.receipt, existingReceipt: importOutcome.existingReceipt });
    } catch (err) {
      if (err instanceof ImportConflictError) {
        return Response.json(
          { error: err.message, ...(err.code ? { code: err.code } : {}) },
          { status: err.status },
        );
      }
      return Response.json(
        { error: err instanceof Error ? err.message : "could not import card" },
        { status: 500 },
      );
    }
  }

  private async finalizeTransfer(input: RouteInput<"transferFinalize">): Promise<Response> {
    const { transferId, cardId, destinationBoardId } = input;
    try {
      const outcome = this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;

        const op = sql
          .exec<{
            cardId: string;
            destinationBoardId: string;
            generation: number;
            state: string;
          }>(
            `SELECT card_id AS cardId, destination_board_id AS destinationBoardId,
                    generation, state
               FROM card_transfer_operations
              WHERE transfer_id = ?`,
            transferId,
          )
          .toArray()[0];

        if (op) {
          if (op.cardId !== cardId) {
            return { status: 409, error: "transfer operation identity mismatch", code: TRANSFER_TERMINAL_CODE } as const;
          }
          if (destinationBoardId && op.destinationBoardId !== destinationBoardId) {
            return { status: 409, error: "transfer destination board mismatch", code: TRANSFER_TERMINAL_CODE } as const;
          }
          if (op.state === "finalized") {
            return { status: 200, absent: true } as const;
          }
          if (op.state === "aborted") {
            return { status: 410, error: "transfer operation was aborted", code: TRANSFER_TERMINAL_CODE } as const;
          }
        }

        const card = sql
          .exec<{ id: string }>("SELECT id FROM cards WHERE id = ?", cardId)
          .toArray()[0];
        if (!card) {
          sql.exec("DELETE FROM card_transfer_locks WHERE card_id = ? AND transfer_id = ?", cardId, transferId);
          if (op) {
            sql.exec("UPDATE card_transfer_operations SET state = 'finalized', updated_at = ? WHERE transfer_id = ?", Date.now(), transferId);
          }
          return { status: 200, absent: true } as const;
        }

        const lock = sql
          .exec<{ transfer_id: string; destination_board_id: string; generation: number }>(
            "SELECT transfer_id, destination_board_id, generation FROM card_transfer_locks WHERE card_id = ?",
            cardId,
          )
          .toArray()[0];
        if (!lock || lock.transfer_id !== transferId) {
          return { status: 409, error: "transfer lock mismatch", code: TRANSFER_TERMINAL_CODE } as const;
        }
        if (destinationBoardId && lock.destination_board_id && lock.destination_board_id !== destinationBoardId) {
          return { status: 409, error: "transfer destination board mismatch", code: TRANSFER_TERMINAL_CODE } as const;
        }
        if (op && lock.generation !== op.generation) {
          return { status: 409, error: "transfer generation mismatch", code: TRANSFER_TERMINAL_CODE } as const;
        }

        this.deleteCardAggregate([cardId]);
        sql.exec("DELETE FROM card_transfer_locks WHERE card_id = ? AND transfer_id = ?", cardId, transferId);
        if (op) {
          sql.exec("UPDATE card_transfer_operations SET state = 'finalized', updated_at = ? WHERE transfer_id = ?", Date.now(), transferId);
        }
        return { status: 200, absent: false } as const;
      });

      if (outcome.status !== 200) {
        return Response.json(
          { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) },
          { status: outcome.status },
        );
      }

      // The card is gone for good: peers drop it, as for a purge. A snapshot would read to a live socket as a
      // reconnect and mark everyone's pending mutations "could not verify". An already-absent card changed nothing.
      if (!outcome.absent) this.broadcast({ type: "archive.purged", cardIds: [cardId] });

      this.ctx.waitUntil(this.drainAttachmentCleanup());
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "could not finalize transfer" },
        { status: 500 },
      );
    }
  }

  private async releaseTransfer(boardId: string, input: RouteInput<"transferRelease">): Promise<Response> {
    const { transferId, cardId, destinationBoardId } = input;

    const curLock = this.ctx.storage.sql
      .exec<{ transfer_id: string; destination_board_id: string; generation: number }>(
        "SELECT transfer_id, destination_board_id, generation FROM card_transfer_locks WHERE card_id = ?",
        cardId,
      )
      .toArray()[0];

    if (!curLock) return Response.json({ ok: true });

    if (curLock.transfer_id !== transferId) {
      return Response.json({ error: "transfer lock mismatch", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
    }

    const targetDestBoardId = destinationBoardId || curLock.destination_board_id;
    if (!targetDestBoardId) {
      return Response.json(
        { error: "destination board identity unknown; lock retained", code: TRANSFER_TERMINAL_CODE },
        { status: 409 },
      );
    }
    const releaseIds = { transferId, sourceBoardId: boardId, cardId };
    const outcome = await settle(
      releaseIds,
      this.localTransferSource(cardId, transferId, null, true),
      [boardDestination(this.env, { ...releaseIds, destinationBoardId: targetDestBoardId })],
    );
    if (outcome.kind === "finalized") return Response.json({ ok: true, committed: true });
    if (outcome.kind === "released") return Response.json({ ok: true });
    if (outcome.why === "unreachable") {
      return Response.json({ error: "destination unreachable; lock retained" }, { status: 500 });
    }
    if (outcome.why === "mismatch") {
      return Response.json({ error: "destination abort receipt mismatch; lock retained", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
    }
    return Response.json({ error: "destination abort fence failed; lock retained" }, { status: 500 });
  }

  private readTransferReceipt(input: RouteInput<"transferReceipt">): Response {
    const { transferId, sourceBoardId, cardId } = input;
    const receipt = this.ctx.storage.sql
      .exec<CardTransferReceipt>(
        `SELECT source_board_id AS sourceBoardId, card_id AS cardId,
                transfer_id AS transferId, task_number AS taskNumber
           FROM card_transfer_receipts
          WHERE transfer_id = ?`,
        transferId,
      )
      .toArray()[0];
    if (!receipt) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (receipt.sourceBoardId !== sourceBoardId || receipt.cardId !== cardId) {
      return Response.json({ error: "transfer id already used for another transfer", code: TRANSFER_TERMINAL_CODE }, { status: 409 });
    }
    if (receipt.taskNumber < 0) {
      return Response.json({ error: "transfer operation was aborted", aborted: true, code: TRANSFER_TERMINAL_CODE }, { status: 410 });
    }
    return Response.json({ receipt });
  }

  private abortTransfer(input: RouteInput<"transferAbort">): Response {
    const { transferId, sourceBoardId, cardId } = input;
    const outcome = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const receipt = sql
        .exec<CardTransferReceipt>(
          `SELECT source_board_id AS sourceBoardId, card_id AS cardId,
                  transfer_id AS transferId, task_number AS taskNumber
             FROM card_transfer_receipts
            WHERE transfer_id = ?`,
          transferId,
        )
        .toArray()[0];

      if (receipt) {
        if (receipt.sourceBoardId !== sourceBoardId || receipt.cardId !== cardId) {
          return { status: 409, error: "transfer id already used for another transfer", code: TRANSFER_TERMINAL_CODE } as const;
        }
        if (receipt.taskNumber >= 0) {
          return { status: 200, committed: true, receipt } as const;
        }
        return { status: 200, committed: false, aborted: true, receipt } as const;
      }

      sql.exec(
        `INSERT INTO card_transfer_receipts(transfer_id, source_board_id, card_id, task_number)
         VALUES (?, ?, ?, -1)`,
        transferId,
        sourceBoardId,
        cardId,
      );
      const newReceipt: CardTransferReceipt = {
        sourceBoardId,
        cardId,
        transferId,
        taskNumber: -1,
      };
      return { status: 200, committed: false, aborted: true, receipt: newReceipt } as const;
    });
    if (outcome.status !== 200) {
      return Response.json(
        { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) },
        { status: outcome.status },
      );
    }
    return Response.json(outcome);
  }

  /** The realtime socket: a plain upgrade request for any path the table does not own. */
  private async acceptSocket(request: Request, boardId: string | null, userId: string | null): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    if (userId === null || userId.length === 0 || userId.length > 64) {
      return new Response("invalid user id", { status: 400 });
    }
    if (boardId === null || !ATTACHMENT_BOARD_ID.test(boardId)) {
      return new Response("invalid board id", { status: 400 });
    }
    // Fail fast on a board whose access is already changing, then confirm the same
    // boundary after the identity read: the two reads must agree, or this socket
    // would be accepted against a policy that moved while it waited.
    const before = this.policyBoundary();
    if (!before || before.frozen === 1 || before.pendingOperationId !== null)
      return this.accessChangingResponse();
    const access = await this.currentBoardAccess(boardId, userId);
    if (access.kind === "transition") return this.accessChangingResponse();
    if (access.kind === "denied") return new Response("forbidden", { status: 403 });
    const after = this.policyBoundary();
    if (
      !after ||
      after.frozen === 1 ||
      after.pendingOperationId !== null ||
      after.generation !== before.generation
    )
      return this.accessChangingResponse();

    // The Worker's header is the capability it decided with, and the DO requires
    // its own later verdict as well: a header that outlived a demotion cannot hand
    // management back to a user who no longer has it.
    const canManageColumns =
      access.canManageColumns &&
      request.headers.get(INTERNAL_CAN_MANAGE_COLUMNS_HEADER) === "true";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, boardId, canManageColumns, isAdmin: access.operator, generation: after.generation, protocolVersion: REALTIME_PROTOCOL_VERSION, sessionHash: sessionHashOf(request.headers) });
    this.send(server, this.snapshot());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.recoverExpiredTransferLocks(now);
    const cardIds = this.purgeExpiredArchivedCards(now);
    if (cardIds.length > 0) {
      this.broadcast({ type: "archive.purged", cardIds });
    }

    // Inserting a receipt schedules an alarm for its expiry, and this reschedules for the oldest one left below, so a quiet board still prunes them.
    // shortcut: a full scan, since the table is keyed by credential and operation key; index created_at if a board ever holds enough receipts to notice.
    this.ctx.storage.sql.exec("DELETE FROM mcp_operation_receipts WHERE created_at <= ?", now - MCP_RECEIPT_RETENTION_MS);

    const drained = await this.drainAttachmentCleanup();
    // A failed R2 delete already scheduled its own retry, and counting the rows still due behind it would spin
    // the alarm, so a lease only sets the next wake-up after a clean drain.
    const nextAttachment = drained ? this.nextAttachmentWake() : null;
    const nextArchive = this.ctx.storage.sql
      .exec<{ expireAt: number | null }>(
        "SELECT MIN(archived_at + ?) AS expireAt FROM cards WHERE archived_at IS NOT NULL",
        CARD_ARCHIVE_RETENTION_MS,
      )
      .toArray()[0]?.expireAt;
    const idObj: unknown = this.ctx.id;
    const ctxName = idObj && typeof idObj === "object" && "name" in idObj && typeof idObj.name === "string" ? idObj.name : undefined;
    const hasBoardId = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM meta WHERE key = 'board_id'")
      .toArray()[0]?.count ?? 0;
    const canRecover = hasBoardId > 0 || (ctxName !== undefined && ATTACHMENT_BOARD_ID.test(ctxName));

    const nextLock = this.ctx.storage.sql
      .exec<{ expireAt: number | null }>(
        canRecover
          ? "SELECT MIN(expires_at) AS expireAt FROM card_transfer_locks"
          : "SELECT MIN(expires_at) AS expireAt FROM card_transfer_locks WHERE expires_at > ?",
        ...(canRecover ? [] : [now]),
      )
      .toArray()[0]?.expireAt;

    // Everything due was just deleted, so the oldest receipt left expires strictly later and this cannot spin.
    const nextReceipt = this.ctx.storage.sql
      .exec<{ expireAt: number | null }>("SELECT MIN(created_at) + ? AS expireAt FROM mcp_operation_receipts", MCP_RECEIPT_RETENTION_MS)
      .toArray()[0]?.expireAt;

    const candidates = [nextAttachment, nextArchive, nextLock, nextReceipt].filter((at): at is number => at !== null && at !== undefined);
    if (candidates.length > 0) {
      await this.scheduleAlarmAt(Math.max(Date.now(), Math.min(...candidates)));
    }
  }

  /** This board's own id, recorded in meta so cross-board settlement can name the source. */
  private transferBoardId(): string | undefined {
    let thisBoardId = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'")
      .toArray()[0]?.value;

    if (!thisBoardId) {
      const idObj: unknown = this.ctx.id;
      const ctxName = idObj && typeof idObj === "object" && "name" in idObj && typeof idObj.name === "string" ? idObj.name : undefined;
      if (ctxName && ATTACHMENT_BOARD_ID.test(ctxName)) {
        thisBoardId = ctxName;
        this.ctx.storage.sql.exec(
          `INSERT INTO meta(key, value) VALUES ('board_id', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          thisBoardId,
        );
      }
    }
    return thisBoardId;
  }

  private async recoverExpiredTransferLocks(now: number): Promise<void> {
    const thisBoardId = this.transferBoardId();

    const expiredLocks = this.ctx.storage.sql
      .exec<TransferLock>(
        `SELECT card_id AS cardId, transfer_id AS transferId, destination_board_id AS destinationBoardId
           FROM card_transfer_locks
          WHERE expires_at <= ?
          LIMIT 50`,
        now,
      )
      .toArray();

    // Without knowing this board's ID, automatic cross-board recovery cannot safely query
    // candidate destinations or establish abort fences.
    // We MUST NOT silently unlock or advance expires_at in an indefinite spin.
    // The lock remains in place (preserving source write fencing) until a request visits
    // this board and populates meta.board_id, establishing deterministic wake-up.
    if (expiredLocks.length === 0 || !thisBoardId) return;

    for (const lock of expiredLocks) await this.settleTransferLock(lock, thisBoardId, now);
  }

  /**
   * Settles one outbound transfer lock against its destination: a committed
   * destination finalizes (the source card is deleted), an aborted one releases the
   * lock. Anything unresolved keeps the lock with a bounded retry delay and answers
   * `"retry"`. Shared by alarm recovery and the access-change fence.
   */
  private async settleTransferLock(
    lock: TransferLock,
    thisBoardId: string,
    now: number,
    broadcast = true,
  ): Promise<"settled" | "retry"> {
    const ids = { transferId: lock.transferId, sourceBoardId: thisBoardId, cardId: lock.cardId };
    try {
      // A legacy lock has no destination: every other board is a candidate, and their
      // receipts are read before any of them is fenced.
      const destinationIds = lock.destinationBoardId
        ? [lock.destinationBoardId]
        : ((await this.env.DB.prepare("SELECT id FROM boards WHERE id != ?").bind(thisBoardId).all<{ id: string }>()).results ?? []).map((b) => b.id);
      const outcome = await settle(
        ids,
        this.localTransferSource(lock.cardId, lock.transferId, lock.destinationBoardId || null, broadcast),
        destinationIds.map((destinationBoardId) => boardDestination(this.env, { ...ids, destinationBoardId })),
        !lock.destinationBoardId,
      );
      if (outcome.kind !== "retry") return "settled";
    } catch {
      // D1 or local storage error: fall through to the bounded retry.
    }
    // Unresolved: keep the lock and try again after a bounded delay.
    this.ctx.storage.sql.exec(
      "UPDATE card_transfer_locks SET expires_at = ? WHERE card_id = ? AND transfer_id = ?",
      now + TRANSFER_RETRY_DELAY_MS,
      lock.cardId,
      lock.transferId,
    );
    return "retry";
  }

  /**
   * This board as the source participant of `settle`: finalize and release run on
   * local storage, and act only while `transferId` still holds the card's lock (and,
   * when `destinationBoardId` is given, still names that destination). A lock that
   * moved on answers 409 and nothing changes.
   */
  private localTransferSource(
    cardId: string,
    transferId: string,
    destinationBoardId: string | null,
    broadcast: boolean,
  ): Pick<SourceParticipant, "finalize" | "release"> {
    const settleLock = (state: "finalized" | "aborted") =>
      this.ctx.storage.transactionSync(() => {
        const cur = this.ctx.storage.sql
          .exec<{ transfer_id: string; destination_board_id: string }>(
            "SELECT transfer_id, destination_board_id FROM card_transfer_locks WHERE card_id = ?",
            cardId,
          )
          .toArray()[0];
        if (!cur || cur.transfer_id !== transferId) return false;
        if (destinationBoardId !== null && cur.destination_board_id !== destinationBoardId) return false;
        if (state === "finalized") this.deleteCardAggregate([cardId]);
        this.ctx.storage.sql.exec("DELETE FROM card_transfer_locks WHERE card_id = ? AND transfer_id = ?", cardId, transferId);
        this.ctx.storage.sql.exec(
          "UPDATE card_transfer_operations SET state = ?, updated_at = ? WHERE transfer_id = ?",
          state,
          Date.now(),
          transferId,
        );
        return true;
      });
    const answer = (done: boolean) => ({ status: done ? 200 : 409, body: {} });
    return {
      finalize: async () => {
        const done = settleLock("finalized");
        if (done) {
          if (broadcast) this.broadcast({ type: "archive.purged", cardIds: [cardId] });
          this.ctx.waitUntil(this.drainAttachmentCleanup());
        }
        return answer(done);
      },
      release: async () => answer(settleLock("aborted")),
    };
  }

  private async scheduleAlarmAt(at: number): Promise<void> {
    const now = Date.now();
    const normalized = at <= now ? now + 1 : at;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || normalized < scheduled) await this.ctx.storage.setAlarm(normalized);
  }

  private purgeExpiredArchivedCards(now: number): string[] {
    const due = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id
           FROM cards
          WHERE archived_at IS NOT NULL
            AND archived_at + ? <= ?
          ORDER BY archived_at, id
          LIMIT 1000`,
        CARD_ARCHIVE_RETENTION_MS,
        now,
      )
      .toArray();
    if (due.length === 0) return [];

    const cardIds = due.map(({ id }) => id);
    this.ctx.storage.transactionSync(() => {
      this.deleteCardAggregate(cardIds);
    });
    return cardIds;
  }

  private deleteCardAggregate(cardIds: readonly string[]): void {
    this.settleHeldRoutes(deleteCards(this.ctx.storage.sql, cardIds));
  }

  /** Syncs the routing pointers for what a delete held; nothing to settle when it held none. */
  private settleHeldRoutes(held: HeldRoutes): void {
    if (held.pullRequests.length > 0 || held.branches.length > 0) this.ctx.waitUntil(this.settleDevelopmentRoutes(held));
  }

  /**
   * Makes the D1 routing pointers match what this board holds for these pull requests and
   * branches: a pointer while any card links one, none otherwise. It reads the rows after the
   * caller's transaction has settled, so a rolled-back change leaves the pointer alone.
   * Best effort: a stale pointer is dropped by the next event for its PR or branch, and a missing
   * one is re-added by the next event that names one of its cards' keys.
   */
  private async settleDevelopmentRoutes(held: {
    pullRequests: ReadonlyArray<{ repositoryId: number; number: number }>;
    branches: ReadonlyArray<{ repositoryId: number; name: string }>;
  }): Promise<void> {
    await Promise.resolve();
    const sql = this.ctx.storage.sql;
    const boardId = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'").toArray()[0]?.value;
    if (!boardId) return;
    const holds = (table: string, column: string, repositoryId: number, ref: number | string) =>
      sql.exec(`SELECT 1 FROM ${table} WHERE repository_id = ? AND ${column} = ? LIMIT 1`, repositoryId, ref).toArray().length > 0;
    await Promise.allSettled([
      ...held.pullRequests.map(({ repositoryId, number }) =>
        syncPullRequestRoute(this.env, boardId, repositoryId, number, holds("card_development_pull_requests", "number", repositoryId, number)),
      ),
      ...held.branches.map(({ repositoryId, name }) =>
        syncBranchRoute(this.env, boardId, repositoryId, name, holds("card_development_branches", "name", repositoryId, name)),
      ),
    ]);
  }

  /** True while `objectKey` holds a live staging lease: staged, unexpired, unclaimed and not tombstoned. */
  private isStagedLease(objectKey: string, now: number): boolean {
    return (
      (this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM attachment_cleanup
            WHERE object_key = ?
              AND reason = 'staged'
              AND delete_after > ?
              AND claim_token IS NULL
              AND deleted_at IS NULL`,
          objectKey,
          now,
        )
        .toArray()[0]?.count ?? 0) > 0
    );
  }

  /** When the attachment queue next needs the alarm: its earliest pending `delete_after`, or null when nothing is pending. */
  private nextAttachmentWake(): number | null {
    return (
      this.ctx.storage.sql
        .exec<{ deleteAfter: number | null }>(
          `SELECT MIN(delete_after) AS deleteAfter
             FROM attachment_cleanup
            WHERE deleted_at IS NULL
               OR (deleted_at IS NOT NULL AND delete_after > 0)`,
        )
        .toArray()[0]?.deleteAfter ?? null
    );
  }

  private async drainAttachmentCleanup(): Promise<boolean> {
    const now = Date.now();
    // Metadata whose card row is gone owns nothing; deleting it enqueues each object
    // key (delete_after = 0) through attachments_queue_object_delete for this pass.
    // Archived cards still exist, so their attachments are untouched.
    this.ctx.storage.sql.exec("DELETE FROM attachments WHERE card_id NOT IN (SELECT id FROM cards)");
    const due = this.ctx.storage.sql
      .exec<{ objectKey: string; claimToken: string | null; deletedAt: number | null }>(
        `SELECT object_key AS objectKey, claim_token AS claimToken, deleted_at AS deletedAt
           FROM attachment_cleanup
          WHERE (deleted_at IS NULL AND delete_after <= ?)
             OR (deleted_at IS NOT NULL AND delete_after > 0 AND delete_after <= ?)
          ORDER BY delete_after, object_key
          LIMIT 1000`,
        now,
        now,
      )
      .toArray();

    if (due.length > 0) {
      const toDelete: { objectKey: string; claimToken: string }[] = [];
      const obsoleteCleanup: { objectKey: string; claimToken: string | null }[] = [];

      for (const { objectKey, claimToken, deletedAt } of due) {
        const isOwned = this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM attachments JOIN cards ON cards.id = attachments.card_id WHERE attachments.object_key = ?",
            objectKey,
          )
          .toArray()[0]?.count ?? 0;

        if (deletedAt === null && (isOwned > 0 || this.isStagedLease(objectKey, now))) {
          obsoleteCleanup.push({ objectKey, claimToken });
        } else if (claimToken !== null) {
          // Previously claimed row (abandoned claim, retry, or tombstone redelete): keep exact claimToken and retry idempotent R2 delete
          this.ctx.storage.sql.exec(
            "UPDATE attachment_cleanup SET claimed_at = ? WHERE object_key = ? AND claim_token = ?",
            now,
            objectKey,
            claimToken,
          );
          toDelete.push({ objectKey, claimToken });
        } else {
          // Atomically claim exact queue row with token/state before awaiting R2 delete
          const newClaimToken = crypto.randomUUID();
          this.ctx.storage.sql.exec(
            `UPDATE attachment_cleanup
                SET claim_token = ?, claimed_at = ?
              WHERE object_key = ?
                AND delete_after <= ?
                AND claim_token IS NULL`,
            newClaimToken,
            now,
            objectKey,
            now,
          );
          const claimed = this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM attachment_cleanup WHERE object_key = ? AND claim_token = ?",
              objectKey,
              newClaimToken,
            )
            .toArray()[0]?.count ?? 0;
          if (claimed > 0) {
            toDelete.push({ objectKey, claimToken: newClaimToken });
          }
        }
      }

      if (obsoleteCleanup.length > 0) {
        for (const item of obsoleteCleanup) {
          if (item.claimToken !== null) {
            this.ctx.storage.sql.exec(
              "DELETE FROM attachment_cleanup WHERE object_key = ? AND claim_token = ? AND deleted_at IS NULL",
              item.objectKey,
              item.claimToken,
            );
          } else {
            this.ctx.storage.sql.exec(
              "DELETE FROM attachment_cleanup WHERE object_key = ? AND delete_after <= ? AND claim_token IS NULL AND deleted_at IS NULL",
              item.objectKey,
              now,
            );
          }
        }
      }

      if (toDelete.length > 0) {
        try {
          await this.attachmentBucket.delete(toDelete.map((d) => d.objectKey));
        } catch {
          // On delete failure: reschedule claimed row with bounded delay WITHOUT clearing claim_token
          const retryAt = Date.now() + ATTACHMENT_CLEANUP_RETRY_MS;
          for (const item of toDelete) {
            this.ctx.storage.sql.exec(
              `UPDATE attachment_cleanup
                  SET delete_after = ?
                WHERE object_key = ? AND claim_token = ?`,
              retryAt,
              item.objectKey,
              item.claimToken,
            );
          }
          const next = this.ctx.storage.sql
            .exec<{ deleteAfter: number | null }>(
              `SELECT MIN(delete_after) AS deleteAfter
                 FROM attachment_cleanup
                WHERE delete_after > ?
                  AND (deleted_at IS NULL OR (deleted_at IS NOT NULL AND delete_after > 0))`,
              now,
            )
            .toArray()[0]?.deleteAfter;
          const candidates = [retryAt];
          if (next !== null && next !== undefined) {
            candidates.push(next);
          }
          await this.scheduleAlarmAt(Math.max(Date.now(), Math.min(...candidates)));
          return false;
        }
        // After successful delete: leave durable terminal tombstone (do not delete the row)
        for (const item of toDelete) {
          this.ctx.storage.sql.exec(
            `UPDATE attachment_cleanup
                SET deleted_at = COALESCE(deleted_at, ?),
                    reason = 'deleted',
                    delete_after = 0
              WHERE object_key = ?`,
            now,
            item.objectKey,
          );
        }
      }
    }

    const next = this.nextAttachmentWake();
    if (next !== null) {
      await this.scheduleAlarmAt(Math.max(Date.now(), next));
    }
    return true;
  }

  private resolveMcpTaskId(
    task: { id: string } | { key: string },
    board: McpBoardIdentity,
  ): string | null {
    if ("id" in task) return task.id;
    const separator = task.key.lastIndexOf("-");
    const prefix = task.key.slice(0, separator);
    if (prefix !== board.key) throw new MutationRefusal("invalid_task_key", "Task key does not belong to this board.");
    const taskNumber = Number(task.key.slice(separator + 1));
    if (!Number.isSafeInteger(taskNumber) || taskNumber < 1) {
      throw new MutationRefusal("invalid_task_key", "Task key is invalid.");
    }
    return this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM cards WHERE task_number = ?", taskNumber)
      .toArray()[0]?.id ?? null;
  }

  private taskRecord(
    cardId: string,
    board: McpBoardIdentity,
  ): TaskRecord | null {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{
        id: string; columnId: string; title: string; description: string; position: string;
        taskNumber: number; subtaskDone: number; assigneeId: string | null;
        priority: Card["priority"]; taskType: Card["taskType"]; dueDate: string | null;
        createdAt: number; updatedAt: number; archivedAt: number | null;
        archivedColumnTitle: string | null;
      }>(
        `SELECT id, column_id AS columnId, title, description, position,
                task_number AS taskNumber, subtask_done AS subtaskDone,
                assignee_id AS assigneeId, priority, task_type AS taskType, due_date AS dueDate,
                created_at AS createdAt, updated_at AS updatedAt,
                archived_at AS archivedAt, archived_column_title AS archivedColumnTitle
           FROM cards WHERE id = ? AND task_number IS NOT NULL`,
        cardId,
      )
      .toArray()[0];
    if (!row) return null;
    const column =
      sql.exec<{ id: string; title: string }>(
        "SELECT id, title FROM columns WHERE id = ?",
        row.columnId,
      ).toArray()[0] ?? null;
    const key = `${board.key}-${row.taskNumber}`;
    const url = new URL(`/board/${encodeURIComponent(board.key)}`, board.appOrigin);
    url.searchParams.set("card", key);
    if (descriptionByteLength(row.description) > 100_000) {
      throw new MutationRefusal("result_too_large", "Stored task description exceeds the response limit.");
    }
    return TaskRecordSchema.parse({
      id: row.id,
      boardId: board.id,
      taskNumber: row.taskNumber,
      key,
      url: url.toString(),
      title: row.title,
      description: row.description,
      priority: row.priority,
      taskType: row.taskType,
      assigneeId: row.assigneeId,
      dueDate: row.dueDate,
      subtaskDone: row.archivedAt === null ? isCompleted(sql, row.columnId) : row.subtaskDone === 1,
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      storedColumnId: row.columnId,
      effectiveColumnId: row.columnId,
      archivedAt: row.archivedAt,
      archivedColumnTitle: row.archivedColumnTitle,
      column,
    });
  }

  private taskSummary(
    cardId: string,
    board: McpBoardIdentity,
  ): z.infer<typeof TaskSummarySchema> | null {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{
      id: string; columnId: string; title: string; position: string; taskNumber: number;
      subtaskDone: number; assigneeId: string | null; priority: Card["priority"];
      taskType: Card["taskType"]; dueDate: string | null; createdAt: number; updatedAt: number;
      archivedAt: number | null; archivedColumnTitle: string | null;
    }>(
      `SELECT id, column_id AS columnId, title, position, task_number AS taskNumber,
              subtask_done AS subtaskDone, assignee_id AS assigneeId, priority,
              task_type AS taskType, due_date AS dueDate, created_at AS createdAt,
              updated_at AS updatedAt, archived_at AS archivedAt,
              archived_column_title AS archivedColumnTitle
         FROM cards WHERE id = ? AND task_number IS NOT NULL`,
      cardId,
    ).toArray()[0];
    if (!row) return null;
    const key = `${board.key}-${row.taskNumber}`;
    const url = new URL(`/board/${encodeURIComponent(board.key)}`, board.appOrigin);
    url.searchParams.set("card", key);
    return TaskSummarySchema.parse({
      id: row.id, boardId: board.id, taskNumber: row.taskNumber, key, url: url.toString(),
      title: row.title, priority: row.priority, taskType: row.taskType,
      assigneeId: row.assigneeId, dueDate: row.dueDate, subtaskDone: row.archivedAt === null ? isCompleted(sql, row.columnId) : row.subtaskDone === 1,
      position: row.position, createdAt: row.createdAt, updatedAt: row.updatedAt,
      storedColumnId: row.columnId, effectiveColumnId: row.columnId, archivedAt: row.archivedAt,
      archivedColumnTitle: row.archivedColumnTitle,
    });
  }

  private mcpFailure(error: MutationRefusal): McpToolResult {
    return { ok: false, error: { code: error.code, message: error.message, retryable: false } };
  }

  private readMcpBoard(input: z.infer<typeof McpBoardReadRequestSchema>): McpToolResult {
    const limit = input.columns?.limit ?? 50;
    let after: { position: string; id: string } | null = null;
    if (input.columns?.cursor) {
      const cursor = decodeCursor(input.columns.cursor);
      if (
        cursor?.kind !== "columns" || cursor.boardId !== input.board.id ||
        cursor.taskId !== undefined || cursor.filters !== undefined ||
        typeof cursor.after !== "object" || cursor.after === null ||
        Object.keys(cursor.after).length !== 2 ||
        !("position" in cursor.after) || typeof cursor.after.position !== "string" ||
        !("id" in cursor.after) || typeof cursor.after.id !== "string"
      ) throw new MutationRefusal("invalid_cursor", "Column cursor is invalid.");
      after = { position: cursor.after.position, id: cursor.after.id };
    }
    // Label definitions are a board-wide list like columns, so its cursor is bound
    // to this board and to nothing else.
    const labelLimit = input.labels?.limit ?? 50;
    let labelAfter = "";
    if (input.labels?.cursor) {
      const cursor = decodeCursor(input.labels.cursor);
      if (
        cursor?.kind !== "labels" || cursor.boardId !== input.board.id ||
        cursor.taskId !== undefined || cursor.filters !== undefined ||
        typeof cursor.after !== "string"
      ) throw new MutationRefusal("invalid_cursor", "Label cursor is invalid.");
      labelAfter = cursor.after;
    }
    const rows = this.ctx.storage.sql
      .exec<{ id: string; title: string; position: string; starting: number; completed: number }>(
        `SELECT id, title, position, starting, completed FROM columns
          WHERE (? IS NULL OR position > ? OR (position = ? AND id > ?))
          ORDER BY position, id LIMIT ?`,
        after?.position ?? null, after?.position ?? "", after?.position ?? "", after?.id ?? "", limit + 1,
      ).toArray();
    const items = rows.slice(0, limit).map(c => ({ ...c, starting: c.starting === 1, completed: c.completed === 1 }));
    const last = items.at(-1);
    const labelRows = this.ctx.storage.sql
      .exec<Label>(
        "SELECT id, name, color FROM labels WHERE id > ? ORDER BY id LIMIT ?",
        labelAfter, labelLimit + 1,
      ).toArray();
    const labels = labelRows.slice(0, labelLimit);
    const lastLabel = labels.at(-1);
    return {
      ok: true,
      data: {
        id: input.board.id, key: input.board.key, name: input.board.name,
        url: new URL(`/board/${encodeURIComponent(input.board.key)}`, input.board.appOrigin).toString(),
        columns: {
          items,
          nextCursor: rows.length > limit && last
            ? encodeCursor({ v: 1, kind: "columns", boardId: input.board.id, after: { position: last.position, id: last.id } })
            : null,
        },
        labels: {
          items: labels,
          nextCursor: labelRows.length > labelLimit && lastLabel
            ? encodeCursor({ v: 1, kind: "labels", boardId: input.board.id, after: lastLabel.id })
            : null,
        },
      },
    };
  }

  private readMcpTasks(input: z.infer<typeof McpTaskListRequestSchema>): McpToolResult {
    let after = 0;
    const normalizedFilters = {
      query: input.query.trim().toLowerCase(),
      columnId: input.columnId ?? null,
      assignee: input.assigneeId === undefined ? "omitted" : input.assigneeId,
      state: input.state,
    };
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor?.kind !== "tasks" || cursor.boardId !== input.board.id ||
        cursor.taskId !== undefined ||
        JSON.stringify(cursor.filters) !== JSON.stringify(normalizedFilters) ||
        typeof cursor.after !== "number" || !Number.isSafeInteger(cursor.after) || cursor.after < 1
      ) throw new MutationRefusal("invalid_cursor", "Task cursor is invalid.");
      after = cursor.after;
    }
    // state, column and assignee filter exactly in SQL (effectiveColumnId is column_id). The
    // title query stays in JS: SQLite lower() is ASCII-only, so it would differ from toLowerCase.
    // The cursor is lazy, so breaking at limit + 1 reads no further rows.
    const where = ["task_number > ?", "task_number IS NOT NULL"];
    const args: Array<string | number | null> = [after];
    if (input.state === "active") where.push("archived_at IS NULL");
    if (input.state === "archived") where.push("archived_at IS NOT NULL");
    if (input.columnId !== undefined) { where.push("column_id = ?"); args.push(input.columnId); }
    if (input.assigneeId !== undefined) { where.push("assignee_id IS ?"); args.push(input.assigneeId); }
    const candidates = this.ctx.storage.sql.exec<{ id: string; title: string }>(
      `SELECT id, title FROM cards WHERE ${where.join(" AND ")} ORDER BY task_number`,
      ...args,
    );
    const items: Array<z.infer<typeof TaskSummarySchema>> = [];
    for (const candidate of candidates) {
      if (normalizedFilters.query && !candidate.title.toLowerCase().includes(normalizedFilters.query)) continue;
      const record = this.taskSummary(candidate.id, input.board);
      if (!record) continue;
      items.push(record);
      if (items.length > input.limit) break;
    }
    const page = items.slice(0, input.limit);
    const last = page.at(-1);
    return {
      ok: true,
      data: {
        items: page,
        nextCursor: items.length > input.limit && last
          ? encodeCursor({ v: 1, kind: "tasks", boardId: input.board.id, filters: normalizedFilters, after: last.taskNumber })
          : null,
      },
    };
  }

  private readMcpTask(input: z.infer<typeof McpTaskReadRequestSchema>): McpToolResult {
    const cardId = this.resolveMcpTaskId(input.task, input.board);
    if (cardId === null) throw new MutationRefusal("task_not_found", "Task not found.");
    const task = this.taskRecord(cardId, input.board);
    if (task === null) throw new MutationRefusal("task_not_found", "Task not found.");
    const sql = this.ctx.storage.sql;
    const hierarchy = loadFamily(sql, "retained");
    const parentId = hierarchy.parentByChild.get(cardId);
    const parent = parentId ? this.taskRecord(parentId, input.board) : null;
    const parentSummary = parent === null ? null : (({ description: _description, column: _column, ...summary }) => summary)(parent);
    const commentsLimit = Math.min(input.comments?.limit ?? 10, 50);
    const checklistLimit = input.checklist?.limit ?? 50;
    const subtasksLimit = Math.min(input.subtasks?.limit ?? 20, 50);
    const cursorAfter = (cursorValue: string | undefined, kind: string): { first: unknown; id: string } | null => {
      if (!cursorValue) return null;
      const cursor = decodeCursor(cursorValue);
      if (
        cursor?.kind !== kind || cursor.boardId !== input.board.id || cursor.taskId !== cardId ||
        cursor.filters !== undefined ||
        typeof cursor.after !== "object" || cursor.after === null ||
        Object.keys(cursor.after).length !== 2 ||
        !("first" in cursor.after) ||
        !("id" in cursor.after) || typeof cursor.after.id !== "string"
      ) throw new MutationRefusal("invalid_cursor", `${kind} cursor is invalid.`);
      return { first: cursor.after.first, id: cursor.after.id };
    };
    const commentsAfterRaw = cursorAfter(input.comments?.cursor, "comments");
    const checklistAfterRaw = cursorAfter(input.checklist?.cursor, "checklist");
    const subtasksAfterRaw = cursorAfter(input.subtasks?.cursor, "subtasks");
    if (commentsAfterRaw !== null && typeof commentsAfterRaw.first !== "number") {
      throw new MutationRefusal("invalid_cursor", "comments cursor is invalid.");
    }
    if (checklistAfterRaw !== null && typeof checklistAfterRaw.first !== "string") {
      throw new MutationRefusal("invalid_cursor", "checklist cursor is invalid.");
    }
    if (subtasksAfterRaw !== null && typeof subtasksAfterRaw.first !== "string") {
      throw new MutationRefusal("invalid_cursor", "subtasks cursor is invalid.");
    }
    const commentsAfter = commentsAfterRaw === null ? null : { first: Number(commentsAfterRaw.first), id: commentsAfterRaw.id };
    const checklistAfter = checklistAfterRaw === null ? null : { first: String(checklistAfterRaw.first), id: checklistAfterRaw.id };
    const subtasksAfter = subtasksAfterRaw === null ? null : { first: String(subtasksAfterRaw.first), id: subtasksAfterRaw.id };
    const commentsRows = sql.exec<{
      id: string; cardId: string; authorId: string; parentCommentId: string | null;
      deleted: number; body: string; createdAt: number; updatedAt: number;
    }>(
      `SELECT id, card_id AS cardId, author_id AS authorId, parent_comment_id AS parentCommentId,
              deleted, body, created_at AS createdAt, updated_at AS updatedAt
         FROM comments
        WHERE card_id = ? AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at, id LIMIT ?`,
      cardId, commentsAfter?.first ?? null, commentsAfter?.first ?? 0,
      commentsAfter?.first ?? 0, commentsAfter?.id ?? "", commentsLimit + 1,
    ).toArray().map((row) => ({ ...row, deleted: row.deleted === 1 }));
    const comments: typeof commentsRows = [];
    let commentBytes = 2;
    for (const row of commentsRows) {
      if (comments.length >= commentsLimit) break;
      const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + (comments.length ? 1 : 0);
      if (commentBytes + bytes > 131_072) break;
      comments.push(row);
      commentBytes += bytes;
    }
    const checklistRows = sql.exec<Omit<ChecklistItem, "done"> & { done: number }>(
      `SELECT id, card_id AS cardId, text, done, position FROM checklist_items
        WHERE card_id = ? AND (? IS NULL OR position > ? OR (position = ? AND id > ?))
        ORDER BY position, id LIMIT ?`,
      cardId, checklistAfter?.first ?? null, checklistAfter?.first ?? "",
      checklistAfter?.first ?? "", checklistAfter?.id ?? "", checklistLimit + 1,
    ).toArray().map((row) => ({ ...row, done: row.done === 1 }));
    const checklist: Array<Omit<ChecklistItem, "done"> & { done: boolean }> = [];
    let checklistBytes = 2;
    for (const row of checklistRows) {
      if (checklist.length >= checklistLimit) break;
      const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + (checklist.length ? 1 : 0);
      if (checklistBytes + bytes > 65_536) break;
      checklist.push(row);
      checklistBytes += bytes;
    }
    const childIds = hierarchy.childrenByParent.get(cardId) ?? [];
    const childRecords = childIds
      .map((id) => this.taskRecord(id, input.board))
      .filter((record): record is TaskRecord => record !== null)
      .sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .filter((record) =>
        subtasksAfter === null ||
        record.position > subtasksAfter.first ||
        (record.position === subtasksAfter.first && record.id > subtasksAfter.id)
      );
    const summaries: Array<Omit<TaskRecord, "description" | "column">> = [];
    let subtaskBytes = 2;
    for (const record of childRecords) {
      if (summaries.length >= subtasksLimit) break;
      const { description: _description, column: _column, ...summary } = record;
      const bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength + (summaries.length ? 1 : 0);
      if (subtaskBytes + bytes > 65_536) break;
      summaries.push(summary);
      subtaskBytes += bytes;
    }
    const lastComment = comments.at(-1);
    const lastChecklist = checklist.at(-1);
    const lastSubtask = summaries.at(-1);
    // One page per task, ordered by the join row's own id: the association is what
    // gets removed, so the id the reader sees is the id the writer names. A join
    // whose definition is gone describes nothing usable and is left out.
    const labelsLimit = input.labels?.limit ?? 50;
    let labelsAfter = "";
    if (input.labels?.cursor) {
      const cursor = decodeCursor(input.labels.cursor);
      if (
        cursor?.kind !== "task_labels" || cursor.boardId !== input.board.id ||
        cursor.taskId !== cardId || cursor.filters !== undefined ||
        typeof cursor.after !== "string"
      ) throw new MutationRefusal("invalid_cursor", "Task label cursor is invalid.");
      labelsAfter = cursor.after;
    }
    const labelRows = sql.exec<{
      id: string; cardId: string; labelId: string; name: string; color: LabelColor;
    }>(
      `SELECT card_labels.id AS id, card_labels.card_id AS cardId,
              card_labels.label_id AS labelId, labels.name AS name, labels.color AS color
         FROM card_labels
         JOIN labels ON labels.id = card_labels.label_id
        WHERE card_labels.card_id = ? AND card_labels.id > ?
        ORDER BY card_labels.id LIMIT ?`,
      cardId, labelsAfter, labelsLimit + 1,
    ).toArray();
    const labels = labelRows.slice(0, labelsLimit);
    const lastLabel = labels.at(-1);
    return {
      ok: true,
      data: {
        task,
        parent: parentSummary,
        comments: {
          items: comments,
          nextCursor: comments.length < commentsRows.length && lastComment
            ? encodeCursor({ v: 1, kind: "comments", boardId: input.board.id, taskId: cardId, after: { first: lastComment.createdAt, id: lastComment.id } })
            : null,
        },
        checklist: {
          items: checklist,
          nextCursor: checklist.length < checklistRows.length && lastChecklist
            ? encodeCursor({ v: 1, kind: "checklist", boardId: input.board.id, taskId: cardId, after: { first: lastChecklist.position, id: lastChecklist.id } })
            : null,
        },
        subtasks: {
          items: summaries,
          nextCursor: summaries.length < childRecords.length && lastSubtask
            ? encodeCursor({ v: 1, kind: "subtasks", boardId: input.board.id, taskId: cardId, after: { first: lastSubtask.position, id: lastSubtask.id } })
            : null,
        },
        labels: {
          items: labels,
          nextCursor: labelRows.length > labelsLimit && lastLabel
            ? encodeCursor({ v: 1, kind: "task_labels", boardId: input.board.id, taskId: cardId, after: lastLabel.id })
            : null,
        },
      },
    };
  }

  private positionForMcpMove(
    cardId: string | null,
    columnId: string,
    placement: { before: { id: string } | { key: string } } | { after: { id: string } | { key: string } } | undefined,
    board: McpBoardIdentity,
  ): string {
    const sql = this.ctx.storage.sql;
    if (!sql.exec<{ id: string }>("SELECT id FROM columns WHERE id = ?", columnId).toArray()[0]) {
      throw new MutationRefusal("column_not_found", "Destination column not found.");
    }
    const siblings = sql.exec<{ id: string; position: string }>(
      "SELECT id, position FROM cards WHERE archived_at IS NULL AND column_id = ? ORDER BY position, id",
      columnId,
    ).toArray().filter((row) => row.id !== cardId);
    let before: string | null = siblings.at(-1)?.position ?? null;
    let after: string | null = null;
    if (placement !== undefined) {
      const reference = "before" in placement ? placement.before : placement.after;
      const anchorId = this.resolveMcpTaskId(reference, board);
      const anchorIndex = anchorId === null ? -1 : siblings.findIndex((row) => row.id === anchorId);
      if (anchorIndex < 0) throw new MutationRefusal("invalid_placement", "Placement anchor is unavailable.");
      if ("before" in placement) {
        before = anchorIndex === 0 ? null : siblings[anchorIndex - 1]!.position;
        after = siblings[anchorIndex]!.position;
      } else {
        before = siblings[anchorIndex]!.position;
        after = anchorIndex + 1 < siblings.length ? siblings[anchorIndex + 1]!.position : null;
      }
    }
    // Equal neighbour keys (concurrent writers tie, ADR 0010) make the library throw for good, so step off the tie to the next distinct sibling key,
    // on the side the placement asks for: `before` stays ahead of the tied pair, `after` goes past it.
    if (before !== null && before === after) {
      const tied = before;
      if (placement !== undefined && "before" in placement) before = siblings.filter((row) => row.position < tied).at(-1)?.position ?? null;
      else after = siblings.find((row) => row.position > tied)?.position ?? null;
    }
    try {
      const position = generateKeyBetween(before, after);
      if (position.length > 64) throw new Error("position too long");
      // A key outside its neighbours would report success while misplacing the card.
      if ((before !== null && position <= before) || (after !== null && position >= after)) {
        throw new Error("position out of bounds");
      }
      return position;
    } catch {
      throw new MutationRefusal("position_conflict", "No valid position is available.");
    }
  }

  private executeMutation(
    request: MutationRequest,
    context: MutationContext,
  ): McpToolResult | void {
    if (request.source === "mcp") {
      return this.executeMcpCommand(request, context);
    }
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      // The socket path gates early for its own error/close handling; runMutation gates again as the pipeline's own invariant.
      return runMutation(this.ctx.storage.sql, request.message, context, now);
    });
    this.settleHeldRoutes(result.heldRoutes);
    this.fanOutMutation(
      request.rawFrame,
      request.message,
      result.activities,
      result.archivedCards,
      result.purgedCardIds,
      result.numberedCard,
      result.rebalanced,
    );
  }

  private executeMcpCommand(
    request: Extract<MutationRequest, { source: "mcp" }>,
    context: MutationContext,
  ): McpToolResult {
    const now = Date.now();
    let replayed = false;
    let message: ClientMessage | null = null;
    let activities: Activity[] = [];
    let numberedCard: { id: string; taskNumber: number } | undefined;
    let heldRoutes: HeldRoutes | undefined;
    let rebalanced: PositionsRebalanced | null = null;
    const result = this.ctx.storage.transactionSync((): McpToolResult => {
      const sql = this.ctx.storage.sql;
      const receipt = sql.exec<{
        actorId: string; operation: string; inputHash: string; resultJson: string;
      }>(
        `SELECT actor_id AS actorId, operation, input_hash AS inputHash, result_json AS resultJson
           FROM mcp_operation_receipts WHERE credential_id = ? AND operation_key = ?`,
        request.credentialId, request.command.operationKey,
      ).toArray()[0];
      if (receipt) {
        if (
          receipt.actorId !== context.actorId ||
          receipt.operation !== request.command.operation ||
          receipt.inputHash !== request.inputHash
        ) throw new MutationRefusal("idempotency_conflict", "Operation key was already used for different input.");
        replayed = true;
        return McpToolResultSchema.parse(JSON.parse(receipt.resultJson)) as McpToolResult;
      }

      // Every accepted call owns a receipt, including the ones whose desired state
      // already holds: a retry must see the same answer, never a second write.
      const commit = (committed: McpToolResult): McpToolResult => {
        const resultJson = JSON.stringify(committed);
        if (new TextEncoder().encode(resultJson).byteLength > 1_048_576) {
          throw new MutationRefusal("result_too_large", "Committed result exceeds the response limit.");
        }
        sql.exec(
          `INSERT INTO mcp_operation_receipts(
             credential_id, operation_key, actor_id, operation, input_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          request.credentialId, request.command.operationKey, context.actorId,
          request.command.operation, request.inputHash, resultJson, now,
        );
        return committed;
      };
      // The commands that carry a `task` all resolved a live card above; the two
      // that manage a definition alone never name one.
      const taskIdentity = (cardId: string) => {
        const record = this.taskRecord(cardId, request.board);
        if (!record) throw new MutationRefusal("task_not_found", "Task not found.");
        const { id, boardId, taskNumber, key, url } = record;
        return { id, boardId, taskNumber, key, url };
      };

      const taskResult = (cardId: string) => {
        const record = this.taskRecord(cardId, request.board);
        if (!record) throw new MutationRefusal("internal_error", "Committed result is unavailable.");
        return commit(TaskMutationOutputSchema.parse({
          ok: true,
          data: { operationKey: request.command.operationKey, task: record },
        }));
      };

      let targetId: string | null = null;
      if ("task" in request.command) {
        targetId = this.resolveMcpTaskId(request.command.task, request.board);
        if (targetId === null || this.taskRecord(targetId, request.board) === null) {
          throw new MutationRefusal("task_not_found", "Task not found.");
        }
      }
      const mutationId = crypto.randomUUID();
      switch (request.command.operation) {
        case "create_task": {
          if (request.command.assigneeId !== null && !request.assigneeAllowed) {
            throw new MutationRefusal("assignee_not_member", "Assignee is not a board member.");
          }
          message = ClientMessageSchema.parse({
            type: "card.create", mutationId, id: crypto.randomUUID(),
            columnId: request.command.columnId,
            title: request.command.title,
            position: this.positionForMcpMove(null, request.command.columnId, undefined, request.board),
            taskType: request.command.taskType,
            priority: request.command.priority,
            assigneeId: request.command.assigneeId,
          });
          break;
        }
        case "update_task":
          message = ClientMessageSchema.parse({
            type: "card.update", mutationId, id: targetId,
            ...(request.command.title !== undefined ? { title: request.command.title } : {}),
            ...(request.command.description !== undefined ? { description: request.command.description } : {}),
          });
          break;
        case "move_task":
          if (targetId === null) throw new MutationRefusal("task_not_found", "Task not found.");
          message = ClientMessageSchema.parse({
            type: "card.move", mutationId, id: targetId, columnId: request.command.columnId,
            position: this.positionForMcpMove(targetId, request.command.columnId, request.command.placement, request.board),
          });
          break;
        case "add_comment":
          message = ClientMessageSchema.parse({
            type: "comment.create", mutationId, id: crypto.randomUUID(), cardId: targetId,
            authorId: context.actorId, parentCommentId: null, body: request.command.body, createdAt: now,
          });
          break;
        case "complete_subtask": {
          checkCardWritable(sql, targetId!);
          const destination = completionFor(sql, targetId!, request.command.done);
          // Already there: a move would reorder it to the column tail and log a move for nothing, so the receipt takes the current task and nothing is sent.
          if (sql.exec("SELECT 1 FROM cards WHERE id = ? AND column_id = ?", targetId, destination).toArray()[0]) {
            return taskResult(targetId!);
          }
          message = ClientMessageSchema.parse({ type: "card.move", mutationId, id: targetId, columnId: destination, position: this.positionForMcpMove(targetId, destination, undefined, request.board) });
          break;
        }
        case "create_label":
          // Names are not unique, so the id the board generates is the identity;
          // nothing here ever matches a definition by name.
          message = ClientMessageSchema.parse({
            type: "label.create", mutationId, id: crypto.randomUUID(),
            name: request.command.name, color: request.command.color,
          });
          break;
        case "update_label": {
          const label = sql
            .exec<{ id: string }>("SELECT id FROM labels WHERE id = ?", request.command.labelId)
            .toArray()[0];
          if (!label) throw new MutationRefusal("label_not_found", "Label not found.");
          message = ClientMessageSchema.parse({
            type: "label.update", mutationId, id: label.id,
            ...(request.command.name !== undefined ? { name: request.command.name } : {}),
            ...(request.command.color !== undefined ? { color: request.command.color } : {}),
          });
          break;
        }
        case "assign_label": {
          // A no-op branch sends no message, so the gate's fences are read here,
          // whether or not the pair is already joined.
          checkCardWritable(sql, targetId!);
          const label = sql
            .exec<{ id: string }>("SELECT id FROM labels WHERE id = ?", request.command.labelId)
            .toArray()[0];
          if (!label) throw new MutationRefusal("label_not_found", "Label not found.");
          // Storage permits repeated pairs, but a caller never needs a second
          // identical association: the first row answers, with its own receipt, and
          // nothing is inserted, recorded or broadcast.
          const existing = sql.exec<CardLabel>(
            `SELECT id, card_id AS cardId, label_id AS labelId FROM card_labels
              WHERE card_id = ? AND label_id = ? ORDER BY id LIMIT 1`,
            targetId, request.command.labelId,
          ).toArray()[0];
          if (existing) {
            return commit(AssignLabelOutputSchema.parse({
              ok: true,
              data: {
                operationKey: request.command.operationKey,
                task: taskIdentity(targetId!),
                cardLabel: existing,
              },
            }));
          }
          message = ClientMessageSchema.parse({
            type: "label.assign", mutationId, id: crypto.randomUUID(),
            cardId: targetId, labelId: request.command.labelId,
          });
          break;
        }
        case "unassign_label": {
          // The join id may be absent or foreign, so the gate fences the named task.
          checkCardWritable(sql, targetId!);
          const assignment = sql
            .exec<{ cardId: string }>(
              "SELECT card_id AS cardId FROM card_labels WHERE id = ?",
              request.command.cardLabelId,
            )
            .toArray()[0];
          // A join id names one row on the whole board. The task in the input is what
          // entitles this caller to it, so a stranger's row is refused and never
          // identified as somebody else's.
          if (assignment !== undefined && assignment.cardId !== targetId) {
            throw new MutationRefusal("label_assignment_not_found", "Label assignment not found.");
          }
          if (assignment === undefined) {
            return commit(UnassignLabelOutputSchema.parse({
              ok: true,
              data: {
                operationKey: request.command.operationKey,
                task: taskIdentity(targetId!),
                cardLabelId: request.command.cardLabelId,
              },
            }));
          }
          message = ClientMessageSchema.parse({
            type: "label.unassign", mutationId, id: request.command.cardLabelId,
          });
          break;
        }
      }
      if (message.type === "workflow.configure") throw new MutationRefusal("internal_error", "Unsupported MCP mutation.");
      const ran = runMutation(sql, message, context, now);
      numberedCard = ran.numberedCard;
      activities = ran.activities;
      heldRoutes = ran.heldRoutes;
      rebalanced = ran.rebalanced;
      // Each operation answers with its own concrete shape: a label-only call has no
      // task result to give, and a task call never borrows the comment shape.
      switch (request.command.operation) {
        case "create_task":
        case "update_task":
        case "move_task":
        case "complete_subtask":
          return taskResult(request.command.operation === "create_task" ? message.id : targetId!);
        case "add_comment": {
          const comment = sql.exec<{
            id: string; cardId: string; authorId: string; parentCommentId: null;
            deleted: number; body: string; createdAt: number; updatedAt: number;
          }>(
            `SELECT id, card_id AS cardId, author_id AS authorId, parent_comment_id AS parentCommentId,
                    deleted, body, created_at AS createdAt, updated_at AS updatedAt
               FROM comments WHERE id = ?`,
            message.id,
          ).toArray().map((row) => ({ ...row, deleted: row.deleted === 1 }))[0];
          if (!comment) throw new MutationRefusal("internal_error", "Committed result is unavailable.");
          return commit(AddCommentOutputSchema.parse({
            ok: true,
            data: {
              operationKey: request.command.operationKey,
              task: taskIdentity(targetId!),
              comment,
            },
          }));
        }
        case "create_label":
        case "update_label": {
          const label = sql
            .exec<Label>("SELECT id, name, color FROM labels WHERE id = ?", message.id)
            .toArray()[0];
          if (!label) throw new MutationRefusal("internal_error", "Committed result is unavailable.");
          return commit(LabelMutationOutputSchema.parse({
            ok: true,
            data: { operationKey: request.command.operationKey, label },
          }));
        }
        case "assign_label": {
          const cardLabel = sql
            .exec<CardLabel>(
              "SELECT id, card_id AS cardId, label_id AS labelId FROM card_labels WHERE id = ?",
              message.id,
            )
            .toArray()[0];
          if (!cardLabel) throw new MutationRefusal("internal_error", "Committed result is unavailable.");
          return commit(AssignLabelOutputSchema.parse({
            ok: true,
            data: {
              operationKey: request.command.operationKey,
              task: taskIdentity(targetId!),
              cardLabel,
            },
          }));
        }
        case "unassign_label":
          return commit(UnassignLabelOutputSchema.parse({
            ok: true,
            data: {
              operationKey: request.command.operationKey,
              task: taskIdentity(targetId!),
              cardLabelId: request.command.cardLabelId,
            },
          }));
      }
    });
    if (heldRoutes) this.settleHeldRoutes(heldRoutes);
    // The new receipt expires on its own: wake the board then, even if no other work ever does.
    if (!replayed) this.ctx.waitUntil(this.scheduleAlarmAt(now + MCP_RECEIPT_RETENTION_MS));
    if (!replayed && message !== null) {
      this.fanOutMutation(JSON.stringify(message), message, activities, [], [], numberedCard, rebalanced);
    }
    return result;
  }

  private fanOutMutation(
    acceptedFrame: string,
    message: ClientMessage,
    activities: Activity[],
    archivedCards: ArchivedCard[],
    purgedCardIds: string[],
    numberedCard: { id: string; taskNumber: number } | undefined,
    rebalanced: PositionsRebalanced | null,
  ): void {
    // The caller's own bytes are echoed verbatim; the lifecycle extras are ours.
    // The verbatim frame carries the key the client chose; the rewrite follows as its own frame (ADR 0076).
    const frames = [
      acceptedFrame,
      ...(purgedCardIds.length ? [JSON.stringify({ type: "archive.purged", cardIds: purgedCardIds } satisfies ServerMessage)] : []),
      ...(archivedCards.length ? [JSON.stringify({ type: "cards.archived", mutationId: message.mutationId, cards: archivedCards } satisfies ServerMessage)] : []),
      ...(numberedCard ? [JSON.stringify({ type: "card.numbered", mutationId: message.mutationId, id: numberedCard.id, taskNumber: numberedCard.taskNumber } satisfies ServerMessage)] : []),
      ...(activities.length ? [JSON.stringify({ type: "activity.recorded", mutationId: message.mutationId, activities } satisfies ServerMessage)] : []),
      ...(rebalanced ? [JSON.stringify(rebalanced satisfies ServerMessage)] : []),
    ];
    for (const socket of this.ctx.getWebSockets()) {
      try {
        for (const frame of frames) this.sendFrame(socket, frame);
      } catch {
        // A reconnect obtains the authoritative snapshot.
      }
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.sendDirective(ws, { type: "error", mutationId: null, message: "expected a text frame" });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.sendDirective(ws, { type: "error", mutationId: null, message: "invalid JSON" });
      return;
    }

    const attachment: unknown = ws.deserializeAttachment();
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      !("userId" in attachment) ||
      typeof attachment.userId !== "string" ||
      attachment.userId.length === 0 ||
      attachment.userId.length > 64
    ) {
      const reason = "socket identity is missing";
      this.sendDirective(ws, { type: "error", mutationId: looseMutationId(raw), message: reason });
      ws.close(4001, reason);
      return;
    }
    const actorId = attachment.userId;
    const boardId =
      "boardId" in attachment &&
      typeof attachment.boardId === "string" &&
      ATTACHMENT_BOARD_ID.test(attachment.boardId)
        ? attachment.boardId
        : null;

    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`)
        .join("; ");
      this.sendDirective(ws, { type: "error", mutationId: looseMutationId(raw), message: detail });
      return;
    }

    const context: MutationContext = {
      actorId,
      boardId,
      canManageColumns: "canManageColumns" in attachment ? attachment.canManageColumns : undefined,
      isAdmin: "isAdmin" in attachment && attachment.isAdmin === true,
    };
    try {
      // The synchronous refusals first, so a message that is refused anyway never costs a D1 read.
      checkMutation(this.ctx.storage.sql, parsed.data, context);
      // Awaited only for an assignment, the one message that needs a D1 read; every other message still runs to its write without yielding.
      const assigneeId = parsed.data.type === "card.assign" || parsed.data.type === "card.create" ? parsed.data.assigneeId : null;
      if (assigneeId != null) await this.requireAssigneeEligible(boardId, assigneeId);
    } catch (error) {
      if (!(error instanceof MutationRefusal)) throw error;
      this.sendDirective(ws, { type: "error", mutationId: parsed.data.mutationId, message: error.message });
      if (error.closeCode !== undefined) ws.close(error.closeCode, error.message);
      return;
    }

    // The socket's own generation and the board's frozen flag decide whether this
    // frame may apply at all. A message delivered after prepare froze the board, or
    // from a socket a later generation replaced, is dropped here — the same
    // boundary the outbound frames use — instead of committing a policy-crossing
    // write and then failing to broadcast it.
    const admission = this.admitMutation(ws, attachment as Record<string, unknown>);
    if (!admission.admitted) {
      this.sendDirective(ws, {
        type: "error",
        mutationId: parsed.data.mutationId,
        message: admission.message,
      });
      if (admission.closeCode !== undefined) {
        try {
          ws.close(admission.closeCode, admission.message);
        } catch {
          // A socket already closing needs no second close.
        }
      }
      return;
    }

    if (typeof attachment !== "object" || attachment === null || !("protocolVersion" in attachment) || attachment.protocolVersion !== REALTIME_PROTOCOL_VERSION) {
      ws.close(1012, "Board protocol changed. Reload the app.");
      return;
    }

    const schedulesLifecycleAlarm = createsLifecycleWork(parsed.data);
    const now = Date.now();
    // Schedule before mutations that may enqueue cleanup keys or create an
    // archive deadline. An empty alarm is harmless for a no-op; scheduling
    // after the write could strand committed lifecycle work if this event died.
    if (schedulesLifecycleAlarm) this.ctx.storage.setAlarm(now);

    try {
      this.executeMutation(
        { source: "websocket", message: parsed.data, rawFrame: message },
        context,
      );
    } catch (error) {
      // A rejected write must not be broadcast: peers only receive committed mutations.
      this.sendDirective(ws, {
        type: "error",
        mutationId: parsed.data.mutationId,
        message: error instanceof Error ? error.message : "could not apply the mutation",
      });
      return;
    }
    if (schedulesLifecycleAlarm) this.ctx.waitUntil(this.drainAttachmentCleanup());
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // Complete the closing handshake with a conservative close code. Reserved
    // status-only codes such as 1005 and 1006 cannot be sent; the configured
    // non-pedantic runtime also permits server codes such as 1012.
    const sendable = code === 1000 || (code >= 3000 && code <= 4999);
    ws.close(sendable ? code : 1000);
  }

  private snapshot(): ServerMessage {
    const sql = this.ctx.storage.sql;
    return {
      type: "snapshot",
      workflowRolesExplicit: rolesExplicit(sql),
      columns: sql.exec<{ id: string; title: string; position: string; completed: number; starting: number }>("SELECT id, title, position, completed, starting FROM columns").toArray().map(c => ({ ...c, completed: c.completed === 1, starting: c.starting === 1 })),
      cards: sql
        .exec<CardRow>(
          `SELECT cards.id AS id, column_id AS columnId, cards.title AS title, description, cards.position AS position,
                  task_number AS taskNumber, columns.completed AS subtaskDone,
                  assignee_id AS assigneeId, priority, task_type AS taskType, due_date AS dueDate,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM cards
           LEFT JOIN columns ON columns.id = cards.column_id
           WHERE archived_at IS NULL`,
        )
        .toArray()
        // An active card's done flag is its column's, read in the same query.
        .map((row) => ({ ...row, subtaskDone: row.subtaskDone === 1 })),
      archivedCards: sql
        .exec<ArchivedCardRow>(`${ARCHIVED_CARD_SELECT} WHERE archived_at IS NOT NULL`)
        .toArray()
        .map((row) => ({ ...row, subtaskDone: row.subtaskDone === 1 })),
      // `done` is an INTEGER column; the wire type is a boolean.
      checklistItems: sql
        .exec<Omit<ChecklistItem, "done"> & { done: number }>(
          "SELECT id, card_id AS cardId, text, done, position FROM checklist_items",
        )
        .toArray()
        .map((row) => ({ ...row, done: row.done === 1 })),
      attachments: sql
        .exec<Attachment>(
          `SELECT id, card_id AS cardId, file_name AS fileName,
                  content_type AS contentType, size
           FROM attachments`,
        )
        .toArray(),
      // Counts, not bodies: a card's comments are read when it is opened (ADR 0078).
      commentCounts: Object.fromEntries(
        sql
          .exec<{ cardId: string; count: number }>(
            "SELECT card_id AS cardId, COUNT(*) AS count FROM comments WHERE deleted = 0 GROUP BY card_id",
          )
          .toArray()
          .map(({ cardId, count }) => [cardId, count]),
      ),
      relations: sql
        .exec<CardRelation>(
          `SELECT id, source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
           FROM card_relations`,
        )
        .toArray(),
      labels: sql.exec<Label>("SELECT id, name, color FROM labels").toArray(),
      cardLabels: sql
        .exec<CardLabel>("SELECT id, card_id AS cardId, label_id AS labelId FROM card_labels")
        .toArray(),
    };
  }

  /**
   * The inbound half of the same boundary `send` enforces outbound: only an open
   * socket holding the current, unfrozen generation of a live board may submit a
   * mutation. A hibernated object can deliver a message queued before the fence
   * went up, and `getWebSockets()` keeps listing sockets that are closing, so the
   * check is per message rather than per connection.
   */
  private admitMutation(
    ws: WebSocket,
    attachment: Record<string, unknown>,
  ): { admitted: true } | { admitted: false; message: string; closeCode?: number } {
    if (ws.readyState !== WebSocket.OPEN) return { admitted: false, message: "socket is closing" };
    if (this.deleting) return { admitted: false, message: "board deleted" };
    const state = this.policyBoundary();
    if (!state) return { admitted: false, message: "Reconnect to continue.", closeCode: 1012 };
    if (state.frozen === 1)
      return {
        admitted: false,
        message: "Board access is changing. Reconnect to continue.",
        closeCode: 4010,
      };
    const generation = attachment.generation;
    // A legacy attachment has no generation to compare, and an attachment from
    // before this board's last change names one that is already spent: neither may
    // write, because this DO cannot tell which policy its sender last saw.
    if (typeof generation !== "number")
      return { admitted: false, message: "Reconnect to continue.", closeCode: 1012 };
    if (generation !== state.generation)
      return {
        admitted: false,
        message: "Board access changed. Reconnect to continue.",
        closeCode: 4010,
      };
    return { admitted: true };
  }

  /**
   * The single frame boundary: only an open socket holding the current, unfrozen
   * generation may receive application frames. `getWebSockets()` can still list a
   * socket that is closing, and `send` on one throws, so the state is checked here.
   */
  private sendFrame(ws: WebSocket, raw: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state=this.ctx.storage.sql.exec<{generation:number;frozen:number}>(`SELECT generation,frozen FROM board_access_state WHERE id=1`).toArray()[0];
    const attachment:unknown=ws.deserializeAttachment();
    if(typeof attachment!=="object"||attachment===null||!("protocolVersion" in attachment)||attachment.protocolVersion!==REALTIME_PROTOCOL_VERSION){ws.close(1012,"Board protocol changed. Reload the app.");return;}
    if(!state||state.frozen===1||typeof attachment!=="object"||attachment===null||!("generation" in attachment)||attachment.generation!==state.generation)return;
    ws.send(raw);
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    this.sendFrame(ws, JSON.stringify(message));
  }

  /**
   * The socket's own refusal or reconnect directive. Unlike content, this must
   * still reach a legacy attachment: telling it to reconnect is exactly how it
   * recovers a generation, and the caller closes it immediately afterwards.
   */
  private sendDirective(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state=this.ctx.storage.sql.exec<{frozen:number}>(`SELECT frozen FROM board_access_state WHERE id=1`).toArray()[0];
    if(!state||state.frozen===1)return;
    ws.send(JSON.stringify(message));
  }

  /** Best-effort fan-out: a socket that dies mid-loop must not abort the rest. The message is serialized once, not per socket: a snapshot is megabytes. */
  private broadcast(message: ServerMessage): void {
    const raw = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        this.sendFrame(socket, raw);
      } catch {
        // Ignore closed sockets; they re-snapshot on reconnect.
      }
    }
  }
}

/** Best-effort `mutationId` recovery so the sender can drop the right pending mutation. */
function looseMutationId(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "mutationId" in raw) {
    const candidate = raw.mutationId;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

/**
 * The plan's inner authorization bound: a protected path holds the object's input
 * gate while it resolves its verdict, so that wait is capped. A dependency that
 * answers later than this is refused (retry) and its answer is discarded.
 */
const ADMISSION_DEADLINE_MS = 5_000;

/**
 * `work` or `null` when the deadline passes first: a dependency failure is reported as
 * "no answer" rather than a thrown one, so the promise this returns is total. The loser
 * of the race is abandoned rather than cancelled, so the raced work must only read —
 * the caller of an unanswered admission refuses the request and uses no part of a late
 * answer. The window's timer is cleared as soon as either side settles.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  const window = new AbortController();
  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    window.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { once: true },
    );
  });
  return Promise.race([work, deadline])
    .catch((): null => null)
    .finally(() => window.abort());
}
