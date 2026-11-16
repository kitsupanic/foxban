# 0033 — Global admin board access

## Status
Accepted — 2026-09-05

## Context
Configured account administrators (`ADMIN_EMAILS`) previously held global authority only over invites (`/invites`), while board operations required a persistent row in `board_members`. Operating and supporting boards required synthetic membership records, polluting member listings and card assignee options with administrative accounts.

## Decision
- Account admins are global board operators who bypass board membership checks at request and connect time without creating `board_members` rows.
- In `GET /boards`, admins query all boards ordered by `created_at`; non-admin queries remain filtered by `board_members.user_id`.
- In `requireMember`, admins query `boards` directly by id, bypassing the `board_members` join. Missing boards continue to return 403.
- `GET /boards/:id/members` returns only actual board members; admins are not injected into membership lists.

## Consequences
Admins can inspect, edit, attach to, and connect via WebSocket to any board. Ordinary users remain strictly isolated to their explicit board memberships (uninvited non-admins receive an empty board list and 403 on direct access). Preserves data integrity by avoiding synthetic membership rows.
