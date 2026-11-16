# 0010 — Client-generated ids/positions, verbatim mutation broadcast

## Status
Accepted — 2026-08-30

## Context
The WS protocol and board UI need a story for who mints entity ids and ordering keys, and what the DO rebroadcasts. Alternatives: server-assigned ids (requires a request/response round-trip before optimistic insert, plus id-rewriting in the client cache) or server-transformed broadcasts (requires a second serializer and opens drift between what the sender applied and what peers receive).

## Decision
Clients generate entity `id`s (`crypto.randomUUID()`) and `position` keys (fractional-indexing, computed against local sorted state). Every mutation carries a client `mutationId`. The DO validates against `ClientMessageSchema`, applies one SQL statement, and rebroadcasts the client's message **verbatim** (byte-for-byte) to all sockets, sender included. Senders reconcile their optimistic update by `mutationId`; peers apply the broadcast through the same pure reducer (`apply-mutation.ts`) the optimistic path used. Only `createdAt`/`updatedAt` are server-set, reconciled at next snapshot.

## Consequences
- Optimistic updates are trivial: one reducer serves both paths; no id remapping, no server round-trip before paint.
- The DO trusts client ids/positions — acceptable in a 2-trusted-user tool under LWW (ADR 0007); a hostile client could collide ids, which membership auth bounds to board members.
- Optimistic timestamps drift from server values until the next snapshot; harmless for display-only fields.
- Concurrent same-neighbor inserts can produce equal position keys; ties render in id order and the next move heals them — accepted, no rebalancing pass.
