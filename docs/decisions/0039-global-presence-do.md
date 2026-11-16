# 0039 — Global PresenceDO for member presence and timezone rail

## Status
Accepted — 2026-09-08

## Context
Foxban users collaborate on boards in different timezones and need to see who is currently online or when they were last active, along with each member's local time. Board state (cards, columns) is partitioned per board into individual `BoardDO` instances. However, online presence is an application-wide property: a user remains online if they have any Foxban tab open (Boards list, Profile, or any board). Presence state must not contaminate board mutation protocols or per-board SQLite schemas.

## Decision
1. **Global Hibernating PresenceDO**:
   - Routed as a single global instance using `PRESENCE_DO.idFromName("global")`.
   - Uses the Cloudflare Workers WebSocket Hibernation API (`ctx.acceptWebSocket`, `server.serializeAttachment`, `ctx.getWebSockets`, `webSocketClose`, `webSocketError`) exclusively, so idle instances hibernate without keeping CPU alive.
   - Disconnected tabs do not mark a user offline if other tabs for that user remain connected (multi-tab tracking via `ctx.getWebSockets()` attachments).
   - Persists last-seen timestamps (`last_seen_at`) and effective timezones in PresenceDO SQLite `presence(user_id TEXT PRIMARY KEY, last_seen_at INTEGER, timezone TEXT)`.
   - When the final socket for a user disconnects, records `Date.now()` as `last_seen_at` and broadcasts the offline update.

2. **Strict Isolated Presence Protocol**:
   - Presence wire protocol is strictly isolated in `packages/shared/src/presence.ts` and not mixed with `ServerMessage` board mutation frames.
   - Server frames:
     - `{ type: "presence.snapshot", members: PresenceState[] }`
     - `{ type: "presence.updated", member: PresenceState }`
   - `PresenceState = { userId: string, online: boolean, lastSeenAt: number | null, timezone: string | null }`.
   - Client sends no application messages; unrecognized frames trigger socket close and resynchronization.

3. **User Timezone Preference vs. Effective Timezone**:
   - D1 migration `0006_user_timezone.sql` adds nullable `users.timezone TEXT` for an explicit user preference override.
   - If the user specifies `null` (default), their effective timezone defaults to their browser's detected IANA timezone passed via `/presence/ws?timezone=...`.
   - Validated against IANA standard database using `Intl.DateTimeFormat("en-US", { timeZone })`.
   - Profile provides a `TimezoneSection` allowing users to select an explicit timezone or reset to Automatic (`null`).
   - Board REST rows do not expose timezone: the live presence socket is the sole authoritative source of effective member timezones.

4. **Single App-Wide WebSocket Owner**:
   - `usePresenceSocket` is mounted once at `AuthenticatedRoot` in `apps/web/src/router.tsx`, outside individual page components.
   - Navigating between boards or to profile does not flap WebSocket connections.
   - Reconnects automatically if the user changes their timezone preference in Profile.
   - Cached in TanStack Query key `["presence"]`.

5. **Desktop Rail & Accessible Mobile Drawer**:
   - Desktop screens (`md` and wider) render a fixed 16rem/256px (w-64) width right rail beside the horizontal Kanban viewport.
   - Narrow screens render a `Members` button in the header that opens an overlay drawer (`role="dialog"`, `aria-modal="true"`).
   - Drawer integrates into modal suppression logic (closes when cards/archive/column delete dialogs open, suppresses keyboard shortcuts while open, restores trigger focus on close).
   - Online members sorted first, then offline members, preserving name order within each group.

## Consequences
- Board mutation protocol and per-board SQLite remain clean and focused on card/column state.
- Presence state survives hibernation and resumes accurately from active socket attachments and SQLite last-seen timestamps.
- Color is not the sole indicator of presence (clear "Online", "Last online <time>", or "Last online unknown" copy is rendered).
