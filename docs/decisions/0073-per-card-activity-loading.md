# 0073 — Card activity loads per card, not in the snapshot

## Status
Accepted — 2026-11-18; amends 0029's snapshot clause.

## Context
ADR 0029 put every committed activity row in every reconnect snapshot. Activity is deleted only when its card is purged, so it grows with the board's whole history. Every connect read and sent all of it. Over months that slows opening a board and can pass the WebSocket message limit, after which nobody can open it.

## Decision
- The snapshot carries no `activities`. Comments stay in it.
- The BoardDO answers one card's activity on an `open` internal route, `GET /internal/cards/:cardId/activity`, in sequence order. The Worker serves it as `GET /boards/:id/cards/:cardId/activity` behind `requireAuth` and `requireMember`. Archived cards are readable; an unknown card has none.
- The card modal reads that route with TanStack Query (`['card-activity', boardId, cardId]`) when it opens. Live `activity.recorded` frames stay as they are (ADR 0029) and merge into the card's cache by id, in sequence order. A card with nothing loaded refetches instead, so a read in flight cannot miss a frame. A reconnect snapshot marks every loaded history stale, and a denied board drops them with the rest of its private data.
- The board's own state no longer holds activity, so nothing on the board reads it.

## Consequences
The snapshot's size no longer depends on history, and an idle card costs nothing. The creator and assignee history in the card modal appear when its read lands. A client that still expects `activities` in the snapshot cannot parse the new one, so it must reload: `REALTIME_PROTOCOL_VERSION` is bumped from 10 to 11 to fence old cached clients (the build ships both sides together). Rejected: capping the snapshot to the latest N rows, which leaves older history unreachable and needs the same route anyway.
