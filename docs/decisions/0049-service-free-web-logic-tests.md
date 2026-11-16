# 0049 — Service-free web logic tests in root `pnpm test`

## Status
Accepted — 2026-09-11

## Context
Pure reducer, reconciliation and task-key specs lived in `apps/web/e2e/` under the browser Playwright configuration, so even a focused run started Wrangler, Vite and the GitHub stub, applied D1 migrations and took the shared E2E lock although those cases request no Playwright fixtures. The browser package also exposed eight lanes, two of which were misleading: `test:e2e:affected` always selected four hard-coded files, and `test:e2e:last-failed` read focused-lane state under `apps/web/test-results`, which is never the sharded gate's state — each gate shard runs in a coordinator-owned output directory, discarded only after a successful full gate and otherwise retained as `failed-e2e-<runId>`.

## Decision
- The 23 pure web cases live in `apps/web/test/` and run under `apps/web/playwright.logic.config.ts` (project `logic`, `workers: 1`, no `webServer`, no browser/device configuration, no global hooks), driving production modules directly. No new test framework is introduced: the already-installed `@playwright/test` runner is reused.
- `@foxban/web`'s `test` script runs that config, so root `pnpm test` (`pnpm -r --if-present test`) covers API integration plus service-free web logic. Full validation is root `pnpm test` plus the manual browser gate.
- Public browser lanes are exactly `test:e2e` (authoritative two-shard gate), `test:e2e:smoke`, and the generic `test:e2e:focus`. The six replaced lanes are deleted without compatibility aliases; standalone coordinator smoke, standalone shard runs and `PLAYWRIGHT_JSON_REPORT` remain available as direct Node diagnostics.
- Manual browser E2E is unchanged: same specs, Chromium project, shard isolation, lock, ports, fresh persistence, report merge, teardown and failure propagation, with no retries, timeout changes or `--pass-with-no-tests`.
- ADR 0032 stands unmodified: browser E2E remains outside automatic dev CI, which continues to gate on `pnpm typecheck` and `pnpm test`.

## Consequences
- Logic feedback no longer depends on Cloudflare credentials, browser binaries, migrations, free ports or the E2E lock, and its artifacts are isolated in `test-results-logic/`.
- Logic and browser selections are disjoint and together preserve all 175 original web cases: 23 moved out of browser discovery into the logic project, leaving 152 in the browser gate. No web case was deleted.
- Separately, the API suite loses only the independent binding-shape canary (`apps/api/test/harness.test.ts`), so API discovery goes from 218 to 217 cases. That deletion has nothing to do with the web union.
- `pnpm test` now includes a browser-package script, so a broken logic config fails the automatic dev gate — the intended trade for covering that layer automatically.
- Rejected: adding Vitest to `apps/web` (a second runner for specs that already pass under the installed one), keeping aliases for the deleted lanes (they re-advertise the misleading `affected`/`last-failed` semantics), and adding a browser gate to CI (superseded question, settled by ADR 0032).
