# 0059 — Explicit family completion choices

Date: 2026-10-02
Status: Accepted. Dev deployment explicitly authorized on 2026-10-02; live KRD activation remains a separate reviewed operation.

## Context

Independent statuses let a parent finish while its subtasks remain open. That is useful, but moving a parent to Done did not make the user's choice about unfinished work explicit.

## Decision

In a board with configured starting and completed columns, dragging a parent into the completed column or choosing that Status opens a completion dialog if any active descendant remains unfinished. Count the entire active family across all columns, including retained historical deeper hierarchies. Offer Finish all, Finish only parent, and Cancel. Do not optimistically change cards before a choice. Live family changes update the count while choosing; moving the parent or changing the completion role requires reviewing the move again.

Finish all moves the parent and every unfinished descendant to the chosen completed column in one BoardDO SQLite transaction. Already completed descendants stay in place. Child fractional positions append in existing position order; ordinary moves still write one row. Finish only parent affects one row. Reopening a parent never reopens children. If all descendants are already finished, use the ordinary one-row move without a dialog. Archived descendants are excluded.

Add protocol 9 `card.finish` with explicit `scope`, expected parent placement, complete active-family placement/parentage, and precisely enumerated child moves. Before writing, the DO rederives the family, checks the configured completed column and exact child set, and applies the existing permission, archive and transfer fences. Any mismatch rejects the whole command. Moves and their activity entries commit together and then broadcast one frame. The client waits for settlement, blocks duplicate choices, restores placement on rejection, and requires reviewing current state before retrying an uncertain attempt. No automatic bulk completion occurs in ordinary `card.move`, MCP `move_task`, or `complete_subtask`; MCP descriptions explicitly preserve single-task semantics.

The nested dialog traps focus, makes underlying UI inert, handles Escape without closing card details, restores trigger focus, and scrolls on short viewports.

## Consequences

Bulk completion is a deliberate exceptional family operation, not new status inheritance. It costs one confirmation when open work remains and rejects stale family changes rather than guessing. No schema migration is required. Legacy unconfigured boards retain inherited behavior. Protocol fencing prevents old clients from consuming an unknown mutation. Local implementation and fixtures do not authorize live activation or deployment.
