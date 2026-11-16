# 0053 — Persisted board appearance

## Status
Accepted — 2026-09-14

## Context
Board icons and colors identify projects in the Boards workspace, but deriving them from names or keeping selections only in browser state would make the controls misleading and inconsistent between members.

## Decision
- Store one validated icon id and color id with board metadata in D1; board content remains exclusively in BoardDO SQLite.
- Use closed shared enums: twelve Lucide icon ids and eight semantic color ids. API responses carry both fields through create, list, lookup, and owner/admin edit paths.
- Existing boards migrate to neutral `square-kanban` / `slate`; newly created boards default to `square-kanban` / `amber` when older clients omit appearance.

## Consequences
Appearance is stable across users and reloads and remains editable under the existing owner/admin board-metadata boundary. Adding an icon or color requires a shared-contract, migration-constraint, API, and UI update; arbitrary SVG, custom color, name-based mapping, and board-content storage are rejected.
