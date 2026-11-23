# 0084 — Session rows are keyed by the cookie's hash

## Status
Accepted — 2026-11-23; amends 0008.

## Context
`sessions.id` held the exact value of the session cookie. The cookie is a bearer secret, so anyone who could read D1 (a backup, a Time Travel restore, an exported copy) could sign in as anyone with a live session. Agent tokens are already stored as SHA-256 only, and sockets already name their session by the SHA-256 of the cookie (0082), so the raw value was the one secret left in the database.

## Decision
- `sessions.id` stores `sha256Hex(cookie)`, the value `requestSessionHash` returns. `startSession` still puts the raw random id in the cookie and inserts only its hash.
- Every read or write that names the caller's own session (`requireAuth`, `endSession`, the GitHub link and reauth flow, the password change, the GitHub disconnect, the upgrade re-check) binds `requestSessionHash(c)`. The socket's hash and the row id are now the same value, so 0082's revocation names rows and sockets alike.
- Migration 0026 deletes every existing row: those ids are raw cookies and match no lookup any more.

## Consequences
A read of D1 yields no usable cookie. The cookie value is 256 random bits, so a plain SHA-256 needs no salt or key. The deploy signs everyone out once, and they log in again. It costs one SHA-256 per authenticated request.
