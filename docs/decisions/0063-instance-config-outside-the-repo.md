# 0063 — Instance config lives outside the repo

## Status
Accepted — 2026-11-10

## Context
foxban is being prepared for open source as a free Kanban anyone can run on
their own Cloudflare account. `wrangler.jsonc` held one instance's values:
admin email, custom domains, D1 ids, GitHub App ids. Those can't ship in a
public repo.

## Decision
- The committed `wrangler.jsonc` holds only safe defaults that deploy to
  `workers.dev`: no domain, no emails, no resource ids.
- Each instance supplies its own values from one of two sources, read by the
  same deploy script: GitHub Actions variables and secrets (for forks that
  deploy from CI), or a local untracked file (for clones that deploy with
  `wrangler` from a laptop).
- Separate instances of one fork (for example dev and production) are GitHub
  Environments with their own variables, not `env.*` blocks in the config. A
  push to main deploys the environment named by the `DEPLOY_ON_PUSH` variable,
  and does nothing when it is unset.
- The public repo starts as a fresh commit with no history, so earlier
  instance values never become public.

## Consequences
Every instance deploys from the public code. Rejected:
a private fork holding the real config (drifts from upstream), rewriting
history to scrub values (slow, easy to miss one), publishing history as is.
