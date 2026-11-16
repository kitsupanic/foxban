# 0036 — Manual archived-card purge

## Status
Accepted — 2026-09-06

## Context
The 90-day archive protects card and column deletion from accidental loss, but members also need to remove an archived card immediately when retention is unnecessary or its saved content must be destroyed. ADR 0034 intentionally omitted that action before the recovery UI and shared purge lifecycle existed.

## Decision
- Each archived-card row exposes **Delete permanently** behind an inline, irreversible confirmation. Cancel or Escape returns to the row; a disconnected send leaves the confirmation open.
- A strict `card.purge` WebSocket mutation names one card id. It can purge only an archived row; an active or missing id is an accepted no-op, so a stale client can never permanently delete an active card.
- The BoardDO reuses the retention purge cascade for the card and every owned row. Attachment deletion triggers enqueue R2 keys, and the existing lifecycle alarm/drain owns blob deletion and retry.
- The accepted mutation is broadcast verbatim, followed by the existing authoritative `archive.purged` frame. Clients wait for that server frame instead of optimistically fabricating irreversible state.
- This supersedes only ADR 0034's “no early permanent-delete action” clause. Its BoardDO-only archive, restore, retention, read-only and bounded-alarm decisions remain accepted.

## Consequences
Members can remove archived data immediately without a D1 route, schema migration, second cleanup queue or new server-frame shape. The extra confirmation is deliberate: manual purge cannot be undone, restored or reconstructed after its R2 cleanup completes.
