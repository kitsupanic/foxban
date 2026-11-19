# 0083 — Browser writes and socket upgrades carry a checked origin

## Status
Accepted — 2026-11-19.

## Context
The session cookie is `SameSite=Lax`, which still sends it on requests from the same site: a sibling subdomain counts. The workspace write routes read `c.req.json()` whatever the `Content-Type` says, so a sibling page could post a `text/plain` form whose body is JSON and have it run as the signed-in person. Some requests go out with no CORS preflight whatever is done to their content type (a form, `text/plain`, an `<a ping>` POST sent as `text/ping`), and WebSocket handshakes are never preflighted: a sibling page could open the board socket, read the snapshot and send mutations as the victim.

## Decision
- The Worker refuses (403) every non-GET/HEAD/OPTIONS request, and the `/boards/:id/ws` and `/presence/ws` upgrades, that states `Sec-Fetch-Site` or `Origin`, unless `Sec-Fetch-Site` is `same-origin` or `Origin` equals the request's own origin or `APP_ORIGIN` (`appOrigin`, so a deployment behind a proxy and browsers without `Sec-Fetch-Site` still pass). The content type plays no part. `Origin: null` (a sandboxed frame, a cross-origin redirect) is refused.
- A request that states neither header skips the check. Every browser states one on a write and `Origin` on a socket handshake. A caller that states neither is not a browser carrying a cookie it did not choose: the GitHub webhook (signature-authenticated), the MCP endpoint (bearer token) and scripts.
- Hono's `csrf()` was not used: it checks only form content types, so it lets `text/ping` through, and it ignores `APP_ORIGIN`.

## Consequences
A cross-origin browser write is a 403 on every route, so a route added later that reads JSON without checking `Content-Type` is covered too. A browser too old to send either header gets no check, and falls back to `SameSite=Lax` alone.

Rejected: checking `Content-Type` in each handler (every new route must remember); a CSRF token (a second secret for the SPA to carry, for a threat the origin headers already close).
