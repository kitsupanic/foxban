# Architecture

Technical source of truth. Other docs link here instead of restating schemas or protocol details. For rationale behind these choices, see [decisions/](decisions/).

## System overview

```
React SPA ──REST (Hono RPC)──▶ Worker (Hono) ──▶ D1 (users, auth, board metadata)
    │                              │
    ├────WebSocket (per board)─────┼──▶ BoardDO (one per board)
    │                              │     ├─ WebSocket connections (hibernation)
    │                              │     └─ SQLite: columns, cards, ordering
    │                              │
    └────WebSocket (app-wide)──────┴──▶ PresenceDO (one global instance)
                                         ├─ WebSocket connections (hibernation)
                                         └─ SQLite: presence (last seen, timezone)
```

The SPA talks REST (Hono RPC) for auth and the board list, and opens one WebSocket per board for live state. The Worker routes `GET /boards/:id/ws` to the board's Durable Object via `idFromName(boardId)`. There is exactly one `BoardDO` per board; it owns all board state and all live connections to that board.

## Repo layout (monorepo)

```
apps/
  web/        # Vite + React SPA
  api/        # Hono Worker + Durable Object classes + wrangler.jsonc
packages/
  shared/     # Zod schemas + TS types (Board, Column, Card, WS message protocol)
```

pnpm workspaces; TypeScript strict mode everywhere. `apps/web` imports `AppType` from `apps/api` for the `hc` RPC client.

## Parts

Read the part for the area you touch.

- [Web](architecture/web.md) — the SPA: server state and the board socket, optimistic updates and reconciliation, the description editor, routes and Home.
- [API Worker](architecture/api.md) — auth, account routes, GitHub login and signup, workspace roles, board access, membership, column boundary, cross-board transfer, attachments in R2, and the authenticated MCP endpoint.
- [GitHub integration](architecture/github.md) — the instance GitHub App, webhooks, development info from pull requests and branches, backfill and write-back.
- [BoardDO, PresenceDO and data model](architecture/board-do.md) — the Durable Objects, the shared package, D1 and DO SQLite schemas, subtask families, archived cards and ordering.
- [WebSocket protocol](architecture/protocol.md) — entities, client and server messages, realtime versioning and reconnection, DO semantics, independent subtasks and explicit family completion.
