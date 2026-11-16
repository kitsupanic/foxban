# 0016 — Five-level card priority as an always-set column, set by its own mutation

## Status
Accepted — 2026-09-01

## Context
foxban wanted task priority "like in Jira": five levels — Highest, High, Medium,
Low, Lowest — and, crucially, Jira's always-set field. Every issue has a
priority, new issues default to Medium, and none can be cleared. We chose
that over a nullable field with a "None" entry, so priority is part of every
card's state rather than an optional decoration.

## Decision
- Priority is a non-nullable card field: `PrioritySchema` (`"highest" | "high" |
  "medium" | "low" | "lowest"`, lowercase on the wire), a `priority TEXT NOT NULL
  DEFAULT 'medium'` column in the DO's `cards` table (schema v5), and a required
  key on `CardSchema`. `card.create` never names the column, so a new card takes
  the SQL default; the optimistic client reducer seeds the same `"medium"` so an
  optimistic create cannot diverge from the next snapshot.
- Setting it is its own mutation, `card.prioritize`, following the `card.assign`
  precedent rather than becoming a `card.update` field. Priority is an
  instant-send modal field; `card.update` is the Save-committed title/description
  draft whose inverse restores only touched fields (`title` or `description`)
  when matching expected values, preserving concurrent peer edits to untouched
  fields while client state converges via authoritative-base rebase. Folding one
  into the other would entangle them for no gain.
- Concurrent sets are last-write-wins by mutation order (ADR 0007), like
  assignment. No merge handling.
- The card front shows the level as a coloured Lucide icon (ChevronsUp, ArrowUp,
  Minus, ArrowDown, ChevronsDown; amended by ADR 0042) with the level name as its
  tooltip, unconditionally — which is why the card-front badge row is no longer
  conditional.

## Consequences
Every card front now carries a badge row, and a fresh card shows an amber Minus
icon (ADR 0042) — the chosen Jira behaviour, not noise. Existing boards gain
`'medium'` on every card when their DO runs the v5 batch on first access after
deploy.
rolling deploy an old-bundle tab receiving a `card.prioritize` broadcast fails
its `ServerMessageSchema` parse and reconnect-loops until refreshed; the
new snapshot key is stripped harmlessly by the old non-strict
`CardSchema`. Ordering stays manual fractional-index — no sorting or filtering by
priority. Rejected: a nullable priority with a "None" option (we chose
Jira's semantics), and priority as a `card.update` field.
