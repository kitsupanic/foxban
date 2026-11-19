# 0038 — Cross-board card transfer via Worker saga

## Status
Amended and superseded in part by 0048 — 2026-09-10 (originally Accepted — 2026-09-07); amended by schema v19

## Context
Foxban boards are isolated Durable Objects storing all board state (columns, cards, checklists, attachments, comments, activities, relations, labels) in SQLite. Users needed the ability to move a card to another board without losing owned card content (checklists, comments, activity history, attachments, labels, assignee). However, cross-card relations (links, subtasks, parent links) cannot cross board boundaries, and attachment blobs are scoped to board ID prefixes in Cloudflare R2.

## Decision
1. **Worker-Orchestrated Idempotent Saga**:
   - Transfer is coordinated by the global Worker across the source `BoardDO`, destination `BoardDO`, and R2 storage bucket.
   - It is an authenticated, dual-membership-checked REST operation (`POST /boards/:id/cards/:cardId/transfer`), not a client WebSocket mutation.
   - Transfer uses an idempotent client-supplied `transferId` (`1..64` characters).
2. **Schema Evolution (v13 to v19)**:
   - `card_transfer_locks(card_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL UNIQUE, destination_board_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'prepared', expires_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1)` on the source board (schema v18 tracks `generation`).
   - `card_transfer_operations(transfer_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, destination_board_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` on the source board (schema v18), tracking operation history across generations.
   - `card_transfer_receipts(transfer_id TEXT PRIMARY KEY, source_board_id TEXT NOT NULL, card_id TEXT NOT NULL, task_number INTEGER NOT NULL)` on the destination board. Receipts are keyed by `transfer_id` (superseding the v13 composite `(source_board_id, card_id)` key in schema v16) so cards can be transferred across boards repeatedly without historical receipts blocking subsequent transfers (amended by ADR 0048).
   - `attachment_cleanup(object_key TEXT PRIMARY KEY, attachment_id TEXT NOT NULL, reason TEXT NOT NULL, delete_after INTEGER NOT NULL, claim_token TEXT, claimed_at INTEGER, deleted_at INTEGER)` (schema v18 added `claim_token` and `claimed_at`; schema v19 adds `deleted_at` permanent deletion tombstones), providing atomic non-overwriting claims, restart-safe same-token deletion retries retaining the claim fence, permanent retention of `deleted_at` tombstones on successful R2 deletion rather than row removal, and rejecting conflicting staging operations.
   - The transfer lock strictly freezes the prepared aggregate against mutation: child row edits, relation edits, column deletions containing a locked card, and modifications/deletions of labels joined to a locked card are rejected with `"card transfer in progress"`. The lock is a non-expiring write fence until terminal state (`finalized` or `aborted`) is reached; the `expires_at` timestamp is used exclusively for alarm recovery scheduling rather than automatic unlocking (superseded by ADR 0048).
3. **Card Identity and Numbering**:
   - The card UUID is preserved across boards, avoiding foreign key rewrites for owned checklist items, comments, activities, and attachments.
   - The destination board allocates a new monotonic task number (`cards.task_number`) from its own `meta.next_task_number`.
   - The card is appended to the tail of the destination column using server-computed fractional indexing position (`generateKeyBetween`).
4. **Link and Subtask Precondition**:
   - A card with any relation, parent, or subtask link (`card_relations` row) cannot be transferred. The transfer is rejected with HTTP 409 (`remove card links before transferring`). Links must be explicitly removed by the user before transfer.
5. **Assignee and Label Preservation**:
   - The card's assignee is preserved only if the user is an active member in D1 `board_members` for the destination board. Configured admin access does not synthesize membership; non-members become `null`.
   - For assigned labels, the destination DO searches existing labels for an exact name and colour match. If matched, the label definition is reused. If not, a new label definition is created with a fresh UUID. Fresh `card_labels` joins are created in either case.
6. **R2 Attachment Migration and Compensation**:
   - Attachment files are copied from `${sourceBoardId}/${attachmentId}` to transfer-scoped destination keys `${destinationBoardId}/${transferId}/${attachmentId}` (via `attachmentTransferObjectKey`) along with their complete R2 HTTP metadata (contentType, contentLanguage, contentDisposition, contentEncoding, cacheControl, cacheExpiry) and custom metadata, with destination staging leases registered in `attachment_cleanup`. Transfer U import consumes only U's staging row, while aborted transfer T's staging rows remain collectible in `attachment_cleanup`.
   - If any attachment copy fails, Worker compensation contacts the destination `CARD_TRANSFER_ABORT_PATH` first to establish an atomic abort tombstone (`task_number = -1`), permanently fencing delayed imports, and releases the source lock. Worker compensation performs **no foreground R2 deletion**; uncommitted destination staging blobs are safely collected by the destination BoardDO TTL durable collector / alarm sweep, with successful deletion recording permanent tombstones that prevent key reuse, preventing cross-generation deletion races (amended by ADR 0048 and schema v19).
   - Destination import checks for an existing exact receipt before evaluating mutable destination state. If an abort tombstone exists, import aborts with 409 Conflict. Import performs pre-write lease validation, verifying active staging leases in `attachment_cleanup` (`delete_after > now AND claim_token IS NULL AND deleted_at IS NULL`) for all bundle attachments before executing any database writes or allocating destination task numbers; expired, claimed, or tombstoned leases abort import with `ImportConflictError(409)` triggering transactional rollback without partial commits.
7. **Two-Phase Commit and Finalization**:
   - Source deletion occurs only after the destination transaction has committed.
   - Finalization deletes the source card and all owned rows using the centralized `deleteCardAggregate` cascade, enqueues the old source R2 keys in `attachment_cleanup` (which transition to permanent tombstones upon successful R2 deletion), and broadcasts a fresh `snapshot` to source sockets (amended: source sockets now get `archive.purged` for the card instead, and a replayed finalize or import sends nothing, because a snapshot on a live socket settles every pending mutation as unconfirmed).
   - If finalization fails, HTTP 500 (`transfer needs retry`) is returned; retrying with the same `transferId` reuses the destination receipt and finalizes the source without double-importing.
   - Source write locks do NOT automatically unlock after 5 minutes. The 5-minute `expires_at` timestamp is a recovery alarm schedule hint. Recovery checks destination status and only unlocks if the destination confirms an abort tombstone; if the destination committed, recovery finalizes the source aggregate rather than re-enabling writes on a divergent copy (superseded by ADR 0048). In `CARD_TRANSFER_RELEASE_PATH`, destination board identity is required; requests lacking destination identity reject with HTTP 409 Conflict (`destination board identity unknown; lock retained`) and retain the lock.
## Consequences
- Cross-board transfer is a move, not a copy. A transferred card leaves the source board completely.
- Internal DO endpoints handle transfer options, prepare/lock, idempotent import, finalize/purge, and lock release.
- Web clients navigate cleanly to the destination board with the new canonical human task key, invalidating and removing stale board caches.
