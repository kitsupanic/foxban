# 0019 — Subtasks as a third relation kind, created by checklist conversion

## Status
Accepted — 2026-09-01

## Context
M14 wants Jira-style subtasks: a checklist item that outgrows its row should become a real card that still reads as belonging to its parent. A separate child-card entity would mean a new table, new messages, and a second parent/child code path beside the M13 links that already store exactly this shape.

## Decision
- A subtask is a `card_relations` row with `kind: "subtask"`, read as “source is the parent of target”. No new entity, table, message, or DO migration — `kind` is passthrough TEXT and both cascades are kind-agnostic, so the schema stays at v7.
- The link composer never offers `subtask`; conversion is the only creator. Because every conversion mints a fresh child id, a card can never accumulate a second parent, and the modal renders one parent chip.
- Conversion is a client-orchestrated `card.create` (column tail) + `relation.create` + `checklist.delete` sequence with no server transaction. A socket drop midway leaves an orphan card or a lingering item: visible, hand-fixable residue, consistent with the ADR 0010 posture.
- The card front shows a count-only `🧩 n` badge on the parent side; the 🔗 badge excludes subtask rows.
- Unlinking (×) deletes only the relation — the child card stays on the board.

## Consequences
Rejected: an `n/m` progress badge and a “done = rightmost column” convention, both of which need a done state cards do not have; an explicit card done state, which is a larger model change than subtasks warrant. Nested subtasks fall out for free (a child's own checklist item can be converted) and need no cycle guard, since children are always newly created. Once any `subtask` row exists, bundles predating the widened enum fail to parse the snapshot itself, so stale tabs reconnect-loop until refreshed.
