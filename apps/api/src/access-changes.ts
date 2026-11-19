import { Hono } from "hono";
import { z } from "zod";

import { adminEmails, boardManageSql, boardOpenSql, canManageBoard, canOpenBoard, isAdminEmail, requireAuth, sha256Hex, type AppEnv, type SessionUser } from "./auth";
import { boardClient } from "./board-client";

export type AccessChangeKind =
  | "workspace-member-add"
  | "workspace-member-role"
  | "workspace-member-remove"
  | "workspace-invite-accept"
  | "board-member-add"
  | "board-member-remove"
  | "board-move"
  | "board-delete";

export type AccessChangeState = "preparing" | "committed" | "aborted" | "completed";

/** What every policy route returns once the journal has settled the attempt. */
export type AccessChangeResult = {
  operationId: string;
  state: "completed";
  outcome: "committed" | "aborted";
  result: unknown;
};

/** A still-running (or still-recovering) attempt: the caller answers 202. */
export type AccessChangePending = {
  operationId: string;
  state: "preparing" | "committed" | "aborted";
  recoveryPending: true;
};

export type AccessChangeInput = {
  operationId: string;
  kind: AccessChangeKind;
  /** Endpoint input plus the resolved source identity/version the recovery pass needs. */
  payload: Record<string, unknown>;
  /** Every workspace this attempt locks; the reservation writes these scopes. */
  workspaceIds: string[];
  /**
   * Boards the caller resolved, each with the workspace it must still be placed in.
   * The reservation re-asserts that placement, so a board that moved between the
   * caller's read and the attempt cannot be fenced under the wrong workspace lock.
   */
  boards?: Array<{ boardId: string; workspaceId: string }>;
  /**
   * Fences every board of each `workspaceIds` entry, Private ones included: a
   * workspace role decides who may open a Private board (its admins), so a role
   * change must close the sockets and drop the cached access there too. Membership
   * changes derive their participants inside the reservation transaction, so a
   * board created between the caller's read and the attempt is still covered.
   */
  inheritWorkspaceBoards?: boolean;
};

/**
 * Abort reasons are a closed set: the route code maps them onto its own HTTP
 * status, and recovery stores them so a retry replays the same answer.
 */
export const ACCESS_CHANGE_ABORT = {
  forbidden: "forbidden",
  staleContext: "stale board context",
  boardNotFound: "board not found",
  memberNotFound: "member not found",
  lastAdmin: "last workspace admin",
  inviteUnavailable: "invite unavailable",
  invalidPayload: "invalid payload",
} as const;

export class AccessChangeConflict extends Error {}

/** The 409 every route answers when an access change loses its race for the lock. */
export const ACCESS_CONFLICT = { error: "access change conflict", code: "access_change_conflict" } as const;

const PARTICIPANT_CALL_TIMEOUT_MS = 5_000;
const FOREGROUND_BUDGET_MS = 20_000;
const RECOVERY_PASS_BUDGET_MS = 20_000;
const RECOVERY_OPERATION_LIMIT = 20;
const RECOVERY_CONCURRENCY = 4;
const PARTICIPANT_CONCURRENCY = 4;
/**
 * Bound parameters D1 accepts in one statement, kept well under the documented cap:
 * a board that has been shared for a while can name more recipients than that, so
 * both the visibility read and the notification fan-out run in bounded batches.
 */
const RECIPIENT_PARAMETER_BUDGET = 80;

type OperationPhase = AccessChangeState;

type OperationRow = {
  id: string;
  actorId: string;
  kind: AccessChangeKind;
  payloadJson: string;
  payloadHash: string;
  phase: OperationPhase;
  outcome: "committed" | "aborted" | null;
  resultJson: string | null;
  notifyUserIdsJson: string;
  notified: number;
  effectStarted: number;
};

type ParticipantRow = {
  boardId: string;
  expectedVersion: number;
  nextVersion: number;
  prepared: number;
  released: number;
};

const Identifier = z.string().min(1).max(64);
const InviteHash = z.string().regex(/^[0-9a-f]{64}$/);

const MovePayloadSchema = z.strictObject({
  boardId: Identifier,
  destinationWorkspaceId: Identifier,
  expectedWorkspaceId: Identifier,
  expectedAccessVersion: z.number().int().nonnegative(),
  ownerId: Identifier,
  grantManager: z.boolean(),
});
const BoardDeletePayloadSchema = z.strictObject({
  boardId: Identifier,
  workspaceId: Identifier,
  ownerId: Identifier,
});
const WorkspaceMemberAddPayloadSchema = z.strictObject({
  workspaceId: Identifier,
  userId: Identifier,
  role: z.enum(["admin", "member"]),
});
const WorkspaceMemberRolePayloadSchema = z.strictObject({
  workspaceId: Identifier,
  userId: Identifier,
  role: z.enum(["admin", "member"]),
});
const WorkspaceMemberRemovePayloadSchema = z.strictObject({
  workspaceId: Identifier,
  userId: Identifier,
});
const WorkspaceInviteAcceptPayloadSchema = z.strictObject({
  workspaceId: Identifier,
  inviteId: Identifier,
  inviteHash: InviteHash,
});
const BoardMemberPayloadSchema = z.strictObject({
  boardId: Identifier,
  userId: Identifier,
});

type PayloadSchema = {
  "board-move": typeof MovePayloadSchema;
  "board-delete": typeof BoardDeletePayloadSchema;
  "workspace-member-add": typeof WorkspaceMemberAddPayloadSchema;
  "workspace-member-role": typeof WorkspaceMemberRolePayloadSchema;
  "workspace-member-remove": typeof WorkspaceMemberRemovePayloadSchema;
  "workspace-invite-accept": typeof WorkspaceInviteAcceptPayloadSchema;
  "board-member-add": typeof BoardMemberPayloadSchema;
  "board-member-remove": typeof BoardMemberPayloadSchema;
};

const PAYLOAD_SCHEMAS: PayloadSchema = {
  "board-move": MovePayloadSchema,
  "board-delete": BoardDeletePayloadSchema,
  "workspace-member-add": WorkspaceMemberAddPayloadSchema,
  "workspace-member-role": WorkspaceMemberRolePayloadSchema,
  "workspace-member-remove": WorkspaceMemberRemovePayloadSchema,
  "workspace-invite-accept": WorkspaceInviteAcceptPayloadSchema,
  "board-member-add": BoardMemberPayloadSchema,
  "board-member-remove": BoardMemberPayloadSchema,
};

/** Key-sorted JSON with a stable shape, so replaying an attempt hashes identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Foreground orchestration is bounded; recovery shares one pass budget. Work that
 * does not fit stays in the journal for the cron pass, never dropped.
 */
class Budget {
  constructor(private readonly until: number) {}
  static foreground(): Budget {
    return new Budget(Date.now() + FOREGROUND_BUDGET_MS);
  }
  static until(deadline: number): Budget {
    return new Budget(deadline);
  }
  get expired(): boolean {
    return Date.now() >= this.until;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * One captured recipient: the user, plus the subset of the attempt's contexts that
 * user may know. Captured before the policy write, so a removed user keeps what
 * they already knew, and reused at notification time so nobody receives a context
 * they were never entitled to.
 */
type CapturedRecipient = { id: string; workspaces: string[]; boards: string[] };

/**
 * `u` may reach board `b` under the current policy (the shared board-open rule,
 * without the operator term): the visibility rule for notifications.
 */
const RECIPIENT_BOARD_ACCESS = boardOpenSql("b", "u.id");

/**
 * The configured operator accounts, matched the same way everywhere in this module. The list is one
 * bound JSON array however long it is: D1 caps bound parameters per statement, one bind per use.
 */
function operatorEmailClauses(env: Env, column: string): { sql: string; binds: unknown[] } {
  const emails = adminEmails(env);
  return emails.length > 0
    ? { sql: `${column} IN (SELECT value FROM json_each(?))`, binds: [JSON.stringify(emails)] }
    : { sql: "0", binds: [] };
}

/**
 * The one management predicate for board-scoped attempts: operator, owner, board
 * member, workspace access, or an admin of the board's workspace (whatever its
 * access mode, since an admin opens a Private board too).
 */
function boardAccessPredicate(boardIdExpression: string, ops: number): string {
  return `EXISTS(SELECT 1 FROM boards b WHERE b.id=${boardIdExpression}
    AND ${boardOpenSql("b", "?", `${ops}=1`)})`;
}

/**
 * The narrower predicate for attempts that change a board's placement or remove
 * it: exactly the capabilities `toBoardRow` grants management for, so a plain
 * board member cannot move or delete the board they collaborate on. An admin of
 * the board's workspace manages it whatever its access mode.
 */
function boardManagementPredicate(boardIdExpression: string, ops: number): string {
  return `EXISTS(SELECT 1 FROM boards b WHERE b.id=${boardIdExpression}
    AND ${boardManageSql("b", "?", `${ops}=1`)})`;
}

/**
 * Removing a board member who is a manager takes manage rights; removing anyone else takes
 * only the open right the caller already asserts. Binds: board, target, then those of
 * `boardManagementPredicate` (board, actor x3).
 */
function managerRemovalGuard(ops: number): string {
  return `(NOT EXISTS(SELECT 1 FROM board_members mt WHERE mt.board_id=? AND mt.user_id=? AND mt.role='manager')
    OR ${boardManagementPredicate("?", ops)})`;
}

/**
 * Who may remove a member: an admin may remove anyone, and any member may remove
 * themselves, which is how a member leaves. Binds: workspace, actor, target.
 */
const REMOVE_AUTHORITY = `EXISTS(SELECT 1 FROM workspace_members x
  WHERE x.workspace_id=? AND x.user_id=? AND (x.role='admin' OR x.user_id=?))`;

/**
 * An invitation is only as good as the admin who issued it: it stops working when
 * its inviter is demoted or removed, so a role taken away cannot be handed back
 * through a link kept from before. Spliced where the invite row is aliased `wi`.
 */
export const INVITER_IS_ADMIN = `EXISTS(SELECT 1 FROM workspace_members im
  WHERE im.workspace_id=wi.workspace_id AND im.user_id=wi.invited_by AND im.role='admin')`;

function parseCapturedRecipients(raw: string): CapturedRecipient[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const recipients: CapturedRecipient[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    recipients.push({
      id: record.id,
      workspaces: Array.isArray(record.workspaces)
        ? record.workspaces.filter((id): id is string => typeof id === "string")
        : [],
      boards: Array.isArray(record.boards)
        ? record.boards.filter((id): id is string => typeof id === "string")
        : [],
    });
  }
  return recipients;
}

async function mapChunks<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map((item) => run(item)));
  }
}

/**
 * The repository's transaction-aborting assertion idiom: the `json()` call throws
 * when the condition is false, rolling back the whole D1 batch. Used inside the
 * commit batch so a lost race cannot leave a half-applied policy change.
 */
function assertion(env: Env, expression: string, binds: unknown[]) {
  return env.DB.prepare(
    `SELECT CASE WHEN (${expression}) THEN 1 ELSE json('error: access change conflict') END`,
  ).bind(...binds);
}

function readOperation(env: Env, id: string): Promise<OperationRow | null> {
  return env.DB.prepare(
    `SELECT id,actor_id AS actorId,kind,payload_json AS payloadJson,payload_hash AS payloadHash,
            phase,outcome,result_json AS resultJson,notify_user_ids_json AS notifyUserIdsJson,
            notified,effect_started AS effectStarted
       FROM access_change_operations WHERE id=?`,
  )
    .bind(id)
    .first<OperationRow>();
}

async function loadParticipants(env: Env, operationId: string): Promise<ParticipantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT board_id AS boardId,expected_version AS expectedVersion,next_version AS nextVersion,
            prepared,released
       FROM access_change_boards WHERE operation_id=? ORDER BY board_id`,
  )
    .bind(operationId)
    .all<ParticipantRow>();
  return results;
}

function parsePayload(op: OperationRow): Record<string, unknown> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(op.payloadJson);
  } catch {
    return null;
  }
  const parsed = PAYLOAD_SCHEMAS[op.kind].safeParse(decoded);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/** Freezes every participant in D1 order. A lost acknowledgement is retried, not assumed. */
async function ensurePrepared(
  env: Env,
  op: OperationRow,
  participants: ParticipantRow[],
  budget: Budget,
): Promise<boolean> {
  let complete = true;
  await mapChunks(
    participants.filter((participant) => participant.prepared === 0),
    PARTICIPANT_CONCURRENCY,
    async (participant) => {
      if (budget.expired) {
        complete = false;
        return;
      }
      if (
        !(await boardClient(env, participant.boardId).prepareAccess(
          { operationId: op.id, generation: participant.nextVersion },
          PARTICIPANT_CALL_TIMEOUT_MS,
        ))
      ) {
        complete = false;
        return;
      }
      await env.DB.prepare(
        `UPDATE access_change_boards SET prepared=1 WHERE operation_id=? AND board_id=?`,
      )
        .bind(op.id, participant.boardId)
        .run();
      participant.prepared = 1;
    },
  );
  return complete;
}

type Evaluation = { ok: true } | { ok: false; reason: string };

/**
 * Re-reads the current authority for an attempt. Runs before the guarded commit
 * batch and again if that batch fails, which is what tells a real precondition
 * failure apart from a transient storage error without sniffing error text.
 */
async function evaluateCommit(
  env: Env,
  op: OperationRow,
  payload: Record<string, unknown>,
): Promise<Evaluation> {
  // The row, not this attempt's snapshot, decides: an operation another pass has
  // already settled can never be committed again, whatever the caller believes.
  const current = await readOperation(env, op.id);
  if (!current || current.phase !== "preparing")
    return { ok: false, reason: ACCESS_CHANGE_ABORT.staleContext };
  const actor = await env.DB.prepare("SELECT email FROM users WHERE id=?")
    .bind(op.actorId)
    .first<{ email: string }>();
  if (!actor) return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
  const operator = isAdminEmail(env, actor.email);

  switch (op.kind) {
    case "board-move": {
      const boardId = payload.boardId as string;
      const row = await env.DB.prepare(
        `SELECT b.owner_id AS ownerId,b.workspace_id AS workspaceId,b.access_version AS accessVersion,
                b.access_mode AS accessMode,
                b.pending_access_operation_id AS pendingOperationId,bm.role AS explicitRole,
                wm.role AS workspaceRole,dm.user_id AS destinationMember
           FROM boards b
           LEFT JOIN board_members bm ON bm.board_id=b.id AND bm.user_id=?
           LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
           LEFT JOIN workspace_members dm ON dm.workspace_id=? AND dm.user_id=?
          WHERE b.id=?`,
      )
        .bind(
          op.actorId,
          op.actorId,
          payload.destinationWorkspaceId as string,
          op.actorId,
          boardId,
        )
        .first<{
          ownerId: string;
          workspaceId: string;
          accessVersion: number;
          accessMode: string;
          pendingOperationId: string | null;
          explicitRole: string | null;
          workspaceRole: string | null;
          destinationMember: string | null;
        }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.boardNotFound };
      if (
        row.workspaceId !== payload.expectedWorkspaceId ||
        row.accessVersion !== payload.expectedAccessVersion ||
        row.pendingOperationId !== op.id
      )
        return { ok: false, reason: ACCESS_CHANGE_ABORT.staleContext };
      const permitted = canManageBoard({
        operator,
        owner: row.ownerId === op.actorId,
        accessMode: row.accessMode,
        explicitRole: row.explicitRole,
        workspaceRole: row.workspaceRole,
      });
      if (!permitted || !row.destinationMember)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      return { ok: true };
    }
    case "board-delete": {
      const row = await env.DB.prepare(
        `SELECT b.owner_id AS ownerId,b.workspace_id AS workspaceId,b.access_mode AS accessMode,
                b.pending_access_operation_id AS pendingOperationId,bm.role AS explicitRole,
                wm.role AS workspaceRole
           FROM boards b
           LEFT JOIN board_members bm ON bm.board_id=b.id AND bm.user_id=?
           LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
          WHERE b.id=?`,
      )
        .bind(op.actorId, op.actorId, payload.boardId as string)
        .first<{
          ownerId: string;
          workspaceId: string;
          accessMode: string;
          pendingOperationId: string | null;
          explicitRole: string | null;
          workspaceRole: string | null;
        }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.boardNotFound };
      if (row.pendingOperationId !== op.id)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.staleContext };
      const permitted = canManageBoard({
        operator,
        owner: row.ownerId === op.actorId,
        accessMode: row.accessMode,
        explicitRole: row.explicitRole,
        workspaceRole: row.workspaceRole,
      });
      return permitted ? { ok: true } : { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
    }
    case "workspace-member-add": {
      const row = await env.DB.prepare(
        `SELECT wm.role AS actorRole,t.id AS targetId
           FROM workspaces w
           LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=?
           LEFT JOIN users t ON t.id=?
          WHERE w.id=?`,
      )
        .bind(op.actorId, payload.userId as string, payload.workspaceId as string)
        .first<{ actorRole: string | null; targetId: string | null }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      if (row.actorRole !== "admin") return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      // A membership can only be granted to an account that exists. An account that
      // is already a member is not a failure: the write below ignores the existing
      // row, so the attempt still commits the outcome the caller asked for.
      if (row.targetId === null)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.memberNotFound };
      return { ok: true };
    }
    case "workspace-member-role":
    case "workspace-member-remove": {
      const row = await env.DB.prepare(
        `SELECT wm.role AS actorRole,t.role AS targetRole,
                (SELECT COUNT(*) FROM workspace_members a
                  WHERE a.workspace_id=w.id AND a.role='admin' AND a.user_id<>?) AS otherAdmins
           FROM workspaces w
           LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=?
           LEFT JOIN workspace_members t ON t.workspace_id=w.id AND t.user_id=?
          WHERE w.id=?`,
      )
        .bind(
          payload.userId as string,
          op.actorId,
          payload.userId as string,
          payload.workspaceId as string,
        )
        .first<{ actorRole: string | null; targetRole: string | null; otherAdmins: number }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      // An admin manages anyone; any member may remove themselves, which is leaving.
      const leaving = op.kind === "workspace-member-remove" && op.actorId === payload.userId;
      if (row.actorRole !== "admin" && !(leaving && row.actorRole !== null))
        return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      if (op.kind === "workspace-member-role" && row.targetRole === null)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.memberNotFound };
      // The workspace keeps an admin: the last one cannot be demoted or removed.
      const losesAdmin = op.kind === "workspace-member-remove" || payload.role === "member";
      if (row.targetRole === "admin" && losesAdmin && row.otherAdmins === 0)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.lastAdmin };
      return { ok: true };
    }
    case "workspace-invite-accept": {
      const row = await env.DB.prepare(
        `SELECT w.id AS workspaceId,wi.id AS inviteId
           FROM workspaces w
           LEFT JOIN workspace_invites wi ON wi.id=? AND wi.workspace_id=w.id AND wi.token_hash=?
                AND wi.revoked_at IS NULL AND wi.expires_at>? AND ${INVITER_IS_ADMIN}
          WHERE w.id=?`,
      )
        .bind(
          payload.inviteId as string,
          payload.inviteHash as string,
          Date.now(),
          payload.workspaceId as string,
        )
        .first<{ workspaceId: string; inviteId: string | null }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      if (row.inviteId === null)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.inviteUnavailable };
      return { ok: true };
    }
    case "board-member-add":
    case "board-member-remove": {
      const row = await env.DB.prepare(
        `SELECT b.owner_id AS ownerId,b.access_mode AS accessMode,
                b.pending_access_operation_id AS pendingOperationId,bm.role AS explicitRole,
                wm.role AS workspaceRole,t.role AS targetRole
           FROM boards b
           LEFT JOIN board_members bm ON bm.board_id=b.id AND bm.user_id=?
           LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
           LEFT JOIN board_members t ON t.board_id=b.id AND t.user_id=?
          WHERE b.id=?`,
      )
        .bind(op.actorId, op.actorId, payload.userId as string, payload.boardId as string)
        .first<{
          ownerId: string;
          accessMode: string;
          pendingOperationId: string | null;
          explicitRole: string | null;
          workspaceRole: string | null;
          targetRole: string | null;
        }>();
      if (!row) return { ok: false, reason: ACCESS_CHANGE_ABORT.boardNotFound };
      if (row.pendingOperationId !== op.id)
        return { ok: false, reason: ACCESS_CHANGE_ABORT.staleContext };
      const facts = {
        operator,
        owner: row.ownerId === op.actorId,
        accessMode: row.accessMode,
        explicitRole: row.explicitRole,
        workspaceRole: row.workspaceRole,
      };
      if (!canOpenBoard(facts)) return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      // Taking a board manager away is itself a management act (the owner is protected by the reservation).
      if (op.kind === "board-member-remove" && row.targetRole === "manager" && !canManageBoard(facts))
        return { ok: false, reason: ACCESS_CHANGE_ABORT.forbidden };
      return { ok: true };
    }
  }
}

/** The guarded commit batch: permission assertion, policy writes, then POST-conditions. */
function commitStatements(
  env: Env,
  op: OperationRow,
  payload: Record<string, unknown>,
  participants: ParticipantRow[],
  operator: boolean,
  result: unknown,
): D1PreparedStatement[] {
  const ops = operator ? 1 : 0;
  const now = Date.now();
  const resultJson = JSON.stringify(result);
  const committed = `EXISTS(SELECT 1 FROM access_change_operations WHERE id=? AND phase='committed' AND outcome='committed')`;
  // The policy change may only cross a boundary every participant acknowledged:
  // a board whose fence never went up still has live sockets holding the old policy.
  const preparedAck = assertion(
    env,
    `(SELECT COUNT(*) FROM access_change_boards WHERE operation_id=? AND prepared=1)
     =(SELECT COUNT(*) FROM access_change_boards WHERE operation_id=?)`,
    [op.id, op.id],
  );
  // A successful change consumes each fenced board's reserved generation. Without
  // this bump D1 stays at the old access_version while the DO advances, so the same
  // generation is reserved again and generation equality stops distinguishing
  // attempts, connections and snapshots.
  const versionBump = env.DB.prepare(
    `UPDATE boards SET access_version=(
        SELECT p.next_version FROM access_change_boards p
         WHERE p.operation_id=? AND p.board_id=boards.id)
      WHERE pending_access_operation_id=?
        AND EXISTS(SELECT 1 FROM access_change_boards p
                    WHERE p.operation_id=? AND p.board_id=boards.id
                      AND boards.access_version=p.expected_version)`,
  ).bind(op.id, op.id, op.id);
  const versionHeld = assertion(
    env,
    `(SELECT COUNT(*) FROM access_change_boards p JOIN boards b ON b.id=p.board_id
       WHERE p.operation_id=? AND b.access_version=p.next_version)
     =(SELECT COUNT(*) FROM access_change_boards WHERE operation_id=?)`,
    [op.id, op.id],
  );

  switch (op.kind) {
    case "board-move": {
      const boardId = payload.boardId as string;
      const destination = payload.destinationWorkspaceId as string;
      const next = participants[0]!.nextVersion;
      return [
        preparedAck,
        assertion(
          env,
          `${boardManagementPredicate("?", ops)}
           AND EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=? AND x.user_id=?)`,
          [
            boardId,
            op.actorId,
            op.actorId,
            op.actorId,
            destination,
            op.actorId,
          ],
        ),
        env.DB.prepare(
          `UPDATE boards SET workspace_id=?,access_mode='restricted',access_version=?
            WHERE id=? AND workspace_id=? AND access_version=? AND pending_access_operation_id=?`,
        ).bind(
          destination,
          next,
          boardId,
          payload.expectedWorkspaceId as string,
          payload.expectedAccessVersion as number,
          op.id,
        ),
        env.DB.prepare(
          `INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`,
        ).bind(boardId, payload.ownerId as string),
        ...(payload.grantManager
          ? [
              env.DB.prepare(
                `INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')
                 ON CONFLICT(board_id,user_id) DO UPDATE SET role='manager'`,
              ).bind(boardId, op.actorId),
            ]
          : []),
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(
          env,
          `EXISTS(SELECT 1 FROM boards WHERE id=? AND workspace_id=? AND access_mode='restricted' AND access_version=?)
           AND ${committed}`,
          [boardId, destination, next, op.id],
        ),
        versionHeld,
      ];
    }
    case "board-delete": {
      const boardId = payload.boardId as string;
      return [
        preparedAck,
        env.DB.prepare("DELETE FROM board_members WHERE board_id=?").bind(boardId),
        env.DB.prepare("DELETE FROM github_pr_routes WHERE board_id=?").bind(boardId),
        env.DB.prepare("DELETE FROM github_branch_routes WHERE board_id=?").bind(boardId),
        env.DB.prepare("DELETE FROM boards WHERE id=? AND pending_access_operation_id=?").bind(
          boardId,
          op.id,
        ),
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=1`,
        ).bind(resultJson, now, op.id),
        assertion(env, `NOT EXISTS(SELECT 1 FROM boards WHERE id=?) AND ${committed}`, [
          boardId,
          op.id,
        ]),
      ];
    }
    case "workspace-member-add": {
      const workspaceId = payload.workspaceId as string;
      const userId = payload.userId as string;
      const role = payload.role as string;
      return [
        preparedAck,
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=? AND x.user_id=? AND x.role='admin')
           AND EXISTS(SELECT 1 FROM users t WHERE t.id=?)`,
          [workspaceId, op.actorId, userId],
        ),
        // A membership that already exists is left exactly as it is: the add is
        // idempotent, and it never replaces a role the caller did not set.
        env.DB.prepare(
          `INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
           VALUES(?,?,?,?,?)`,
        ).bind(workspaceId, userId, role, now, now),
        versionBump,
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?) AND ${committed}`,
          [workspaceId, userId, op.id],
        ),
        versionHeld,
      ];
    }
    case "workspace-member-role": {
      const workspaceId = payload.workspaceId as string;
      const userId = payload.userId as string;
      const role = payload.role as string;
      return [
        preparedAck,
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=? AND x.user_id=? AND x.role='admin')
           AND EXISTS(SELECT 1 FROM workspace_members t WHERE t.workspace_id=? AND t.user_id=?)`,
          [workspaceId, op.actorId, workspaceId, userId],
        ),
        // The database refuses to leave the workspace without an admin even if the
        // checks above were somehow bypassed: this statement then fails the batch.
        env.DB.prepare(
          `UPDATE workspace_members SET role=?,updated_at=? WHERE workspace_id=? AND user_id=?`,
        ).bind(role, now, workspaceId, userId),
        versionBump,
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role=?) AND ${committed}`,
          [workspaceId, userId, role, op.id],
        ),
        versionHeld,
      ];
    }
    case "workspace-member-remove": {
      const workspaceId = payload.workspaceId as string;
      const userId = payload.userId as string;
      return [
        preparedAck,
        assertion(env, REMOVE_AUTHORITY, [workspaceId, op.actorId, userId]),
        env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?`).bind(
          workspaceId,
          userId,
        ),
        // A removal (not a self-leave) retires the workspace's invite links (ADR 0079): they are
        // multi-use, so the removed member could rejoin with the one they already used.
        ...(op.actorId !== userId
          ? [env.DB.prepare(`UPDATE workspace_invites SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL`).bind(now, workspaceId)]
          : []),
        versionBump,
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(env, committed, [op.id]),
        assertion(
          env,
          `NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?)`,
          [workspaceId, userId],
        ),
        versionHeld,
      ];
    }
    case "workspace-invite-accept": {
      const workspaceId = payload.workspaceId as string;
      return [
        preparedAck,
        env.DB.prepare(
          `INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
           SELECT ?,?,wi.role,?,? FROM workspace_invites wi
            WHERE wi.id=? AND wi.workspace_id=? AND wi.token_hash=? AND wi.revoked_at IS NULL AND wi.expires_at>?
              AND ${INVITER_IS_ADMIN}`,
        ).bind(
          workspaceId,
          op.actorId,
          now,
          now,
          payload.inviteId as string,
          workspaceId,
          payload.inviteHash as string,
          now,
        ),
        versionBump,
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?) AND ${committed}`,
          [workspaceId, op.actorId, op.id],
        ),
        versionHeld,
      ];
    }
    case "board-member-add":
    case "board-member-remove": {
      const boardId = payload.boardId as string;
      const userId = payload.userId as string;
      const permissionBinds = [boardId, op.actorId, op.actorId, op.actorId];
      const write =
        op.kind === "board-member-add"
          ? env.DB.prepare(
              `INSERT OR IGNORE INTO board_members(board_id,user_id,role)
               SELECT ?,?,'member' WHERE EXISTS(SELECT 1 FROM boards WHERE id=?)`,
            ).bind(boardId, userId, boardId)
          : env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?").bind(
              boardId,
              userId,
            );
      const postcondition =
        op.kind === "board-member-add"
          ? `EXISTS(SELECT 1 FROM board_members WHERE board_id=? AND user_id=?)`
          : `NOT EXISTS(SELECT 1 FROM board_members WHERE board_id=? AND user_id=?)`;
      return [
        preparedAck,
        assertion(
          env,
          `${boardAccessPredicate("?", ops)}${op.kind === "board-member-remove" ? ` AND NOT EXISTS(SELECT 1 FROM boards b WHERE b.id=? AND b.owner_id=?) AND ${managerRemovalGuard(ops)}` : ""}`,
          op.kind === "board-member-remove"
            ? [...permissionBinds, boardId, userId, boardId, userId, ...permissionBinds]
            : permissionBinds,
        ),
        write,
        versionBump,
        env.DB.prepare(
          `UPDATE access_change_operations SET phase='committed',outcome='committed',result_json=?,updated_at=?
            WHERE id=? AND phase='preparing' AND effect_started=0`,
        ).bind(resultJson, now, op.id),
        assertion(env, `${postcondition} AND ${committed}`, [boardId, userId, op.id]),
        versionHeld,
      ];
    }
  }
}

function resultFor(kind: AccessChangeKind, payload: Record<string, unknown>): unknown {
  switch (kind) {
    case "board-move":
      return {
        boardId: payload.boardId,
        workspaceId: payload.destinationWorkspaceId,
        accessMode: "restricted",
      };
    case "workspace-invite-accept":
      return { workspaceId: payload.workspaceId };
    case "workspace-member-add":
      // Deliberately no role: an add that found an existing membership left that
      // row untouched, so the request's role is not what the workspace now holds.
      return { workspaceId: payload.workspaceId, userId: payload.userId };
    case "board-delete":
      return { ok: true };
    default:
      return { ok: true };
  }
}

/**
 * Applies the reserved change, or aborts when the authority for it is gone. A
 * failed batch only aborts when a fresh read agrees the preconditions are
 * definitively unmet; anything else stays preparing for retry.
 */
async function commitOrAbort(
  env: Env,
  op: OperationRow,
  payload: Record<string, unknown>,
  participants: ParticipantRow[],
  budget: Budget,
): Promise<"committed" | "aborted" | "retry"> {
  if (budget.expired) return "retry";
  const evaluation = await evaluateCommit(env, op, payload);
  if (!evaluation.ok) {
    await abortOperation(env, op, participants, evaluation.reason);
    return "aborted";
  }
  const actor = await env.DB.prepare("SELECT email FROM users WHERE id=?")
    .bind(op.actorId)
    .first<{ email: string }>();
  const operator = actor ? isAdminEmail(env, actor.email) : false;
  try {
    await env.DB.batch(
      commitStatements(env, op, payload, participants, operator, resultFor(op.kind, payload)),
    );
    return "committed";
  } catch (error) {
    const retryEvaluation = await evaluateCommit(env, op, payload);
    if (retryEvaluation.ok) throw error;
    await abortOperation(env, op, participants, retryEvaluation.reason);
    return "aborted";
  }
}

async function abortOperation(
  env: Env,
  op: OperationRow,
  participants: ParticipantRow[],
  reason: string,
): Promise<boolean> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE access_change_operations SET phase='aborted',outcome='aborted',result_json=?,updated_at=?
        WHERE id=? AND phase='preparing' AND effect_started=0`,
    ).bind(JSON.stringify(reason), now, op.id),
    ...participants.map((participant) =>
      // The reserved generation is consumed without a policy change, so the
      // release and every later handshake agree on the same fresh generation.
      env.DB.prepare(
        `UPDATE boards SET access_version=? WHERE id=? AND access_version=? AND pending_access_operation_id=?`,
      ).bind(participant.nextVersion, participant.boardId, participant.expectedVersion, op.id),
    ),
    assertion(env, `(SELECT phase FROM access_change_operations WHERE id=? )='aborted'`, [op.id]),
  ];
  try {
    await env.DB.batch(statements);
    return true;
  } catch {
    return false;
  }
}

/** Durably marks the point of no return before the terminal DO deletion runs. */
async function stageBoardDeletion(
  env: Env,
  op: OperationRow,
  payload: Record<string, unknown>,
): Promise<"staged" | "aborted" | "retry"> {
  const evaluation = await evaluateCommit(env, op, payload);
  if (!evaluation.ok) {
    const participants = await loadParticipants(env, op.id);
    await abortOperation(env, op, participants, evaluation.reason);
    return "aborted";
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE access_change_operations SET effect_started=1,updated_at=?
          WHERE id=? AND phase='preparing' AND effect_started=0`,
      ).bind(Date.now(), op.id),
      assertion(
        env,
        `(SELECT effect_started FROM access_change_operations WHERE id=?)=1
         AND (SELECT phase FROM access_change_operations WHERE id=?)='preparing'`,
        [op.id, op.id],
      ),
    ]);
    return "staged";
  } catch {
    return "retry";
  }
}

/**
 * Commits a deletion whose DO effect already started. There is no abort path
 * here: a failed batch stays preparing so the next pass retries it.
 */
async function commitStagedDeletion(
  env: Env,
  op: OperationRow,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    await env.DB.batch(commitStatements(env, op, payload, [], false, { ok: true }));
    return true;
  } catch {
    return false;
  }
}

/** The existing terminal BoardDO deletion path; retried after a lost response. */
async function deleteBoardContent(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  return boardClient(env, payload.boardId as string).deleteBoard(PARTICIPANT_CALL_TIMEOUT_MS);
}

async function releaseParticipants(env: Env, op: OperationRow): Promise<boolean> {
  const participants = (await loadParticipants(env, op.id)).filter((row) => row.released === 0);
  if (participants.length === 0) return true;
  if (op.kind === "board-delete" && op.outcome === "committed") {
    // The DO storage is gone: mark the journal released without recreating it.
    // Only a deletion that actually reached its terminal effect skipped the local
    // release. An aborted deletion left the board in place and still frozen, so it
    // must be released like any other attempt or the board stays unusable forever
    // with no unfinished operation left for recovery to find.
    await env.DB.prepare(
      `UPDATE access_change_boards SET released=1 WHERE operation_id=?`,
    )
      .bind(op.id)
      .run();
    return true;
  }
  let complete = true;
  await mapChunks(participants, PARTICIPANT_CONCURRENCY, async (participant) => {
    if (
      !(await boardClient(env, participant.boardId).releaseAccess(
        { operationId: op.id, generation: participant.nextVersion },
        PARTICIPANT_CALL_TIMEOUT_MS,
      ))
    ) {
      complete = false;
      return;
    }
    await env.DB.prepare(
      `UPDATE access_change_boards SET released=1 WHERE operation_id=? AND board_id=?`,
    )
      .bind(op.id, participant.boardId)
      .run();
  });
  return complete;
}

async function completeOperation(env: Env, op: OperationRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE boards SET pending_access_operation_id=NULL WHERE pending_access_operation_id=?`).bind(
      op.id,
    ),
    env.DB.prepare("DELETE FROM access_change_scopes WHERE operation_id=?").bind(op.id),
    env.DB.prepare(
      `UPDATE access_change_operations SET phase='completed',updated_at=? WHERE id=? AND phase IN ('committed','aborted')`,
    ).bind(Date.now(), op.id),
    assertion(env, `(SELECT phase FROM access_change_operations WHERE id=? )='completed'`, [op.id]),
  ]);
}

function contextsFromPayload(payload: Record<string, unknown>): {
  workspaceIds: string[];
  boardIds: string[];
} {
  const workspaceIds: string[] = [];
  const boardIds: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) continue;
    if (key.toLowerCase().endsWith("workspaceid")) workspaceIds.push(value);
    else if (key === "boardId") boardIds.push(value);
  }
  return { workspaceIds: [...new Set(workspaceIds)], boardIds: [...new Set(boardIds)] };
}

/**
 * The contexts each recipient can still reach, read once for the whole batch. The
 * captured pre-change subset is unioned with this, so a recipient keeps what they
 * already knew and never learns a context they cannot read. A configured operator
 * reaches every context this attempt names — that is its global discovery right —
 * while a workspace id still has to hold a board, exactly as the workspace list
 * counts an operator's entries, so no nonmember surface is invented here.
 */
async function currentRecipientVisibility(
  env: Env,
  userIds: string[],
  contexts: { workspaceIds: string[]; boardIds: string[] },
): Promise<Map<string, CapturedRecipient>> {
  const visible = new Map<string, CapturedRecipient>();
  if (userIds.length === 0) return visible;
  const operators = operatorEmailClauses(env, "u.email");
  const operatorWorkspaceArm = `(${operators.sql} AND EXISTS(SELECT 1 FROM boards wb WHERE wb.workspace_id=w.id))`;
  const workspaceList = contexts.workspaceIds.length > 0 ? placeholders(contexts.workspaceIds.length) : "NULL";
  const boardList = contexts.boardIds.length > 0 ? placeholders(contexts.boardIds.length) : "NULL";
  // D1 caps bound parameters per statement, and a board that has been shared for a
  // while can name far more recipients than that. The recipients are therefore read
  // in bounded chunks — never truncated — and merged into one view. The operator
  // clause is bound once per context subquery, so it is budgeted twice.
  const chunkSize = Math.max(
    1,
    RECIPIENT_PARAMETER_BUDGET -
      contexts.workspaceIds.length -
      contexts.boardIds.length -
      operators.binds.length * 2,
  );
  for (let index = 0; index < userIds.length; index += chunkSize) {
    const chunk = userIds.slice(index, index + chunkSize);
    const row = await env.DB.prepare(
      `SELECT COALESCE(json_group_array(json_object('id',u.id,
                'workspaces',json(COALESCE((SELECT json_group_array(w.id) FROM workspaces w
                         WHERE w.id IN (${workspaceList})
                           AND (EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=u.id)
                                OR EXISTS(SELECT 1 FROM boards b WHERE b.workspace_id=w.id AND ${RECIPIENT_BOARD_ACCESS})
                                OR ${operatorWorkspaceArm})),'[]')),
                'boards',json(COALESCE((SELECT json_group_array(b.id) FROM boards b
                         WHERE b.id IN (${boardList})
                           AND (${RECIPIENT_BOARD_ACCESS} OR ${operators.sql})),'[]')))),'[]') AS recipients
         FROM users u WHERE u.id IN (${placeholders(chunk.length)})`,
    )
      .bind(
        ...contexts.workspaceIds,
        ...operators.binds,
        ...contexts.boardIds,
        ...operators.binds,
        ...chunk,
      )
      .first<{ recipients: string }>();
    for (const recipient of parseCapturedRecipients(row?.recipients ?? "[]")) {
      visible.set(recipient.id, recipient);
    }
  }
  return visible;
}

/**
 * Targeted presence hint. Each recipient receives only the contexts that user may
 * know, so moving a board into a restricted workspace never discloses its id or the
 * destination to members who were never invited to it. A lost notification is
 * retried from the journal independently of the locks, so this never throws: the
 * policy change it reports is already committed, and its own caller must not be
 * told the change failed because the hint could not be delivered.
 */
async function notifyOperation(env: Env, op: OperationRow): Promise<void> {
  if (op.notified === 1) return;
  try {
    await deliverNotification(env, op);
  } catch {
    // Leaves `notified=0`, which is exactly what the recovery pass looks for.
  }
}

async function deliverNotification(env: Env, op: OperationRow): Promise<void> {
  const markNotified = () =>
    env.DB.prepare(
      `UPDATE access_change_operations SET notified=1,updated_at=? WHERE id=? AND notified=0`,
    )
      .bind(Date.now(), op.id)
      .run();
  if (op.outcome !== "committed") {
    await markNotified();
    return;
  }
  const captured = parseCapturedRecipients(op.notifyUserIdsJson);
  if (captured.length === 0) {
    await markNotified();
    return;
  }
  const payload = parsePayload(op);
  const contexts = payload ? contextsFromPayload(payload) : { workspaceIds: [], boardIds: [] };
  const current = await currentRecipientVisibility(
    env,
    captured.map((recipient) => recipient.id),
    contexts,
  );
  const targets = captured
    .map((recipient) => {
      const now = current.get(recipient.id);
      return {
        userId: recipient.id,
        workspaceIds: [...new Set([...recipient.workspaces, ...(now?.workspaces ?? [])])],
        boardIds: [...new Set([...recipient.boards, ...(now?.boards ?? [])])],
      };
    })
    .filter((target) => target.workspaceIds.length > 0 || target.boardIds.length > 0);
  if (targets.length === 0) {
    await markNotified();
    return;
  }
  if (await sendPresenceInvalidate(env, targets)) await markNotified();
}

/**
 * The one sender of the presence `invalidate` hint: each target is a user and the
 * workspaces and boards that user should refetch. Sent in bounded batches for the same
 * reason the visibility read is: a long-lived board can name more recipients than one
 * request may carry. Resolves false when a batch was not accepted, and rejects on a
 * network failure or timeout; callers decide whether the hint is worth a retry.
 */
export async function sendPresenceInvalidate(
  env: Env,
  targets: Array<{ userId: string; workspaceIds: string[]; boardIds: string[] }>,
): Promise<boolean> {
  for (let index = 0; index < targets.length; index += RECIPIENT_PARAMETER_BUDGET) {
    const response = await env.PRESENCE_DO.get(env.PRESENCE_DO.idFromName("global")).fetch(
      "https://presence.internal/internal/workspaces/invalidate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: targets.slice(index, index + RECIPIENT_PARAMETER_BUDGET) }),
        signal: AbortSignal.timeout(PARTICIPANT_CALL_TIMEOUT_MS),
      },
    );
    if (!response.ok) return false;
  }
  return true;
}

function pendingOf(state: AccessChangePending["state"], operationId: string): AccessChangePending {
  return { operationId, state, recoveryPending: true };
}

/**
 * Drives one journal row as far as it can go: reserve (already done) → prepare →
 * commit/abort → release → completion → notification. Safe to run concurrently
 * with itself and with the cron pass; every step re-reads its own preconditions.
 */
async function driveOperation(
  env: Env,
  op: OperationRow,
  budget: Budget,
): Promise<AccessChangePending | AccessChangeResult> {
  let phase: OperationPhase = op.phase;

  if (phase === "preparing") {
    const payload = parsePayload(op);
    if (!payload) {
      const participants = await loadParticipants(env, op.id);
      if (!(await abortOperation(env, op, participants, ACCESS_CHANGE_ABORT.invalidPayload)))
        return pendingOf("preparing", op.id);
      phase = "aborted";
    } else if (op.kind === "board-delete" && op.effectStarted === 1) {
      // A staged deletion: recovery may only finish it, never abort or reopen it.
      const participants = await loadParticipants(env, op.id);
      if (!(await ensurePrepared(env, op, participants, budget)))
        return pendingOf("preparing", op.id);
      if (!(await deleteBoardContent(env, payload))) return pendingOf("preparing", op.id);
      if (!(await commitStagedDeletion(env, op, payload))) return pendingOf("preparing", op.id);
      phase = "committed";
    } else {
      const participants = await loadParticipants(env, op.id);
      if (!(await ensurePrepared(env, op, participants, budget)))
        return pendingOf("preparing", op.id);
      if (op.kind === "board-delete") {
        const stage = await stageBoardDeletion(env, op, payload);
        if (stage === "retry") return pendingOf("preparing", op.id);
        if (stage === "aborted") phase = "aborted";
        else {
          if (!(await deleteBoardContent(env, payload))) return pendingOf("preparing", op.id);
          if (!(await commitStagedDeletion(env, op, payload))) return pendingOf("preparing", op.id);
          phase = "committed";
        }
      } else {
        const commit = await commitOrAbort(env, op, payload, participants, budget);
        if (commit === "retry") return pendingOf("preparing", op.id);
        phase = commit;
      }
    }
  }

  if (phase === "committed" || phase === "aborted") {
    const current = await readOperation(env, op.id);
    if (!current) return pendingOf(phase, op.id);
    if (!(await releaseParticipants(env, current))) return pendingOf(phase, op.id);
    await completeOperation(env, current);
    phase = "completed";
  }

  const settled = await readOperation(env, op.id);
  if (!settled || settled.phase !== "completed")
    return pendingOf(
      settled ? (settled.phase as Exclude<OperationPhase, "completed">) : "preparing",
      op.id,
    );
  await notifyOperation(env, settled);
  return {
    operationId: settled.id,
    state: "completed",
    outcome: settled.outcome ?? "committed",
    result: settled.resultJson ? JSON.parse(settled.resultJson) : null,
  };
}

/**
 * Every policy context this attempt fences, with the recipient snapshot taken in
 * the same transaction. The operation row, its scopes, its participants and the
 * snapshot are therefore all-or-nothing: an attempt that exists always knows who
 * must be told, and a crash cannot leave one behind without the other.
 */
function journalOperationWithCapture(
  env: Env,
  operationId: string,
  actorId: string,
  kind: AccessChangeKind,
  payloadJson: string,
  payloadHash: string,
  explicitUserIds: string[],
  now: number,
): D1PreparedStatement {
  const clauses: string[] = [];
  const clauseBinds: unknown[] = [];
  clauses.push(
    `EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.user_id=u.id
        AND wm.workspace_id IN (SELECT workspace_id FROM access_change_scopes WHERE operation_id=?))`,
  );
  clauseBinds.push(operationId);
  clauses.push(
    `EXISTS(SELECT 1 FROM board_members bm WHERE bm.user_id=u.id
        AND bm.board_id IN (SELECT board_id FROM access_change_boards WHERE operation_id=?))`,
  );
  clauseBinds.push(operationId);
  clauses.push(
    `EXISTS(SELECT 1 FROM boards b WHERE b.id IN (SELECT board_id FROM access_change_boards WHERE operation_id=?)
        AND ${RECIPIENT_BOARD_ACCESS})`,
  );
  clauseBinds.push(operationId);
  if (explicitUserIds.length > 0) {
    clauses.push(`u.id IN (${placeholders(explicitUserIds.length)})`);
    clauseBinds.push(...explicitUserIds);
  }
  const operators = operatorEmailClauses(env, "u.email");
  const operatorWorkspaceArm = `(${operators.sql} AND EXISTS(SELECT 1 FROM boards wb WHERE wb.workspace_id=w.id))`;
  if (operators.sql !== "0") {
    clauses.push(operators.sql);
    clauseBinds.push(...operators.binds);
  }
  const sql = `INSERT INTO access_change_operations
      (id,actor_id,kind,payload_json,payload_hash,notify_user_ids_json,phase,created_at,updated_at)
    SELECT ?,?,?,?,?,
      COALESCE((SELECT json_group_array(json_object('id',r.id,
                 'workspaces',json(r.workspaces),'boards',json(r.boards)))
                  FROM (SELECT u.id AS id,
                          COALESCE((SELECT json_group_array(w.id) FROM workspaces w
                                     WHERE w.id IN (SELECT workspace_id FROM access_change_scopes WHERE operation_id=?)
                                       AND (EXISTS(SELECT 1 FROM workspace_members wmv WHERE wmv.workspace_id=w.id AND wmv.user_id=u.id)
                                            OR EXISTS(SELECT 1 FROM boards b WHERE b.workspace_id=w.id AND ${RECIPIENT_BOARD_ACCESS})
                                            OR ${operatorWorkspaceArm})),'[]') AS workspaces,
                          COALESCE((SELECT json_group_array(b.id) FROM boards b
                                     WHERE b.id IN (SELECT board_id FROM access_change_boards WHERE operation_id=?)
                                       AND (${RECIPIENT_BOARD_ACCESS} OR ${operators.sql})),'[]') AS boards
                         FROM users u WHERE ${clauses.join(" OR ")}) r),'[]'),
      'preparing',?,?`;
  return env.DB.prepare(sql).bind(
    operationId,
    actorId,
    kind,
    payloadJson,
    payloadHash,
    operationId,
    ...operators.binds,
    operationId,
    ...operators.binds,
    ...clauseBinds,
    now,
    now,
  );
}

/**
 * The actor's authority for this attempt, re-asserted inside the reservation
 * transaction. The routes check the same authority before calling, but their read
 * happens outside the lock: only here does it still hold while the scopes are held.
 */
function authorityAssertions(
  env: Env,
  actor: SessionUser,
  kind: AccessChangeKind,
  payload: Record<string, unknown>,
): D1PreparedStatement[] {
  const ops = isAdminEmail(env, actor.email) ? 1 : 0;
  const workspaceId = payload.workspaceId as string;
  const boardId = payload.boardId as string;
  const boardPermission = boardAccessPredicate("?", ops);
  const boardManagement = boardManagementPredicate("?", ops);
  switch (kind) {
    case "workspace-member-add":
      // The manager predicate and the existence of the target account are
      // re-asserted while the workspace scope is held. The scope row itself is the
      // workspace's transition lock: its primary key is what makes a reservation on
      // an already-locked workspace fail, exactly as the settings route reads it.
      return [
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=? AND x.user_id=? AND x.role='admin')
           AND EXISTS(SELECT 1 FROM users t WHERE t.id=?)`,
          [workspaceId, actor.id, payload.userId as string],
        ),
      ];
    case "workspace-member-role":
      return [
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=? AND x.user_id=? AND x.role='admin')
           AND EXISTS(SELECT 1 FROM workspace_members t WHERE t.workspace_id=? AND t.user_id=?)`,
          [workspaceId, actor.id, workspaceId, payload.userId as string],
        ),
      ];
    case "workspace-member-remove":
      return [
        assertion(env, REMOVE_AUTHORITY, [workspaceId, actor.id, payload.userId as string]),
      ];
    case "workspace-invite-accept":
      return [
        assertion(
          env,
          `EXISTS(SELECT 1 FROM workspace_invites wi WHERE wi.id=? AND wi.workspace_id=? AND wi.token_hash=?
              AND wi.revoked_at IS NULL AND wi.expires_at>? AND ${INVITER_IS_ADMIN})`,
          [
            payload.inviteId as string,
            workspaceId,
            payload.inviteHash as string,
            Date.now(),
          ],
        ),
      ];
    case "board-move":
      return [
        assertion(
          env,
          `${boardManagement} AND EXISTS(SELECT 1 FROM workspace_members d WHERE d.workspace_id=? AND d.user_id=?)`,
          [
            boardId,
            actor.id,
            actor.id,
            actor.id,
            payload.destinationWorkspaceId as string,
            actor.id,
          ],
        ),
      ];
    case "board-delete":
      return [
        assertion(env, boardManagement, [boardId, actor.id, actor.id, actor.id]),
      ];
    case "board-member-add":
      return [
        assertion(env, boardPermission, [boardId, actor.id, actor.id, actor.id]),
      ];
    case "board-member-remove":
      // Removing a grant the target does not hold is an idempotent success, not a
      // policy change: the postcondition the commit checks is already true.
      return [
        assertion(
          env,
          `${boardPermission} AND NOT EXISTS(SELECT 1 FROM boards o WHERE o.id=? AND o.owner_id=?) AND ${managerRemovalGuard(ops)}`,
          [boardId, actor.id, actor.id, actor.id, boardId, payload.userId as string, boardId, payload.userId as string, boardId, actor.id, actor.id, actor.id],
        ),
      ];
  }
}

/**
 * Reserves an attempt in one guarded transaction: locks every workspace scope,
 * fences and materializes its boards, re-asserts the actor's authority, and
 * journals the attempt together with its recipient snapshot. The trailing
 * assertions prove the fences are exactly the participants this journal names, so
 * a board created, moved or already fenced between the caller's read and this
 * transaction cannot be silently left outside the boundary.
 */
async function reserveOperation(
  env: Env,
  actor: SessionUser,
  input: AccessChangeInput,
  payload: Record<string, unknown>,
  payloadJson: string,
  payloadHash: string,
): Promise<void> {
  const now = Date.now();
  const explicitUserIds = [payload.userId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const boards = input.boards ?? [];
  const inheritedWorkspaceIds = input.inheritWorkspaceBoards ? input.workspaceIds : [];
  const participantInsert = (where: string) =>
    `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
     SELECT ?,id,access_version,access_version+1,0,0 FROM boards
      WHERE ${where} AND pending_access_operation_id IS NULL`;
  const statements: D1PreparedStatement[] = [
    ...input.workspaceIds.map((workspaceId) =>
      env.DB.prepare(
        `INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)`,
      ).bind(workspaceId, input.operationId),
    ),
    ...boards.map((board) =>
      env.DB.prepare(participantInsert("id=? AND workspace_id=?")).bind(
        input.operationId,
        board.boardId,
        board.workspaceId,
      ),
    ),
    ...inheritedWorkspaceIds.map((workspaceId) =>
      env.DB.prepare(participantInsert("workspace_id=?")).bind(
        input.operationId,
        workspaceId,
      ),
    ),
    ...boards.map((board) =>
      env.DB.prepare(
        `UPDATE boards SET pending_access_operation_id=?
          WHERE id=? AND workspace_id=? AND pending_access_operation_id IS NULL`,
      ).bind(input.operationId, board.boardId, board.workspaceId),
    ),
    ...inheritedWorkspaceIds.map((workspaceId) =>
      env.DB.prepare(
        `UPDATE boards SET pending_access_operation_id=?
          WHERE workspace_id=? AND pending_access_operation_id IS NULL`,
      ).bind(input.operationId, workspaceId),
    ),
    assertion(
      env,
      `(SELECT COUNT(*) FROM access_change_boards WHERE operation_id=?)=(SELECT COUNT(*) FROM boards WHERE pending_access_operation_id=?)`,
      [input.operationId, input.operationId],
    ),
    ...boards.map((board) =>
      assertion(
        env,
        `EXISTS(SELECT 1 FROM access_change_boards p JOIN boards b ON b.id=p.board_id
                  WHERE p.operation_id=? AND p.board_id=? AND b.workspace_id=?)`,
        [input.operationId, board.boardId, board.workspaceId],
      ),
    ),
    ...inheritedWorkspaceIds.map((workspaceId) =>
      assertion(
        env,
        `(SELECT COUNT(*) FROM access_change_boards p JOIN boards b ON b.id=p.board_id
           WHERE p.operation_id=? AND b.workspace_id=?)
         =(SELECT COUNT(*) FROM boards WHERE workspace_id=?)`,
        [input.operationId, workspaceId, workspaceId],
      ),
    ),
    ...authorityAssertions(env, actor, input.kind, payload),
    journalOperationWithCapture(
      env,
      input.operationId,
      actor.id,
      input.kind,
      payloadJson,
      payloadHash,
      explicitUserIds,
      now,
    ),
    assertion(
      env,
      `json_array_length((SELECT notify_user_ids_json FROM access_change_operations WHERE id=?))>0`,
      [input.operationId],
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    throw new AccessChangeConflict();
  }
}

/**
 * Answers an attempt that already exists for this actor, driving it forward when it
 * is still running. Routes call it before rebuilding any payload field that a
 * successful attempt legitimately changes, so a lost-response retry replays the
 * recorded resolution instead of conflicting with it.
 *
 * The attempt id is bound to the request it was issued for: every key of `bound` is
 * the caller's own immutable input — the board in the path, the destination, the
 * role, an invitation token's digest — and must still match the recorded payload.
 * Everything else in that payload (owner, expected version, the grant an attempt
 * resolved for itself) is deliberately not compared, because a retry cannot
 * reproduce it without diverging from the resolution it is asking to replay. A
 * different kind, actor or endpoint input under one id is a genuine conflict: two
 * mutations must never share one identity.
 */
export async function resolveAccessChangeAttempt(
  env: Env,
  actor: SessionUser,
  operationId: string,
  kind: AccessChangeKind,
  bound: Record<string, string | number | boolean>,
): Promise<AccessChangeResult | AccessChangePending | null> {
  const existing = await readOperation(env, operationId);
  if (!existing) return null;
  if (existing.actorId !== actor.id || existing.kind !== kind) throw new AccessChangeConflict();
  const recorded = parsePayload(existing);
  const boundFields = Object.entries(bound);
  if (recorded === null || boundFields.some(([field, value]) => recorded[field] !== value))
    throw new AccessChangeConflict();
  return driveOperation(env, existing, Budget.foreground());
}

/**
 * Reserves an attempt and drives it to a terminal state, or returns the pending
 * envelope when the bounded foreground window runs out. Recovery finishes it.
 */
export async function runAccessChange(
  env: Env,
  actor: SessionUser,
  input: AccessChangeInput,
): Promise<AccessChangeResult | AccessChangePending> {
  const parsed = PAYLOAD_SCHEMAS[input.kind].safeParse(input.payload);
  if (!parsed.success) throw new AccessChangeConflict();
  const payload = parsed.data as Record<string, unknown>;
  const payloadJson = canonical(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const existing = await readOperation(env, input.operationId);
  if (existing) {
    if (
      existing.actorId !== actor.id ||
      existing.kind !== input.kind ||
      existing.payloadHash !== payloadHash
    )
      throw new AccessChangeConflict();
    return driveOperation(env, existing, Budget.foreground());
  }
  await reserveOperation(env, actor, input, payload, payloadJson, payloadHash);
  const reserved = await readOperation(env, input.operationId);
  if (!reserved) throw new AccessChangeConflict();
  return driveOperation(env, reserved, Budget.foreground());
}

const OperationIdSchema = z.string().uuid();

export const accessChangesRouter = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/:operationId", async (c) => {
    const parsed = OperationIdSchema.safeParse(c.req.param("operationId"));
    if (!parsed.success) return c.json({ error: "not found" } as const, 404);
    const row = await readOperation(c.env, parsed.data);
    if (!row || row.actorId !== c.get("user").id)
      return c.json({ error: "not found" } as const, 404);
    // An interrupted attempt has to make progress when its own actor asks for it,
    // not only when the cron pass next runs: the caller is the one waiting.
    if (row.phase !== "completed") {
      const driven = await driveOperation(c.env, row, Budget.foreground());
      return c.json(driven, driven.state === "completed" ? 200 : 202);
    }
    return c.json({
      operationId: row.id,
      state: "completed",
      outcome: row.outcome ?? "committed",
      result: row.resultJson ? JSON.parse(row.resultJson) : null,
    } as const);
  });

/**
 * Settled journal rows are kept for a replay window: a client that lost the response to an
 * attempt can retry it with the same operation id and get the recorded answer for this long.
 * After that the row is deleted (it is the table's only growth), and a replay finds no
 * attempt: `resolveAccessChangeAttempt` answers null and the route treats the request as a
 * new attempt, which the board's current state either repeats idempotently or refuses.
 */
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

/**
 * Deletes completed, notified operations older than the retention window, with their
 * participant rows (the scope rows are already gone at completion). One batch, so a row
 * never loses its children alone; a backlog drains `PRUNE_BATCH` rows per cron pass.
 */
export async function pruneAccessChanges(env: Env, now = Date.now()): Promise<void> {
  const stale = `SELECT id FROM access_change_operations
     WHERE phase='completed' AND notified=1 AND updated_at<?
     ORDER BY updated_at LIMIT ${PRUNE_BATCH}`;
  const cutoff = now - SETTLED_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM access_change_boards WHERE operation_id IN (${stale})`).bind(cutoff),
    env.DB.prepare(`DELETE FROM access_change_operations WHERE id IN (${stale})`).bind(cutoff),
  ]);
}

/**
 * Deletes workspace invites that expired or were revoked more than the retention window ago.
 * Nothing reads them: the list, inspect and accept all want a live invite.
 */
export async function pruneWorkspaceInvites(env: Env, now = Date.now()): Promise<void> {
  const cutoff = now - SETTLED_RETENTION_MS;
  await env.DB.prepare(
    `DELETE FROM workspace_invites WHERE id IN
       (SELECT id FROM workspace_invites WHERE expires_at<? OR revoked_at<? LIMIT ${PRUNE_BATCH})`,
  )
    .bind(cutoff, cutoff)
    .run();
}

/**
 * Cron recovery: resumes preparing attempts through commit/abort, releases and
 * completes them, and retries notifications that were lost after completion.
 * Every step is idempotent, so simultaneous passes and restarts converge.
 */
export async function recoverAccessChanges(env: Env): Promise<void> {
  // The (phase,notified,updated_at) index serves this as range scans: a bare
  // `phase<>'completed'` would read every settled row (the table's bulk) instead.
  const { results } = await env.DB.prepare(
    `SELECT id,actor_id AS actorId,kind,payload_json AS payloadJson,payload_hash AS payloadHash,
            phase,outcome,result_json AS resultJson,notify_user_ids_json AS notifyUserIdsJson,
            notified,effect_started AS effectStarted
       FROM access_change_operations
      WHERE phase IN ('preparing','committed','aborted') OR (phase='completed' AND notified=0)
      ORDER BY updated_at LIMIT ?`,
  )
    .bind(RECOVERY_OPERATION_LIMIT)
    .all<OperationRow>();
  if (results.length > 0) {
    const deadline = Date.now() + RECOVERY_PASS_BUDGET_MS;
    // A dependency failure (a throw) or a row that is still not completed (a participant that
    // did not answer) leaves it for the next pass; time never unlocks. Bumping `updated_at`
    // sends it to the back of the oldest-first queue, so a few rows that keep failing cannot
    // hold every slot of the pass and starve newer operations.
    const deferOperation = async (id: string) => {
      try {
        await env.DB.prepare("UPDATE access_change_operations SET updated_at=? WHERE id=?").bind(Date.now(), id).run();
      } catch {
        // Best effort: the row is simply retried first next pass.
      }
    };
    await mapChunks(results, RECOVERY_CONCURRENCY, async (operation) => {
      try {
        await driveOperation(env, operation, Budget.until(deadline));
      } catch (error) {
        console.warn(`[access-changes] recovery of operation ${operation.id} failed:`, error instanceof Error ? error.message : error);
      }
      // Every visited row goes to the back, completed ones too: a notification that keeps failing is
      // swallowed inside driveOperation, so "completed" does not mean the row left the queue.
      await deferOperation(operation.id);
    });
  }
  // Housekeeping goes last: a database error here must never keep stuck operations from being recovered.
  try {
    await pruneAccessChanges(env);
    await pruneWorkspaceInvites(env);
  } catch (error) {
    console.warn("[access-changes] prune failed:", error instanceof Error ? error.message : error);
  }
}
