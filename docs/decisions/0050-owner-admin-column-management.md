# 0050 — Owner/admin column management at connect time

## Status
Accepted — 2026-09-13

## Context
Board membership permits card collaboration but must not permit changing board structure. Create/delete belong with rename/reorder to prevent reconstructing columns around a partial restriction. Existing account admins already bypass membership without synthetic rows (ADR 0033).

## Decision
Only the specific board owner or an existing `ADMIN_EMAILS` admin may create, rename, move or delete columns. The public Worker overwrites the internal capability alongside board/user identity using already-authorized request data. BoardDO accepts only exact fresh header `"true"`, serializes the boolean in the hibernating socket attachment, and gates those four mutations before side effects. False rejects to the sender without disconnecting card collaboration; missing/non-boolean legacy attachment capability rejects and closes `1012`, requiring reconnect and deliberate retry without replay.

## Consequences
Authority remains connect-time scoped, matching membership/session checks: no per-mutation D1 reads or live revocation mechanism. No new role, database field, public snapshot property or protocol-version bump. Member card collaboration and existing membership, label, board creation, metadata editing, deletion and GitHub rules remain unchanged. Rejecting a fresh non-manager handshake was declined because it would unnecessarily disconnect card collaborators; trusting absent legacy authority was declined because it would grant structure access. UI restrictions complement rather than replace server enforcement.
