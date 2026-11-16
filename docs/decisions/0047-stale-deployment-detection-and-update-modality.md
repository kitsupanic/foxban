# 0047 — Stale-deployment detection and update prompt modality

## Status
Accepted — 2026-09-10

## Context
Foxban is a single-page application served from Cloudflare Workers Static Assets. Long-lived browser tabs can stay open across deployments, retaining outdated client bundles while the edge serves new hashed JavaScript assets. Stale tabs need to detect newer deployments across any route without disturbing the user's view or forcing loss of in-flight work.

## Decision
- Deployment identity is an opaque build ID generated per Vite process (`process.env.FOXBAN_BUILD_ID` or `crypto.randomUUID()`), embedded into the client bundle as `__FOXBAN_BUILD_ID__` via Vite `define` and served at `/foxban-version.json` (emitted asset for build, middleware for dev).
- Build detection is decoupled from `REALTIME_PROTOCOL_VERSION` (ADR 0045): protocol version gates breaking WebSocket wire contracts, whereas build IDs identify every static deployment.
- Detection queries `/foxban-version.json?current=<id>&t=<timestamp>` with `cache: "no-store"`. Network failures, non-2xx responses, aborts, and malformed payloads fail silently without disrupting the page.
- Detection triggers immediately on mount, every 5 minutes, on window `focus`, document `visibilitychange` to visible, window `online`, and before WebSocket reconnect attempts (`apps/web/src/lib/socket.ts` and `apps/web/src/lib/presence.ts`). Tabs detect state independently without cross-tab storage.
- A single `AppUpdatePrompt` mounts at root inside `QueryClientProvider`. When a build ID mismatch is observed, stale status is latched and an accessible modal is presented via a dedicated portal host (`[data-foxban-update-portal-host]`).
- The update modal amends ADR 0020 for stacked body portals: while open, it marks all other direct children of `document.body` (including `#root` and any sibling portal hosts such as `DescriptionEditor`) as `inert`, preserving and restoring each element's prior inert state on Later, reload, or unmount.
- To arbitrate Escape and keyboard ownership across stacked window capture listeners, `AppUpdatePrompt` sets `data-foxban-update-prompt-active="true"` on `document.documentElement` while visible. Sibling capture listeners (such as `DescriptionEditor`) check this marker and yield immediately. `AppUpdatePrompt`'s own capture Escape handler also calls `stopImmediatePropagation()` to shield downstream listeners.

## Consequences
- Rejected: Service Worker cache management. Foxban has no service worker; introducing one adds dual-cache complexity and lifecycle synchronization hazards when a same-origin version document is sufficient.
- Rejected: Reusing `REALTIME_PROTOCOL_VERSION`. Everyday UI and client-only changes do not break realtime schema contracts and must not trigger 409 handshake rejections or circuit breakers.
- Rejected: Persistent update snooze. Dismissing with "Later" or Escape is temporary: the prompt will reappear on subsequent lifecycle triggers (focus, visibility, interval, reconnect) as long as the tab remains on an obsolete build.
