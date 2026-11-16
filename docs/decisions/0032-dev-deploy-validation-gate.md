# 0032 — Dev deploy validation gate

## Status
Accepted — 2026-09-05. Its GitHub Actions parts are superseded by ADR 0070.

## Context
ADR 0031 required Chromium Playwright E2E tests before automatic dev deployment. This ADR supersedes only that validation-gate clause; ADR 0031's environment isolation, automatic dev deployment and manual production boundary remain accepted. Running browser installation and E2E suites on every push adds unnecessary CI latency to an already isolated development environment.

## Decision
- Automatic dev deployment on pushes to `main` gates only on `pnpm typecheck` and `pnpm test`, followed by dev migration/deployment and root HTTP 200 plus unauthenticated `/me` HTTP 401 health checks.
- Playwright E2E is an explicit manual command (`pnpm --filter @foxban/web test:e2e`), not an automatic deploy gate or git pre-push hook.
- Production remains manual and should receive deliberate E2E verification prior to release.

## Consequences
Trades faster dev feedback for allowing browser-only regressions onto isolated dev. Production safety remains guarded by deliberate manual release verification.
