# 0026 — Profile route and account settings

## Status
Accepted — 2026-09-03. Its "GitHub is never authentication" clause is reversed by ADR 0065.

## Context
ADR 0024 left the GitHub link/disconnect control in a Boards-page header disclosure and pointed the OAuth callback at `/`. This ADR adds real account settings — display name, sign-in email, password — and a disclosure on one page cannot hold four sections, so profile needs a home. Emails also gate admin status (`ADMIN_EMAILS`, ADR 0012's configured-not-stored rule) and there is no email-delivery service to verify ownership with, so the email and password actions need an authorization story of their own.

## Decision
- Profile is a dedicated authenticated `/profile` route behind the existing root session check; Boards and Profile are the only two top-level pages, sharing one header of URL-backed links (no ARIA tab widgets), the avatar/email, and sign out. The board workspace keeps its own header.
- Settings are separate actions, not one form: `PATCH /me` for the name (and GitHub disconnect, unchanged), `POST /auth/email`, `POST /auth/password`. Each Profile section owns its own mutation and messages.
- Email and password changes verify the current password first — the generic 401 precedes any duplicate/allowlist inspection, so a wrong password leaks nothing — and write compare-and-set against the verified hash so a concurrent rotation cannot be authorized by a stale proof. An email change that would alter `isAdminEmail` in either direction is refused: current-password verification is the ownership proof (no email-delivery verification exists), and admin access stays configured, never transferred by rename.
- A password change keeps the current session and revokes all others atomically with the hash rotation (one D1 batch). Revocation gates new HTTP requests and new socket handshakes; an already-open board socket lives until it reconnects — the same connect-time-only semantics as member removal. BoardDO stays identity-blind.
- Login inserts its session only while the verified password hash still matches the user row. A login paused across rotation returns 401 without a cookie instead of creating an old-password session after revocation.
- The OAuth callback lands on `/profile`, failures on `/profile?github=error`; Profile is the sole consumer of that flag. Supersedes ADR 0024's Boards-header placement and callback destination; GitHub remains avatar linking, never authentication (ADR 0008 stands).

## Consequences
Rejected: ARIA tabs with local state — two pages with URLs are simpler and shareable. Rejected: one combined settings form — partial failures would entangle unrelated drafts. Rejected: email verification or an admin-transfer flow — no delivery service exists and admin access is configuration. Rejected: revoking the current session too — signing the user out of the browser that just proved the password punishes the wrong party. Cost accepted: a live board socket opened before a password change keeps streaming until it reconnects.
