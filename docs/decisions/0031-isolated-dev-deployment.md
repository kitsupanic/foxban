# 0031 — Isolated dev deployment

## Status
Accepted — 2026-09-05; validation gate superseded by 0032; `pnpm deploy:dev` and the env.dev layout superseded by 0063 (every instance, dev included, deploys with `pnpm run deploy` and its own env)

## Context
Deploying trunk changes directly to production risks data corruption and downtime. Foxban needs an isolated remote environment to exercise real Cloudflare primitives, live migrations, and responsive UI without sharing state or credentials with production.

## Decision
- Keep production as the top-level Wrangler target (`foxban-api`) at `foxban.example.com`, deployed manually via `pnpm --filter @foxban/api run deploy`. Never make production deployment an implicit promotion from dev or CI.
- Isolate the dev environment under Wrangler `env.dev` as Worker `foxban-dev` at `foxban-dev.example.com`, using dedicated D1 (`foxban-dev`), R2 (`foxban-dev-attachments`), Durable Object namespace, auth rate limiter (namespace `1002`), separate session cookies, and an isolated GitHub OAuth App.
- Pushes to `main` automatically validate (typecheck, tests, Playwright E2E) and deploy only dev via GitHub Actions.
- Provide `pnpm deploy:dev` as the shared root command for both CI and manual developer fallback, always applying dev D1 migrations before deploying the dev Worker.

## Consequences
Dev and production data, sessions, and rate-limit counters never intersect. Production releases remain strictly deliberate and manual. Dev requires maintaining separate Cloudflare bindings and GitHub OAuth credentials.
