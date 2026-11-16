# Agent rules — foxban

## Hard rules

- Stack is locked — see `docs/decisions/`. Do not substitute technologies.
- Workers runtime is NOT Node: no `fs`/`net`/Node-only packages in `apps/api/src`.
- All board mutations go through the BoardDO — never write board state to D1.
- Card/column data never lives in D1.
- WebSocket Hibernation API only — never legacy `ws.addEventListener`.
- Ordering via fractional indexing (string keys); a move writes one row.
- TypeScript strict mode everywhere.
- Keep the API's `AppType` export stable — the `hc` client depends on it.
- No instance-specific values in committed files (emails, domains, resource ids). They come from the deployer's env — see ADR 0063.

## Where things are

- `docs/architecture.md` — how it works (components, data model, WS protocol)
- `docs/testing.md` — test approach
- `docs/mcp.md` — the MCP endpoint
- `docs/decisions/` — why (ADRs)
- `GLOSSARY.md` — project terms

## Process

- Before coding: read `docs/architecture.md`.
- Load-bearing choice made or reversed: add an ADR in `docs/decisions/`.
- Run `pnpm typecheck` and `pnpm test` before you call a change done.
