# 0005 — WebSocket Hibernation API

## Status
Accepted — 2026-08-30

## Context
DOs holding open WebSockets bill for wall-clock time unless they can hibernate.

## Decision
Use the WebSocket Hibernation API (`state.acceptWebSocket`, `webSocketMessage`/`webSocketClose` handlers) so idle boards evict from memory while keeping sockets alive.

## Consequences
Idle boards cost ~nothing — this IS the cost model. Rejected: legacy `ws.addEventListener` pattern, which pins the DO in memory.
