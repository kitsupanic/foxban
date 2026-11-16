# 0034 — Card archive on column delete

## Status
Accepted — 2026-09-05

## Context
Immediate column cascades made one misplaced destructive action permanently remove every card aggregate and its attachment bytes, while keeping deleted columns themselves has no recovery value.

## Decision
- A column disappears immediately, but its active cards remain read-only BoardDO SQLite rows for a rolling 90 × 24-hour retention window, with the former column title and server archive timestamp.
- Members restore archived cards individually into a live destination column. Missing, purged, already-restored cards and stale destinations are rejected; there is no early permanent-delete action.
- The existing Durable Object alarm owns both bounded archive purges and attachment cleanup. Purging card rows queues their R2 keys through the existing attachment-delete trigger.
- The original `column.delete` broadcast stays verbatim; server-only `cards.archived` and `archive.purged` frames authoritatively reconcile connected clients. No archive state or route enters D1.

## Consequences
Card aggregates and attachment bytes remain recoverable for 90 days, stale clients cannot mutate archived rows, and alarm work is idempotent and bounded. Column deletion uses more BoardDO storage during retention; rejected alternatives are immediate cascade deletion, retaining deleted columns, D1 archive state, and manual early destruction.
