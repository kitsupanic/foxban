# 0012 — Invite-link signup gating, env-configured admins

## Status
Accepted — 2026-08-31

## Context
ADR 0011 made gating signup a blocker for the public URL. We chose
single-use invite links generated from an admin panel over a shared invite
code, an email allowlist, or Cloudflare Access.

## Decision
- D1 `invites` table; `used_at IS NULL` is the spendable predicate. Tokens are
  32 random bytes base64url, stored plaintext so pending links stay copyable
  from the panel; spent rows are kept as the audit trail.
- Signup consumes the token atomically with user creation in one `DB.batch`
  (conditional UPDATE claim + EXISTS-guarded INSERT); every invite failure is
  the same generic 403 — no token-status oracle.
- Admins are configured, not stored: `ADMIN_EMAILS` env var (comma list,
  `*@domain` wildcards, case-insensitive). The first account on a fresh
  deployment can therefore register without an invite nobody could have minted.
  Prod value in `wrangler.jsonc` vars; dev/e2e override in `.dev.vars`
  (`*@admin.test`, committed — not a secret).
- Auth endpoints rate-limited per IP via a Workers ratelimit binding
  (10/min); the middleware stands aside when the binding or a real
  `CF-Connecting-IP` is absent, so `wrangler dev` and the test pools are
  unthrottled.

## Consequences
Signup is closed without an invite; board membership remains a separate,
per-board invite (ADR 0011). Rejected: shared invite code (not revocable
per person), email allowlist (redeploy per person), Cloudflare Access
(double login for a 2-user board), stored `is_admin` flag (bootstrap
problem the env var avoids).
