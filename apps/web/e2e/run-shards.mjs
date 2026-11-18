// Runs ONE Playwright shard against its own isolated local stack.
//
// Lifecycle (synchronous ordering, no sleeps):
//   1. resolve the shard number, run identity, and per-run directories;
//   2. apply D1 migrations to a fresh, unique persistence directory;
//   3. spawn Wrangler (API), Vite, and the GitHub stub directly;
//   4. wait for all three to answer HTTP with bounded readiness probes;
//   5. run Playwright (`--shard=N/2`, plus a bounded grep when E2E_SMOKE=1);
//   6. stop every owned process group and await their exit;
//   7. report the Playwright exit code.
//
// The authoritative two-shard gate is e2e/run-e2e.mjs, which runs this file
// once per shard concurrently. When invoked directly
// (`node apps/web/e2e/run-shards.mjs 1`) this
// file creates ephemeral persistence/artifact directories and removes them
// when it finishes, so no stale state is ever reused.
//
// Environment (shard number is E2E_SHARD or argv[2]):
//   E2E_RUN_ID        run identity shared by both coordinator shards
//   E2E_PERSIST_DIR   Wrangler persistence dir (coordinator-owned) when set
//   E2E_OUTPUT_DIR    Playwright artifact outputDir (coordinator-owned) when set
//   E2E_BLOB_DIR      blob reporter outputDir (coordinator-owned) when set
//   E2E_BLOB_FILE     blob reporter fileName (must end in .zip)
//   E2E_SMOKE=1       bounded representative selection, allow an empty shard
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  acquireE2eLock,
  releaseE2eLock,
  assertPortsFree,
  SHARD_DEFAULT_PORTS,
} from "./e2e-lock.mjs";
const e2eDir = path.dirname(fileURLToPath(import.meta.url)); // .../apps/web/e2e
const appsWeb = path.resolve(e2eDir, "..");
const appsApi = path.resolve(appsWeb, "../api");
const ext = process.platform === "win32" ? ".cmd" : "";
const bin = (dir, name) => path.join(dir, "node_modules", ".bin", `${name}${ext}`);
const wrangler = bin(appsApi, "wrangler");
const repoRoot = path.resolve(appsApi, "../..");
const wranglerConfig = path.join(repoRoot, "wrangler.jsonc");
const viteBin = bin(appsWeb, "vite");
const playwright = bin(appsWeb, "playwright");
const githubStub = path.join(e2eDir, "github-stub.mjs");

const shard = Number(process.env.E2E_SHARD ?? process.argv[2] ?? 1);
if (shard !== 1 && shard !== 2) throw new Error("Usage: node apps/web/e2e/run-shards.mjs <1|2> (or set E2E_SHARD=1|2)");

// Ports are configurable via environment (passed explicitly by coordinator)
// or fall back to default disjoint tables. Wrangler requires a dedicated
// inspector port to avoid colliding on 9229.
const DEFAULT_PORTS = SHARD_DEFAULT_PORTS;
const defaults = DEFAULT_PORTS[shard];
const api = Number(process.env.API_PORT ?? defaults.api);
const vite = Number(process.env.VITE_PORT ?? defaults.vite);
const github = Number(process.env.GITHUB_STUB_PORT ?? defaults.github);
const inspector = Number(process.env.INSPECTOR_PORT ?? defaults.inspector);
for (const [name, port] of [["api", api], ["vite", vite], ["github", github], ["inspector", inspector]]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${name}: ${port}`);
  }
}
if (new Set([api, vite, github, inspector]).size !== 4) {
  throw new Error(`Ports for shard ${shard} must be unique: ${JSON.stringify({ api, vite, github, inspector })}`);
}

const apiOrigin = `http://localhost:${api}`;
const viteOrigin = `http://localhost:${vite}`;
const githubOrigin = `http://localhost:${github}`;

const runId = process.env.E2E_RUN_ID ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const coordPersist = process.env.E2E_PERSIST_DIR;
const coordOut = process.env.E2E_OUTPUT_DIR;
const blobDir = process.env.E2E_BLOB_DIR;
const blobFile = process.env.E2E_BLOB_FILE ?? `report-shard${shard}.zip`;
const smoke = process.env.E2E_SMOKE === "1";
const failTest = process.env.E2E_FAIL_TEST === "1";
const missingBlob = process.env.E2E_MISSING_BLOB === `${shard}`;

// Playwright exits 0 (pass) or 1 (test failures). run-shards reserves a higher
// code for unrecoverable infrastructure/startup failure so the coordinator can
// distinguish "tests failed, still merge" from "stack never came up, abort".
// The coordinator mirrors this literal (2).
const INFRA_EXIT_CODE = 2;

// When run standalone (not under coordinator), acquire the shared atomic run lock
// to ensure disjoint ports and resources are not clobbered by other lanes.
let standaloneLock = null;
if (!coordPersist) {
  try {
    standaloneLock = await acquireE2eLock({
      owner: `standalone-shard${shard}-pid-${process.pid}`,
      runId,
      onLog: (msg) => console.log(`[shard ${shard}] ${msg}`),
    });
  } catch (err) {
    console.error(`[shard ${shard}] ${err.message}`);
    process.exit(INFRA_EXIT_CODE);
  }
}

// A standalone invocation owns an ephemeral root. Playwright artifacts are
// scoped to this ephemeral root (outDir = standaloneRoot/out) so concurrent
// or back-to-back standalone runs never collide or leave stale test-results.
// On failure, artifacts are preserved under apps/web/test-results/failed-standalone-<runId>.
const standaloneRoot = coordPersist ? null : await mkdtemp(path.join(os.tmpdir(), "foxban-e2e-shard-"));
const persistDir = coordPersist ?? path.join(standaloneRoot, "persist");
const outDir = coordOut ?? (standaloneRoot ? path.join(standaloneRoot, "out") : null);
// Messages are intentionally un-prefixed: the coordinator (run-e2e.mjs)
// prepends a stable `[shard N]` tag to every line, and a standalone invocation
// already knows which shard it is.
const log = (msg) => console.log(msg);
const SMOKE_GREP =
  process.env.E2E_SMOKE_GREP ??
  "signup lands on Home|a created board appears in the list and opens with its name";
const owned = [];
let stopping = false;
let bootFailure = null;

function childEnv() {
  const env = {
    ...process.env,
    API_PORT: `${api}`,
    VITE_PORT: `${vite}`,
    GITHUB_STUB_PORT: `${github}`,
    INSPECTOR_PORT: `${inspector}`,
    APP_ORIGIN: viteOrigin,
    GITHUB_OAUTH_BASE: githubOrigin,
    GITHUB_API_BASE: githubOrigin,
    E2E_RUN_ID: runId,
    E2E_SHARD: `${shard}`,
    E2E_NO_WEBSERVER: "1",
    // Admin addresses already used in this shard's database (helpers.ts uniqueEmail): they go with it.
    E2E_SLOT_DIR: path.join(persistDir, "e2e-admin-slots"),
  };
  if (outDir) env.E2E_OUTPUT_DIR = outDir;
  if (blobDir && !missingBlob) {
    env.E2E_BLOB_DIR = blobDir;
    env.E2E_BLOB_FILE = blobFile;
  }
  if (smoke) env.E2E_SMOKE = "1";
  if (failTest) env.E2E_FAIL_TEST = "1";
  return env;
}
// Each service is spawned detached into its own process group so teardown can
// terminate the whole tree (Wrangler/Vite may fork helpers), not just the
// parent. stdio is inherited so the coordinator can prefix every line.
function launch(binPath, args, { cwd, env, label }) {
  // Keep children in the runner's process group so coordinator escalation
  // (which targets -child.pid on the shard wrapper) reliably reaches all
  // runner children and their sub-processes.
  const child = spawn(binPath, args, { cwd, env, stdio: "inherit" });
  child.label = label;
  owned.push({ child, label });
  return child;
}

function killChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    /* process already gone */
  }
}

async function stopAll() {
  stopping = true;
  for (const { child } of owned) {
    if (child.exitCode === null && child.signalCode === null) killChild(child, "SIGTERM");
  }
  await Promise.all(
    owned.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const force = setTimeout(() => killChild(child, "SIGKILL"), 4000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
        }),
    ),
  );
}

// Readiness probe: any HTTP status means the listener is up (a responding
// server is "ready"); only network failures and the service-exit signal count
// as not ready. Checks bootFailure each iteration so a service that dies
// mid-boot aborts fast instead of waiting out the probe budget.
// Also requires that child (the spawned process) is still running.
async function waitForHttp(url, child, timeoutMs, validate) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (bootFailure) throw bootFailure;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${child.label ?? "service"} exited before readiness check succeeded`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out after ${timeoutMs}ms waiting for ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(1500, remaining));
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`${child.label ?? "service"} exited before readiness check succeeded`);
      }
      if (validate) {
        const ok = await validate(res).catch(() => false);
        if (ok) return;
      } else {
        return;
      }
    } catch (fetchErr) {
      clearTimeout(timer);
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`${child.label ?? "service"} exited before readiness check succeeded`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main() {
  await mkdir(persistDir, { recursive: true });
  if (outDir) await mkdir(outDir, { recursive: true });
  if (blobDir) await mkdir(blobDir, { recursive: true });
  const env = childEnv();

  log(`shard ${shard} · run ${runId} · api :${api} vite :${vite} github :${github}`);
  log(`persistence ${persistDir}` + (outDir ? ` · artifacts ${outDir}` : "") + (blobDir ? ` · blob ${blobDir}/${blobFile}` : ""));

  // Check that assigned ports are available before spending time on migrations.
  await assertPortsFree({ api, vite, github, inspector });

  const migration = spawnSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "-c", wranglerConfig, "--persist-to", persistDir], {
    cwd: appsApi,
    env,
    stdio: "inherit",
  });
  if (migration.status !== 0) throw new Error(`migration failed (exit ${migration.status})`);

  const apiChild = launch(wrangler, [
    "dev",
    "--env-file",
    "apps/api/.dev.vars", // resolved against the config's directory, the repo root
    "--port",
    `${api}`,
    "--inspector-port",
    `${inspector}`,
    "--persist-to",
    persistDir,
    "--var",
    `APP_ORIGIN:${viteOrigin}`,
    "--var",
    `GITHUB_OAUTH_BASE:${githubOrigin}`,
    "--var",
    `GITHUB_API_BASE:${githubOrigin}`,
  ], { cwd: repoRoot, env, label: "api" });
  const viteChild = launch(viteBin, ["--host", "localhost", "--port", `${vite}`], { cwd: appsWeb, env, label: "vite" });
  const stubChild = launch(process.execPath, [githubStub], { cwd: appsWeb, env, label: "github-stub" });
  for (const child of [apiChild, viteChild, stubChild]) {
    child.once("exit", (code, signal) => {
      if (!stopping && !bootFailure) {
        bootFailure = new Error(`${child.label} exited unexpectedly (code ${code}, signal ${signal}) before tests`);
      }
    });
  }

  try {
    await waitForHttp(`${apiOrigin}/`, apiChild, 90_000, async (res) => {
      if (res.status !== 200) return false;
      const text = await res.text().catch(() => "");
      return text.includes("foxban");
    });
    await waitForHttp(`${viteOrigin}/`, viteChild, 90_000, async (res) => {
      if (res.status !== 200) return false;
      const text = await res.text().catch(() => "");
      return text.includes("foxban") || text.includes("/src/main.tsx");
    });
    await waitForHttp(`${githubOrigin}/`, stubChild, 90_000, async (res) => {
      if (res.status !== 200) return false;
      const text = await res.text().catch(() => "");
      return text === "github stub";
    });
  } catch (err) {
    throw new Error(`services not ready: ${err.message}`);
  }
  log("services ready — starting tests");
  const isFailing = process.env.E2E_FAIL_TEST === "1";
  const args = ["test", `--shard=${shard}/2`];
  if (isFailing) {
    args.push("--grep", SMOKE_GREP, "--max-failures=1");
    env.APP_ORIGIN = "http://localhost:1";
  } else if (smoke) {
    args.push("--grep", SMOKE_GREP, "--pass-with-no-tests");
  }
  if (process.env.E2E_SIMULATE_INFRA_EXIT === `${shard}`) {
    log(`simulating infrastructure failure on shard ${shard}`);
    throw new Error(`simulated infra crash on shard ${shard}`);
  }
  const testChild = launch(playwright, args, { cwd: appsWeb, env, label: "test" });
  const code = await new Promise((resolve) => testChild.once("exit", (c, signal) => resolve(signal ? 1 : c ?? 1)));
  return code;
}
let interruptedSignal = null;
function registerSignals() {
  const shutdown = (sig) => {
    if (stopping) return;
    interruptedSignal = sig;
    // Let the main execution or finally block handle teardown and finalization
    // rather than exiting directly and stranding artifacts.
    stopAll().catch(() => {});
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
registerSignals();

(async () => {
  let code = INFRA_EXIT_CODE;
  try {
    code = await main();
  } catch (err) {
    code = INFRA_EXIT_CODE;
    console.error(err && err.message ? err.message : err);
  } finally {
    await stopAll().catch(() => {});
    if (interruptedSignal) {
      code = interruptedSignal === "SIGINT" ? 130 : 143;
    }
    if (standaloneRoot) {
      if (code !== 0) {
        const stableDir = path.join(appsWeb, "test-results", `failed-standalone-${runId}`);
        try {
          await mkdir(path.join(appsWeb, "test-results"), { recursive: true });
          if (process.env.E2E_SIMULATE_ARCHIVE_FAIL === "1") {
            throw new Error("simulated archive failure");
          }
          await rename(standaloneRoot, stableDir);
          log(`retained standalone failure state at ${stableDir}`);
        } catch (e) {
          log(`could not retain standalone failure state: ${e.message}`);
          log(`original temporary state preserved at ${standaloneRoot}`);
        }
      } else {
        await rm(standaloneRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (standaloneLock) {
      await releaseE2eLock(standaloneLock);
      standaloneLock = null;
    }
  }
  process.exit(code);
})();
