# ADR 0055 — Authenticated agent MCP access

## Status

Accepted.

## Context

External coding harnesses need bounded board/task discovery and safe progress mutations. Foxban already has one authoritative BoardDO per board, while D1 owns users, sessions, memberships, and board metadata. Browser mutation IDs are correlation IDs, not durable retry fences.

## Decision

Serve `/mcp` from the existing Worker with `@modelcontextprotocol/server` 2.0.0 and its Workers validator. Use stateless Streamable HTTP; add no Node runtime, OAuth provider, Durable Object binding, or transport session store.

D1 stores revocable SHA-256-digested agent credentials tied to a current user, explicit stable board IDs, explicit closed scopes, and a maximum 90-day expiry. Raw tokens are returned only once. Every tool call reloads the credential, user, scope, and current board access. Admin authority never widens credential scope.

BoardDO remains the sole card/column authority. MCP internal routes accept only strict typed reads or four narrow commands. MCP and WebSocket writes share mutation guards, transactional apply/activity behavior, and ordered live fan-out. Caller identity, timestamps, entity IDs, and positions are server-derived for MCP.

Every MCP mutation requires a UUID operation key. A BoardDO receipt keyed by credential and operation key binds actor, operation, and canonical input hash in the same SQLite transaction as the mutation, activity, and committed result. Exact retries return the original result without mutation or broadcast. Receipts remain until board deletion; authorization is still rechecked before receipt access.

## Consequences

- Browser clients converge immediately with MCP writes without a second board-data path.
- Revocation, expiry, user deletion, or membership removal affects the next tool call.
- Receipt storage grows with successful MCP mutations for the board lifetime; low private-studio traffic makes this preferable to silent duplicate writes after pruning.
- A new credential is a new retry namespace. An uncertain operation must not be transplanted blindly.
- Configured Bearer tokens support compatible clients but are not interoperable MCP OAuth.
- Movement and assignment remain last-write-wins collaboration signals, not exclusive claims.
