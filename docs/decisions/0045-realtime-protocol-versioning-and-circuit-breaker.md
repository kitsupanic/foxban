# 0045. Realtime protocol versioning and unsynchronized reconnection circuit breaker

Date: 2026-09-09

## Status

Accepted

## Context

On 2026-09-09, Cloudflare analytics identified an incident on one production BoardDO: 8,539,722 rows read, 67,168 outbound WebSocket messages, and only 118 writes. Invocation telemetry confirmed an intense reconnect storm rather than mutation load: at 14:00 UTC alone, the authoritative late-aggregated metrics reached 9,052 `responseStreamDisconnected` HTTP invocations and 9,060 hibernation events (surpassing prior preliminary samples of 9,002 and 9,025 before complete aggregation settled) while repeatedly reading ~128 snapshot rows per connection.

The root cause was two-fold:
1. Client connection health was defined by transport `onopen` rather than a validated snapshot. Any client that opened a WebSocket, failed to parse a tagged frame (or disconnected immediately after receiving a valid snapshot), and closed the socket immediately reset its retry attempts and reconnected indefinitely.
2. The Worker upgrade route had no protocol version gate prior to obtaining the Durable Object stub. Consequently, outdated or incompatible client versions repeatedly accessed DO SQLite storage.

## Decision

1. **Protocol Versioning at the Worker Boundary**:
   - Added and exported `REALTIME_PROTOCOL_VERSION = "1"` from `packages/shared`.
   - The web client attaches `?realtimeVersion=1` to both board and presence WebSocket URLs (`/boards/:id/ws` and `/presence/ws`).
   - The Worker verifies `realtimeVersion === REALTIME_PROTOCOL_VERSION` after authentication and board-membership checks, but before obtaining a DO stub. Missing or mismatched versions return HTTP 409 JSON `{ error: "realtime client update required" }`, preventing stale clients from reading DO rows.

2. **Snapshot-Validated Connection Health & Stability Window**:
   - In `useBoardSocket`, a connection is healthy only after a valid `snapshot` is applied AND it remains continuously open for 10 seconds (`STABLE_CONNECTION_MS = 10_000`). Only surviving open for 10s resets `attempt` and consecutive failures.
   - Any close before 10s stability—including immediate closes occurring after a valid snapshot—increments `consecutiveFailures`.
   - Replaced `MAX_FAILED_HANDSHAKES` with `MAX_FAILED_SYNCHRONIZATIONS = 3`. At 3 consecutive unsynchronized/unstable failures, reconnection stops, logging a concise warning and transitioning the board UI to **Could not connect.** with a manual **Retry** button. Clicking Retry resets the budget for 3 more attempts.
   - Unparseable JSON frames log a sanitized warning without raw payload or user data, close immediately, and count toward the breaker.
   - Established connections that close after achieving 10s stability continue bounded exponential backoff reconnection and must achieve stability again on reconnect.

3. **Presence Reconnect Bounds & Stability**:
   - `usePresenceSocket` adopts the same `STABLE_CONNECTION_MS = 10_000` stability window and `MAX_FAILED_SYNCHRONIZATIONS = 3` limit.
   - Closes occurring before 10s stability (or before receiving a valid `presence.snapshot`) count toward 3 failures. At 3 failures, reconnection halts with one console warning. Presence failure remains non-blocking for board interaction.
4. **Protocol Bumps**:
   - Any future wire contract change that cannot be safely parsed by older deployed clients requires bumping `REALTIME_PROTOCOL_VERSION`.

## Consequences

- Outdated clients cannot scan DO SQLite storage after deployments.
- Clients encountering unparseable or rejected frames stop reconnecting after 3 attempts instead of creating infinite reconnect loops.
- Normal network drops after a valid snapshot continue to reconnect automatically.
