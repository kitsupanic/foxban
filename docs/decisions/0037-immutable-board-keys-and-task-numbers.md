# 0037 — Editable board keys and server-allocated monotonic task numbers

## Status
Accepted — 2026-09-07

## Context
Tasks in Foxban needed stable, human-friendly Jira-style identifiers (`<BOARD_KEY>-<TASK_NUMBER>`) for unambiguous referencing in discussions, commit messages, and external communication. UUIDs remain necessary for distributed identity, mutations, storage, and relations without coordination, while human task keys own active-card URLs and numeric identifiers remain concise, monotonic per board, and immutable.

## Decision
1. **Globally Unique Editable Board Keys**:
   - Each board receives a globally unique uppercase key (`/^[A-Z][A-Z0-9]{1,9}$/`).
   - Existing boards were migrated deterministically with `KEY1`, `KEY2`, ... ordered by `created_at, id`.
   - The key is specified at board creation, validated and uppercased by the API, stored in D1 `boards.board_key`, backed by a unique index, and returned with all board queries.
   - Board owners and configured account administrators can edit a board's display name and key via `PATCH /boards/:id`. The change is an atomic D1 metadata update (`UPDATE boards SET name = ?, board_key = ? WHERE id = ?`).
   - Ordinary board members cannot edit board metadata (403 `forbidden`).
   - Unique key collisions translate narrowly to HTTP 409 (`board key already exists`).
   - Key changes do not rewrite BoardDO card rows or numeric task numbers, but deliberately change all derived `<BOARD_KEY>-<TASK_NUMBER>` identifiers.
2. **Board-Local Monotonic Task Numbers in BoardDO**:
   - BoardDO SQLite schema migration v12 adds `cards.task_number INTEGER` with a unique index, backfilling legacy active and archived cards by `ROW_NUMBER() OVER (ORDER BY created_at, id)`.
   - `meta.next_task_number` maintains the next positive integer counter.
   - During `card.create`, the counter is assigned and incremented within the synchronous SQLite transaction. Duplicate/failed inserts rollback atomically.
   - Moving, archiving, restoring, and permanent purging never alter or reuse task numbers.

3. **Verbatim Broadcast with Server-Authored Reconciliation Frame**:
   - Clients continue generating UUIDs and sending standard `card.create` mutations without guessing numbers (using internal sentinel `0` optimistically).
   - The server broadcasts the verbatim `card.create` frame, followed by a dedicated strict `card.numbered` frame (`{ type: "card.numbered", mutationId, id, taskNumber }`) before activity frames.
   - Web sockets patch `taskNumber` via `reconcileTaskNumber`, preserving client-side optimistic responsiveness while maintaining strict server authority.
   - Reconnect snapshots supply committed positive task numbers.

4. **Presentation and URL Routing**:
   - `${boardKey}-${taskNumber}` is rendered as muted metadata on card fronts, card modal/fullscreen headers, archived card rows, and board headers.
   - Active-card URLs use canonical human task keys (`/board/:boardId?card=<BOARD_KEY>-<TASK_NUMBER>`), matched strictly against positive task numbers and the board's key.
   - Internal identity remains UUID-based across BoardDO storage, mutations, relations, drag-and-drop, attachments, and DOM attributes (`data-card-id`). Search remains title-only.

## Consequences
- Board keys are globally unique and editable only by board owners and configured administrators via atomic D1 metadata updates.
- Human task keys own active card URLs (`/board/:boardId?card=<BOARD_KEY>-<TASK_NUMBER>`), while storage, mutations, and internal relations continue to use UUIDs.
- A board key change immediately changes every derived task identifier and task-key URL on that board. Old task-key URLs fail semantic validation and clean back to the board; no alias table, redirect, UUID compatibility shim, or key history is introduced.
- Cards have stable, permanent numbers that survive column moves, archive/restore, and server restarts. Gaps after permanent purges are intentional.
- The verbatim broadcast architecture (ADR 0010) is preserved alongside server-assigned monotonic sequencing via authoritative reconciliation frames.
