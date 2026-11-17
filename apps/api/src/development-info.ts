import { DevelopmentBranchSchema, DevelopmentPullRequestSchema, type DevelopmentBranch, type DevelopmentPullRequest } from "@foxban/shared";
import { z } from "zod";
import { MAX_TASK_KEYS } from "./task-keys";

/**
 * Development info stored in a BoardDO (ADR 0064): the pull requests and branches
 * linked to its cards. One row per (card, PR) or (card, branch), so a link follows
 * the card and the row carries the last accepted state; one PR on two cards of a
 * board is two rows. A branch row holds only its latest commit, never history.
 */

/** The manual link body the board receives: the PR as the Worker just read it from GitHub. */
export const PullRequestLinkSchema = z.strictObject({ pullRequest: DevelopmentPullRequestSchema });
/** The manual unlink body: which pull request to drop from the card. */
export const PullRequestUnlinkSchema = z.strictObject({
  repositoryId: z.number().int().positive(),
  number: z.number().int().positive(),
});

/** The manual unlink body: which branch to drop from the card. */
export const BranchUnlinkSchema = z.strictObject({
  repositoryId: z.number().int().positive(),
  name: DevelopmentBranchSchema.shape.name,
});

/**
 * What a board is told about one pull request event: the PR as it now stands, and
 * the task numbers (of this board's key) its text named. The board links those
 * cards on first sight and keeps every card it already linked up to date.
 */
export const PullRequestWriteSchema = z.strictObject({
  pullRequest: DevelopmentPullRequestSchema,
  taskNumbers: z.array(z.number().int().min(1)).max(MAX_TASK_KEYS),
});
export type PullRequestWrite = z.infer<typeof PullRequestWriteSchema>;

export type PullRequestWriteResult = {
  /** Cards whose development info this write changed. */
  changedCardIds: string[];
  /** Whether the board links the pull request to any card after the write. */
  linked: boolean;
};

/** Whether the stored row already says what this pull request says now, so rewriting it would change nothing. */
function isCurrent(stored: DevelopmentPullRequest, pullRequest: DevelopmentPullRequest): boolean {
  return (
    stored.repository === pullRequest.repository &&
    stored.title === pullRequest.title &&
    stored.state === pullRequest.state &&
    stored.url === pullRequest.url &&
    stored.updatedAt === pullRequest.updatedAt
  );
}

/**
 * Applies one pull request event. A row is written unless the stored `updated_at` is
 * later than the event's, so a late delivery cannot roll state back. An equal one still
 * writes: `updated_at` has one-second resolution, so a follow-up in the same second must
 * win, while a replay (nothing differs) writes nothing and tells nobody.
 * Already-linked cards update whatever the text says now; named cards are linked once.
 * Runs inside the caller's transaction.
 */
export function writePullRequest(sql: SqlStorage, { pullRequest, taskNumbers }: PullRequestWrite): PullRequestWriteResult {
  const targets = new Map<string, DevelopmentPullRequest | null>(
    sql
      .exec<DevelopmentPullRequest & { cardId: string }>(
        `SELECT card_id AS cardId, repository_id AS repositoryId, number, repository, title, state, url, updated_at AS updatedAt
           FROM card_development_pull_requests WHERE repository_id = ? AND number = ?`,
        pullRequest.repositoryId,
        pullRequest.number,
      )
      .toArray()
      .map(({ cardId, ...stored }) => [cardId, stored]),
  );
  if (taskNumbers.length > 0) {
    const placeholders = taskNumbers.map(() => "?").join(", ");
    // An unlink holds: a card whose member unlinked this PR is never linked by key again.
    const unlinked = unlinkedCardIds(sql, "pull_request", pullRequest.repositoryId, String(pullRequest.number));
    for (const { id } of sql
      .exec<{ id: string }>(`SELECT id FROM cards WHERE archived_at IS NULL AND task_number IN (${placeholders})`, ...taskNumbers)
      .toArray()) {
      if (!targets.has(id) && !unlinked.has(id)) targets.set(id, null);
    }
  }

  const changedCardIds: string[] = [];
  for (const [cardId, stored] of targets) {
    if (stored !== null && (stored.updatedAt > pullRequest.updatedAt || isCurrent(stored, pullRequest))) continue;
    storePullRequest(sql, cardId, pullRequest);
    changedCardIds.push(cardId);
  }
  return { changedCardIds, linked: targets.size > 0 };
}

function storePullRequest(sql: SqlStorage, cardId: string, pullRequest: DevelopmentPullRequest): void {
  sql.exec(
    `INSERT INTO card_development_pull_requests(card_id, repository_id, number, repository, title, state, url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id, repository_id, number) DO UPDATE SET
       repository = excluded.repository, title = excluded.title, state = excluded.state,
       url = excluded.url, updated_at = excluded.updated_at`,
    cardId,
    pullRequest.repositoryId,
    pullRequest.number,
    pullRequest.repository,
    pullRequest.title,
    pullRequest.state,
    pullRequest.url,
    pullRequest.updatedAt,
  );
}

/**
 * Unlinks (ADR 0064): a member removing a link they do not want records a tombstone
 * `(card, kind, repository, ref)` so key matching skips it for that card. `ref` is the
 * PR number as text, or, for the branch kind, the branch name; both kinds write and
 * read the same table through these helpers.
 */
export type UnlinkKind = "pull_request" | "branch";

export function unlinkedCardIds(sql: SqlStorage, kind: UnlinkKind, repositoryId: number, ref: string): Set<string> {
  return new Set(
    sql
      .exec<{ cardId: string }>(
        "SELECT card_id AS cardId FROM card_development_unlinks WHERE kind = ? AND repository_id = ? AND ref = ?",
        kind,
        repositoryId,
        ref,
      )
      .toArray()
      .map((row) => row.cardId),
  );
}

/** Records the tombstone that makes an unlink hold. */
export function recordUnlink(sql: SqlStorage, cardId: string, kind: UnlinkKind, repositoryId: number, ref: string): void {
  sql.exec("INSERT OR IGNORE INTO card_development_unlinks(card_id, kind, repository_id, ref) VALUES (?, ?, ?, ?)", cardId, kind, repositoryId, ref);
}

/** Whether any card on this board still links the pull request, which decides its routing row. */
function pullRequestStillLinked(sql: SqlStorage, repositoryId: number, number: number): boolean {
  return sql.exec("SELECT 1 FROM card_development_pull_requests WHERE repository_id = ? AND number = ? LIMIT 1", repositoryId, number).toArray().length > 0;
}

/**
 * A member links a pull request to a card by hand: it counts as a link with no key
 * match. It lifts the card's tombstone for that PR, and stores the state the Worker
 * just read unless the stored row is newer or already says the same. Runs inside the
 * caller's transaction.
 */
export function linkPullRequestToCard(sql: SqlStorage, cardId: string, pullRequest: DevelopmentPullRequest): { changed: boolean } {
  sql.exec(
    "DELETE FROM card_development_unlinks WHERE card_id = ? AND kind = 'pull_request' AND repository_id = ? AND ref = ?",
    cardId,
    pullRequest.repositoryId,
    String(pullRequest.number),
  );
  const stored = sql
    .exec<DevelopmentPullRequest>(
      `SELECT repository_id AS repositoryId, repository, number, title, state, url, updated_at AS updatedAt
         FROM card_development_pull_requests WHERE card_id = ? AND repository_id = ? AND number = ?`,
      cardId,
      pullRequest.repositoryId,
      pullRequest.number,
    )
    .toArray()[0];
  if (stored && (stored.updatedAt > pullRequest.updatedAt || isCurrent(stored, pullRequest))) return { changed: false };
  storePullRequest(sql, cardId, pullRequest);
  return { changed: true };
}

/** Drops the card's link to a pull request and records the tombstone. `unlinked` is false when the card did not link it. */
export function unlinkPullRequestFromCard(
  sql: SqlStorage,
  cardId: string,
  repositoryId: number,
  number: number,
): { unlinked: boolean; stillLinked: boolean } {
  const removed =
    sql.exec("DELETE FROM card_development_pull_requests WHERE card_id = ? AND repository_id = ? AND number = ?", cardId, repositoryId, number).rowsWritten > 0 ||
    // An old association nobody has opened yet counts as linked: unlinking it tombstones it.
    sql.exec("SELECT 1 FROM card_github_pull_requests WHERE card_id = ? AND repository_id = ? AND pull_number = ?", cardId, repositoryId, number).toArray().length > 0;
  if (removed) recordUnlink(sql, cardId, "pull_request", repositoryId, String(number));
  return { unlinked: removed, stillLinked: pullRequestStillLinked(sql, repositoryId, number) };
}

/**
 * Pull requests an old per-board integration linked to the card (ADR 0041 section 6)
 * that the card's development info does not hold yet, and that nobody has unlinked.
 * The Worker reads each from GitHub and writes it back through the normal path, so a
 * manual link made before this model keeps working without a data migration.
 */
export function readLegacyAssociations(sql: SqlStorage, cardId: string): Array<{ repositoryId: number; number: number; taskNumber: number }> {
  return sql
    .exec<{ repositoryId: number; number: number; taskNumber: number }>(
      `SELECT old.repository_id AS repositoryId, old.pull_number AS number, cards.task_number AS taskNumber
         FROM card_github_pull_requests old
         JOIN cards ON cards.id = old.card_id
        WHERE old.card_id = ? AND cards.task_number IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM card_development_pull_requests dev
                           WHERE dev.card_id = old.card_id AND dev.repository_id = old.repository_id AND dev.number = old.pull_number)
          AND NOT EXISTS (SELECT 1 FROM card_development_unlinks gone
                           WHERE gone.card_id = old.card_id AND gone.kind = 'pull_request'
                             AND gone.repository_id = old.repository_id AND gone.ref = CAST(old.pull_number AS TEXT))`,
      cardId,
    )
    .toArray();
}

/** Gives a card that arrived from another board (ADR 0038) the pull requests it already had; the PRs are the ones `readCardPullRequests` returned there. */
export function importCardPullRequests(sql: SqlStorage, cardId: string, pullRequests: readonly DevelopmentPullRequest[]): void {
  for (const pr of pullRequests) {
    sql.exec(
      `INSERT INTO card_development_pull_requests(card_id, repository_id, number, repository, title, state, url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      cardId,
      pr.repositoryId,
      pr.number,
      pr.repository,
      pr.title,
      pr.state,
      pr.url,
      pr.updatedAt,
    );
  }
}

/** An unlink tombstone as it travels with its card in a transfer bundle: an unlink holds on the destination board too. */
export const DevelopmentUnlinkSchema = z.strictObject({
  kind: z.enum(["pull_request", "branch"]),
  repositoryId: z.number().int().positive(),
  ref: z.string().min(1).max(512),
});
export type DevelopmentUnlink = z.infer<typeof DevelopmentUnlinkSchema>;

export function readCardUnlinks(sql: SqlStorage, cardId: string): DevelopmentUnlink[] {
  return sql
    .exec<DevelopmentUnlink>(
      "SELECT kind, repository_id AS repositoryId, ref FROM card_development_unlinks WHERE card_id = ? ORDER BY kind, repository_id, ref",
      cardId,
    )
    .toArray();
}

export function importCardUnlinks(sql: SqlStorage, cardId: string, unlinks: readonly DevelopmentUnlink[]): void {
  for (const { kind, repositoryId, ref } of unlinks) recordUnlink(sql, cardId, kind, repositoryId, ref);
}

/** A card's pull requests, most recently updated first. */
export function readCardPullRequests(sql: SqlStorage, cardId: string): DevelopmentPullRequest[] {
  return sql
    .exec<DevelopmentPullRequest>(
      `SELECT repository_id AS repositoryId, repository, number, title, state, url, updated_at AS updatedAt
         FROM card_development_pull_requests
        WHERE card_id = ?
        ORDER BY updated_at DESC, repository_id, number`,
      cardId,
    )
    .toArray();
}

/**
 * The pull requests of every active card, for the card fronts: one read instead of one per card.
 * Cards without any are left out. Archived cards are not shown, but keep their rows.
 */
export function readBoardPullRequests(sql: SqlStorage): Array<{ cardId: string; pullRequests: DevelopmentPullRequest[] }> {
  const byCard = new Map<string, DevelopmentPullRequest[]>();
  for (const { cardId, ...pullRequest } of sql
    .exec<DevelopmentPullRequest & { cardId: string }>(
      `SELECT dev.card_id AS cardId, dev.repository_id AS repositoryId, dev.repository, dev.number, dev.title, dev.state, dev.url, dev.updated_at AS updatedAt
         FROM card_development_pull_requests dev
         JOIN cards ON cards.id = dev.card_id
        WHERE cards.archived_at IS NULL AND cards.task_number IS NOT NULL
        ORDER BY dev.updated_at DESC, dev.repository_id, dev.number`,
    )
    .toArray()) {
    byCard.set(cardId, [...(byCard.get(cardId) ?? []), pullRequest]);
  }
  return [...byCard].map(([cardId, pullRequests]) => ({ cardId, pullRequests }));
}

/**
 * What a board is told about one branch event: the branch as GitHub answered when
 * re-read (`head`, or null when it no longer exists) and when that read began. Branch
 * events carry no usable clock, so `observedAt` (a read that began later saw a later
 * state) orders writes instead. `taskNumbers` are the cards of this board's key the
 * branch name named; they are linked on first sight, and every card that already
 * links the branch follows it.
 */
export const BranchWriteSchema = z.strictObject({
  repositoryId: DevelopmentBranchSchema.shape.repositoryId,
  repository: DevelopmentBranchSchema.shape.repository,
  name: DevelopmentBranchSchema.shape.name,
  head: DevelopmentBranchSchema.pick({ sha: true, message: true, committedAt: true, url: true }).nullable(),
  observedAt: z.number().int().positive(),
  taskNumbers: z.array(z.number().int().min(1)).max(MAX_TASK_KEYS),
});
export type BranchWrite = z.infer<typeof BranchWriteSchema>;

export type BranchWriteResult = {
  /** Cards whose development info this write changed. */
  changedCardIds: string[];
  /** Whether the board has any card linking the branch after the write, which decides its routing row. */
  linked: boolean;
};

/** Whether any card on this board still links the branch. */
function branchStillLinked(sql: SqlStorage, repositoryId: number, name: string): boolean {
  return sql.exec("SELECT 1 FROM card_development_branches WHERE repository_id = ? AND name = ? LIMIT 1", repositoryId, name).toArray().length > 0;
}

/**
 * Applies one re-read of a branch. A row is replaced only by a read that began no
 * earlier than the one it holds, and a removal likewise, so concurrent deliveries
 * settle on the newest read. Cards are told only when the shown commit or repo name changed.
 * Runs inside the caller's transaction.
 */
export function writeBranch(sql: SqlStorage, write: BranchWrite): BranchWriteResult {
  const changedCardIds = writeBranchRows(sql, write);
  return { changedCardIds, linked: branchStillLinked(sql, write.repositoryId, write.name) };
}

function writeBranchRows(sql: SqlStorage, { repositoryId, repository, name, head, observedAt, taskNumbers }: BranchWrite): string[] {
  type Stored = DevelopmentBranch & { cardId: string; observedAt: number };
  const stored = new Map(
    sql
      .exec<Stored>(
        `SELECT card_id AS cardId, repository, url, sha, message, committed_at AS committedAt, observed_at AS observedAt
           FROM card_development_branches WHERE repository_id = ? AND name = ?`,
        repositoryId,
        name,
      )
      .toArray()
      .map((row) => [row.cardId, row]),
  );
  const changedCardIds: string[] = [];

  if (head === null) {
    for (const [cardId, row] of stored) {
      if (row.observedAt > observedAt) continue;
      sql.exec("DELETE FROM card_development_branches WHERE card_id = ? AND repository_id = ? AND name = ?", cardId, repositoryId, name);
      changedCardIds.push(cardId);
    }
    return changedCardIds;
  }

  const targets = new Set(stored.keys());
  if (taskNumbers.length > 0) {
    const placeholders = taskNumbers.map(() => "?").join(", ");
    // An unlink holds: a card whose member unlinked this branch (a 'branch' tombstone) is never linked by key again.
    const unlinked = unlinkedCardIds(sql, "branch", repositoryId, name);
    for (const { id } of sql
      .exec<{ id: string }>(`SELECT id FROM cards WHERE archived_at IS NULL AND task_number IN (${placeholders})`, ...taskNumbers)
      .toArray()) {
      if (!unlinked.has(id)) targets.add(id);
    }
  }
  for (const cardId of targets) {
    const row = stored.get(cardId);
    if (row && row.observedAt > observedAt) continue;
    sql.exec(
      `INSERT INTO card_development_branches(card_id, repository_id, name, repository, url, sha, message, committed_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(card_id, repository_id, name) DO UPDATE SET
         repository = excluded.repository, url = excluded.url, sha = excluded.sha, message = excluded.message,
         committed_at = excluded.committed_at, observed_at = excluded.observed_at`,
      cardId,
      repositoryId,
      name,
      repository,
      head.url,
      head.sha,
      head.message,
      head.committedAt,
      observedAt,
    );
    if (!row || row.sha !== head.sha || row.message !== head.message || row.repository !== repository || row.url !== head.url) changedCardIds.push(cardId);
  }
  return changedCardIds;
}

/** Drops the card's link to a branch and records the tombstone. `unlinked` is false when the card did not link it. */
export function unlinkBranchFromCard(sql: SqlStorage, cardId: string, repositoryId: number, name: string): { unlinked: boolean; stillLinked: boolean } {
  const removed = sql.exec("DELETE FROM card_development_branches WHERE card_id = ? AND repository_id = ? AND name = ?", cardId, repositoryId, name).rowsWritten > 0;
  if (removed) recordUnlink(sql, cardId, "branch", repositoryId, name);
  return { unlinked: removed, stillLinked: branchStillLinked(sql, repositoryId, name) };
}

/** A branch row as it travels with its card in a transfer bundle: `observedAt` too, so the read that ordered it on the source still orders it on the destination. */
export const DevelopmentBranchTransferSchema = DevelopmentBranchSchema.extend({ observedAt: z.number().int().positive() });
export type DevelopmentBranchTransfer = z.infer<typeof DevelopmentBranchTransferSchema>;

export function readCardBranchesForTransfer(sql: SqlStorage, cardId: string): DevelopmentBranchTransfer[] {
  return sql
    .exec<DevelopmentBranchTransfer>(
      `SELECT repository_id AS repositoryId, repository, name, url, sha, message, committed_at AS committedAt, observed_at AS observedAt
         FROM card_development_branches WHERE card_id = ? ORDER BY repository_id, name`,
      cardId,
    )
    .toArray();
}

/** Gives a card that arrived from another board (ADR 0038) the branches it already had. */
export function importCardBranches(sql: SqlStorage, cardId: string, branches: readonly DevelopmentBranchTransfer[]): void {
  for (const branch of branches) {
    sql.exec(
      `INSERT INTO card_development_branches(card_id, repository_id, name, repository, url, sha, message, committed_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cardId,
      branch.repositoryId,
      branch.name,
      branch.repository,
      branch.url,
      branch.sha,
      branch.message,
      branch.committedAt,
      branch.observedAt,
    );
  }
}

/** A card's branches, latest commit first. */
export function readCardBranches(sql: SqlStorage, cardId: string): DevelopmentBranch[] {
  return sql
    .exec<DevelopmentBranch>(
      `SELECT repository_id AS repositoryId, repository, name, url, sha, message, committed_at AS committedAt
         FROM card_development_branches
        WHERE card_id = ?
        ORDER BY committed_at DESC, repository_id, name`,
      cardId,
    )
    .toArray();
}
