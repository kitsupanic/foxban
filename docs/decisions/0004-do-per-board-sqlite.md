# 0004 — One Durable Object per board, board state in DO SQLite

## Status
Accepted — 2026-08-30

## Context
Real-time collaboration needs a single authority per board for ordering and broadcast.

## Decision
One Durable Object per board (`idFromName(boardId)`). Board state — columns, cards, ordering — lives in the DO's SQLite storage. D1 holds only users, sessions, board metadata, and membership.

## Consequences
The single-threaded DO serializes all mutations, so no conflict resolution is needed. All board mutations must go through the DO, never D1.
