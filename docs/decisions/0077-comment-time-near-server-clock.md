# 0077 — A live comment's timestamp must be near the board's clock

## Status
Accepted — 2026-11-19; amends 0074's "timestamps stay client-supplied".

## Context
`comment.create` and `comment.update` carry `createdAt` and `updatedAt` from the client, and the board relays an accepted frame verbatim (ADR 0010). A member could send `createdAt: 0` and backdate a comment.

## Decision
The mutation gate refuses a `comment.create` whose `createdAt`, or a `comment.update` whose `updatedAt`, is more than `COMMENT_TIME_TOLERANCE_MS` (10 minutes) from the board's `Date.now()`. The sender gets the usual error frame ("Comment time is out of range. Check your device clock."). Nothing is rewritten, so what is stored is what was relayed.
- The gate runs inside `runMutation`, so the live client path and MCP both pass through it. MCP's `add_comment` stamps its comment with the board's clock, so it always passes. A card transfer imports comments straight into SQL with their original timestamps and never reaches the gate.

## Consequences
A client whose clock is more than 10 minutes off cannot comment until it is fixed. Rejected: stamping the time on the server, which would leave peers with the client's value until their next snapshot.
