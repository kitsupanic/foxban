# 0029 — Server-attributed card activity

## Status
Accepted — 2026-09-04; supersedes ADR 0015's identity-blind premise

## Context
Card history must retain the authenticated actor and one server timestamp across WebSocket hibernation and reconnects without changing the optimistic client-mutation contract.

## Decision
- After membership checks, the Worker overwrites internal board/user headers. The BoardDO validates the user id at upgrade and stores it with `WebSocket.serializeAttachment`, so attribution survives hibernation.
- Schema v10 stores immutable activity rows. Pre-mutation details, the original mutation, and ordered activity inserts run in one synchronous SQLite transaction with one server timestamp.
- The accepted client mutation remains the first verbatim broadcast (ADR 0010). A non-empty ordered batch follows in one server-only `activity.recorded` frame; reconnect snapshots contain every committed row.
- Legacy comments deliberately retain their client-authored `authorId`/timestamps and UI-only edit/delete permissions for wire compatibility. Comment edits and deletes still receive authenticated activity actors.

## Consequences
Existing cards get no synthetic history. Audit attribution is trustworthy for new activity, while comment-row authorship remains the explicit legacy exception; ADR 0010 stays accepted because no client mutation echo changes.
