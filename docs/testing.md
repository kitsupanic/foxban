# Testing & tooling

## Local dev

`wrangler dev`. Miniflare simulates DOs and D1; some behaviors differ from prod — test WS hibernation in a deployed preview before relying on it.

## Test layers

Three layers run separately. Nothing about them is interchangeable: the first
two are cheap and automatic, the third is manual and owns real services.

### API integration — `apps/api/test`

Vitest + `@cloudflare/vitest-pool-workers`, executing against the real Workers
runtime with BoardDO SQLite storage, D1 and R2 bindings. Priority target: board
mutation logic in the DO — CRUD, fractional-index moves, snapshot correctness.
Run with `pnpm --filter @foxban/api test`. These are integration tests against a
real runtime; do not describe them as isolated unit tests.

Who may open a board is one rule written in several places, so
`workspace-admin-private-boards.test.ts` runs every kind of viewer (workspace
admin, workspace member, board member, Guest, Operator, stranger) against every
surface of a Private board: the list, by key, by id, the WebSocket connect, the
member, candidate and transfer reads, and the write routes. A row that disagrees
with the others is the bug. It also proves a role change drops open connections
and tells the people it affects.

Admin is an exact address on `ADMIN_EMAILS` (ADR 0071). The vitest config lists `*@wild.test` (which must stay ignored) and `Mixed@Case.Test`; the suite's own admins live on `@foxban.test`, and `test/admin-signups.ts` (a setup file) lists each such address as its signup goes through `SELF.fetch`, by wrapping `SELF` with `vi.mock`. The Worker and the Durable Objects read the same `env`, so both see the entry. A signup that does not go through `SELF.fetch` (a direct `worker.fetch`) must list its address itself, as `auth.test.ts` does for the GitHub cases.

MCP coverage uses the published `@modelcontextprotocol/client` 2.0.0 against
`SELF.fetch`, real D1 migrations and real BoardDO SQLite. `mcp.test.ts` proves
transport negotiation/discovery and the read/task/comment/subtask-completion/label-management paths;
`agent-credentials.test.ts` covers session-only issuance/list/revocation and
digest storage. BoardDO regressions protect the MCP receipt table (schema v23) and the shared browser
mutation path.

Races between two requests are tested by pausing one request's D1 binding rather than by hoping two `SELF.fetch` calls overlap: `workerWithPausedD1` in `paused-d1.ts` (shared by `workspace-delete.test.ts` and `workspace-roles.test.ts`) calls the Worker with `env.DB` wrapped so a hook runs before the n-th statement or batch, and the test runs the competing request (a board created or moved in, or the delete) at every gap in turn. A check-then-delete version of the workspace delete fails it at exactly the gap between the check and the delete. The same sweep runs a demotion of the inviter at every gap of an invite acceptance, and a second time as a direct write that skips the workspace lock, so the reservation's check and the commit's check are each shown to be needed.


### Service-free web logic — `apps/web/test`

Playwright's runner under `apps/web/playwright.logic.config.ts` (project
`logic`, `workers: 1`, `retries: 0`, `forbidOnly: true`, list reporter). That
config declares no `webServer`, no browser or device configuration and no global
hooks. The specs drive production modules directly — `applyMutation`,
`reconcileArchivedCards` and `purgeArchivedCards`,
`createBoardReconciler`, `taskKey` and `cardForTaskKey` — and request no
Playwright fixtures, so a run launches no browser, applies no D1 migrations,
takes no E2E lock and binds no port.

```bash
pnpm --filter @foxban/web test
```

Artifacts go to `apps/web/test-results-logic/` (git-ignored), separate from the
focused browser lane's `test-results`. An empty selection fails: neither this
config nor the focused lane passes with no tests.

### Manual browser E2E — `apps/web/e2e`

Chromium journeys against the real local stack (Wrangler API, Vite, GitHub
stub). Never automatic — see [Playwright lanes](#playwright-lanes).

Timer-driven UI is proven with Playwright's fake clock, never a sleep:
`await page.clock.install()` **before** the first navigation, then
`await page.clock.fastForward(…)` to fire the pending timer while the page
keeps its real network. GitHub development info has no timer to prove: nothing
polls (ADR 0064), so `github-board.spec.ts` drives it the way GitHub does. The
stub (`github-stub.mjs`) hands the instance its App (a real RSA key, so the
Worker's App JWT is checked), answers the Worker's reads, and sends **signed**
webhooks to the real Worker: through `/_test/deliver`, through `/_test/pr-state`
for a pull request moving, and by itself when the Worker creates a branch or a
pull request. A card or board front then updates live, with no reload. A forged
delivery (wrong secret) is proven refused by the Worker's status.

Root `pnpm test` (`pnpm -r --if-present test`) runs the first two layers: the
API layer still exercises the real Workers runtime in-process, while the logic
layer starts nothing. What `pnpm test` does not do is launch a browser or the
local application stack. Full validation is root `pnpm test` **plus** the manual
`pnpm --filter @foxban/web test:e2e` gate.

## What we deliberately don't test

- UI pixel tests.
- Load tests (2 users).
- Tailwind utility classes: the task-type stripe and description-counter tests
  assert picker text, `data-task-type` state, exact byte counts and persistence
  rather than the classes that render them.
- Exact wording of the two `CommentSchema` body/deleted invariant messages: that
  test asserts parse outcome, issue count and `path: ["body"]` instead. Other
  error contracts — status codes, `code` discriminators such as
  `transfer_terminal`, and the specific messages tests already rely on — remain
  asserted.

## Deploy

There is no CI or deploy workflow for now (ADR 0070). Before you open a pull request, run `pnpm typecheck` and `pnpm test` yourself, and `pnpm --filter @foxban/web test:e2e` for UI changes. Deploy with `pnpm run deploy` (`scripts/deploy.mjs`) or the Deploy to Cloudflare button.

## Playwright lanes

Three public browser commands, run from the repository root:

```bash
pnpm --filter @foxban/web run test:e2e        # authoritative full two-shard gate
pnpm --filter @foxban/web run test:e2e:smoke  # bounded representative selection, one stack
pnpm --filter @foxban/web run test:e2e:focus boards.spec.ts
```

`test:e2e:focus` is the generic focused entry point: it forwards every argument
to Playwright through `apps/web/e2e/run-focused.mjs`, so pass files and
`--grep` filters directly, with no extra `--` separator. Paths are resolved from
`apps/web`.

Internal diagnostics are direct Node invocations, not package scripts:

```bash
node apps/web/e2e/run-e2e.mjs --smoke   # full two-shard lifecycle, bounded selection
node apps/web/e2e/run-shards.mjs 1      # one standalone shard, ephemeral state (or 2)
```

Timed JSON output is a diagnostic env var on the focused wrapper rather than its
own lane. Create the output directory before invoking it:

```bash
mkdir -p apps/web/test-results
PLAYWRIGHT_JSON_REPORT=test-results/timed-report.json node apps/web/e2e/run-focused.mjs boards.spec.ts
```

The resulting `apps/web/test-results/timed-report.json` is git-ignored.

### Rerunning failures after the full gate

The full `test:e2e` lane is authoritative, and its `--last-failed` state is not
reusable: each shard runs in a coordinator-owned output directory that is
removed only after a successful full gate, while any `--last-failed` state under
`apps/web/test-results` belongs to the focused lane, not to the gate. Never
treat a focused `--last-failed` rerun as a rerun of the gate's failures.

**Preserve the failed run before rerunning anything.** A failed gate copies its
blobs, persistence and artifacts to `apps/web/test-results/failed-e2e-<runId>`
(`failed-standalone-<runId>` for standalone shards), which is *inside* the
focused lane's default `outputDir` (`apps/web/test-results`). Playwright clears
that directory when a focused run starts, so the retained state is destroyed by
the very rerun you are about to do. Move it somewhere else first — the merged
HTML report in `apps/web/playwright-report/` survives, but the run state does
not:

```bash
mv apps/web/test-results/failed-e2e-<runId> /tmp/foxban-failed-e2e-<runId>
```

Then take the exact file and full test title from the merged report and rerun
them explicitly:

```bash
pnpm --filter @foxban/web run test:e2e:focus card-details.spec.ts --grep 'exact full test title$'
```

An exact rerun is composite evidence, not a clean full run; a failed gate stays
failed until a full gate passes.

### The authoritative two-shard gate

`test:e2e` runs `apps/web/e2e/run-e2e.mjs`, which launches **shard 1/2 and
shard 2/2 concurrently**, each in its own isolated stack, then merges the two
blob reports. It exits non-zero if either shard or the report merge fails.
The focused single-stack entry points (`test:e2e:smoke` and `test:e2e:focus`)
run via `apps/web/e2e/run-focused.mjs`, which acquires the shared E2E lock and
asserts ports (8787, 5173, 8788) are free on 127.0.0.1 before spawning Playwright.
Playwright's `webServer` is configured with `reuseExistingServer: false` to ensure
it never connects to pre-existing or foreign services. Raw `playwright test`
invocations against the browser config bypass lifecycle ownership and lock
protection; the service-free logic config is the one exception, since it starts
no services and takes no lock.

Each shard (`apps/web/e2e/run-shards.mjs`) owns a complete, isolated run:

- **Unique run identity.** The coordinator generates one run id and shares it
  with both shards (`E2E_RUN_ID`); the run owns a fresh temp directory tree.
- **Unique persistence.** Each shard runs D1 migrations against its own fresh
  Wrangler `--persist-to` directory before any service starts; no run ever
  reuses stale state, and the coordinator removes the whole tree after merging.
- **Run-lock serialized local E2E invocations & static disjoint ports.** An atomic
  shared E2E run lock directory (`foxban-e2e.lock`) serializes all local E2E entry points
  across coordinator gates, standalone shard runs, and Playwright-managed
  focused lanes to prevent contention over ports and machine resources. The lock
  uses atomic directory creation (`mkdir`); incomplete, missing, or corrupt metadata
  as well as confirmed dead-PID locks fail closed immediately. Automatic stale takeover
  is completely disabled to prevent contender races against live locks; leftover locks
  from crashes require explicit operator verification and cleanup (`rm -rf <lockDir>`).
  Release verifies the ownership token before directory removal.
  Under this lock, coordinator and shards use fixed, documented disjoint port sets
  (shard 1: API 8787, Vite 5173, GitHub stub 8788, inspector 9233; shard 2: API 8790,
  Vite 5174, GitHub stub 8791, inspector 9234). All supported entry points fail fast before
  migrations or service startup if any required port is occupied on 127.0.0.1.
- **Real, contingent readiness, no sleeps.** After migrations each shard starts Wrangler,
  Vite, and the GitHub stub with direct workspace binaries (never a
  `pnpm … dev` wrapper), then polls each over HTTP with a bounded probe. Readiness
  probes are strictly contingent on the owned child process remaining alive: if a
  spawned service exits before readiness is reached, the probe aborts immediately
  rather than accepting a foreign listener or waiting out the timeout budget.
  Two workers inside every shard (`E2E_WORKERS` overrides; three flaked under load), so
  tests in one shard share its stack: anything instance-wide, such as account invites,
  must be found by its own id, never by count or position. No test retries or timeout inflation.
- **Mergeable reports.** Each coordinator shard is configured via environment
  (`E2E_BLOB_DIR` and `E2E_BLOB_FILE`) to emit a Playwright blob report with a
  unique filename. The coordinator validates that exactly two expected shard blobs
  are gathered, merges them into the combined HTML report at `apps/web/playwright-report/`,
  and removes the temporary run state only on full success. On failure or signal,
  run artifacts are retained under `apps/web/test-results/failed-e2e-<runId>`
  (or `failed-standalone-<runId>` for standalone runs) until the next focused run
  clears `test-results`; see [Rerunning failures after the full gate](#rerunning-failures-after-the-full-gate).
- **Clean teardown & unconditional process-group reaping.** Each shard wrapper is spawned
  as its own coordinator-owned process group, while runner services run inside that
  wrapper's process group. In addition to graceful cooperative shutdown, the coordinator
  unconditionally reaps each wrapper's entire process group after wrapper settlement
  (SIGTERM, bounded check, SIGKILL, and confirming ESRCH), ensuring any background
  descendants (such as orphaned Vite or browser helpers) are eliminated even if the
  leader process exited normally. Standalone signals run cooperative teardown and
  finalization, returning 130 for SIGINT and 143 for SIGTERM.
Manual deployments: `pnpm run deploy` with the instance's values in `.env.deploy` or the environment (see `.env.deploy.example`). It ensures the D1 database and R2 bucket exist, applies D1 migrations (`wrangler d1 migrations apply DB --remote`) before the Worker/asset deploy so a migration failure aborts the release before any code ships, then uploads secrets. `ADMIN_EMAILS=… node scripts/deploy.mjs --dry-run` prints the generated config and commands without touching Cloudflare. Before deploying a production instance, take a private D1 export (`wrangler d1 export DB --remote --output <private path>`), kept outside the repository.

The documented `apps/api/scripts/mcp-client.mjs` helper is a local developer
client. Validate it against the owned local stack or development deployment
with credentials supplied only through environment variables. It deliberately
does not retry mutations or rotate operation keys.


## Cloudflare GraphQL analytics telemetry

For investigating Durable Object activity, quota usage, and reconnect cycles, query Cloudflare's GraphQL analytics API:

- **Periodic storage and message traffic**: Query `durableObjectsPeriodicGroups` with `sum.rowsRead`, `sum.rowsWritten`, and `sum.outboundWebsocketMsgCount`, filtered by `date` and `namespaceId`, grouped by object name (`dimensions.objectId` or `dimensions.objectName`) and hour (`dimensions.datetimeHour`).
- **Invocations and response statuses**: Query `durableObjectsInvocationsAdaptiveGroups` with `sum.requests` and `sum.errors`, grouped by object name, `dimensions.status`, `dimensions.type`, and `dimensions.datetimeHour`. Reconnect storms characteristically exhibit thousands of `responseStreamDisconnected` HTTP status invocations matched with hibernation invocations and high row reads.

Do not persist account IDs or raw object UUIDs in general documentation.
Production is never an implicit promotion from dev or CI. It is deployed strictly manually.
