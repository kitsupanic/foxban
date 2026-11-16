// Authoritative two-shard Playwright gate.
//
//   node apps/web/e2e/run-e2e.mjs [--smoke]
//
// Runs shard 1/2 and shard 2/2 concurrently, each in its own isolated local
// stack (see run-shards.mjs), then merges both blob reports into the merged
// HTML report at apps/web/playwright-report. Exits non-zero if either shard
// or the report merge fails.
//
// --smoke selects a tiny, bounded representative set across both shards so the
// full two-shard lifecycle (migrations, readiness, blob emission, merge,
// cleanup) can be verified quickly without running the whole suite.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  acquireE2eLock,
  releaseE2eLock,
  assertPortsFree,
  reapProcessGroup,
  SHARD_DEFAULT_PORTS,
} from "./e2e-lock.mjs";

const args = process.argv.slice(2);
const validFlags = new Set(["--smoke", "--fail-test"]);
for (const a of args) {
  if (!validFlags.has(a)) {
    throw new Error(`Unknown argument(s): ${args.filter((x) => !validFlags.has(x)).join(" ")}\nUsage: node apps/web/e2e/run-e2e.mjs [--smoke] [--fail-test]`);
  }
}
const smoke = args.includes("--smoke");
const failTest = args.includes("--fail-test");

const e2eDir = path.dirname(fileURLToPath(import.meta.url)); // .../apps/web/e2e
const appsWeb = path.resolve(e2eDir, "..");
const runner = path.join(e2eDir, "run-shards.mjs");
const ext = process.platform === "win32" ? ".cmd" : "";
const playwright = path.join(appsWeb, "node_modules", ".bin", `playwright${ext}`);

const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const runRoot = await mkdtemp(path.join(os.tmpdir(), `foxban-e2e-${runId}-`));

const log = (msg) => console.log(`[e2e] ${msg}`);
const dirFor = (kind, shard) => path.join(runRoot, kind, `shard${shard}`);

// Atomic shared E2E run lock.
// Prevents competing coordinator gates, standalone shards, and Playwright webServers
// from colliding on the fixed disjoint ports. Lock is held for the entire gate duration.
let runLock = null;
try {
  runLock = await acquireE2eLock({
    owner: `coordinator-pid-${process.pid}`,
    runId,
    onLog: log,
  });
} catch (err) {
  console.error(`[e2e] ${err.message}`);
  process.exit(2);
}

// Documented static disjoint port sets for each shard.
const SHARD_PORTS = {
  1: { ...SHARD_DEFAULT_PORTS[1] },
  2: { ...SHARD_DEFAULT_PORTS[2] },
};

// Verify all ports across both shards are free before startup.
try {
  await assertPortsFree({
    "shard 1 api": SHARD_PORTS[1].api,
    "shard 1 vite": SHARD_PORTS[1].vite,
    "shard 1 github": SHARD_PORTS[1].github,
    "shard 1 inspector": SHARD_PORTS[1].inspector,
    "shard 2 api": SHARD_PORTS[2].api,
    "shard 2 vite": SHARD_PORTS[2].vite,
    "shard 2 github": SHARD_PORTS[2].github,
    "shard 2 inspector": SHARD_PORTS[2].inspector,
  });
} catch (err) {
  console.error(`[e2e] ${err.message}`);
  await releaseE2eLock(runLock);
  process.exit(2);
}

let stopping = false;
let shutdownSignal = null;
const liveChildren = new Map(); // shard -> child

function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function stopChild(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killGroup(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!exited) {
    killGroup(child, "SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  }
}

async function stopAllChildren(timeoutMs = 5000) {
  const children = Array.from(liveChildren.values());
  await Promise.all(children.map((c) => stopChild(c, timeoutMs)));
}

async function reapAllGroups() {
  const children = Array.from(liveChildren.values());
  for (const child of children) {
    if (child.pid) {
      await reapProcessGroup(child.pid);
    }
  }
}
async function cleanupOnSignal(sig) {
  if (stopping) return;
  stopping = true;
  shutdownSignal = sig;
  log(`caught ${sig} — terminating shard processes`);
  await stopAllChildren(5000);
  await reapAllGroups();
  await retainFailureState("signal-interrupt");
  await releaseE2eLock(runLock);
  process.exit(sig === "SIGINT" ? 130 : 143);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => cleanupOnSignal(sig));
}

async function retainFailureState(reason) {
  const stableDir = path.join(appsWeb, "test-results", `failed-e2e-${runId}`);
  try {
    await mkdir(path.join(appsWeb, "test-results"), { recursive: true });
    if (process.env.E2E_SIMULATE_ARCHIVE_FAIL === "1") {
      throw new Error("simulated archive failure");
    }
    await cp(runRoot, stableDir, { recursive: true });
    log(`retained run failure artifacts (${reason}) at ${stableDir}`);
    // Only remove runRoot after successful copy
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    log(`could not copy failure artifacts to test-results: ${err.message}`);
    log(`original temporary run state preserved at ${runRoot}`);
  }
}

// Pipe each shard's output with a stable per-line prefix so concurrent stacks
// are unambiguous in the combined stream.
function runShard(shard) {
  const ports = SHARD_PORTS[shard];
  const child = spawn(process.execPath, [runner, `${shard}`], {
    cwd: appsWeb,
    env: {
      ...process.env,
      API_PORT: `${ports.api}`,
      VITE_PORT: `${ports.vite}`,
      GITHUB_STUB_PORT: `${ports.github}`,
      INSPECTOR_PORT: `${ports.inspector}`,
      E2E_RUN_ID: runId,
      E2E_SHARD: `${shard}`,
      E2E_PERSIST_DIR: dirFor("persist", shard),
      E2E_OUTPUT_DIR: dirFor("out", shard),
      E2E_BLOB_DIR: dirFor("blob", shard),
      E2E_BLOB_FILE: `report-shard${shard}.zip`,
      ...(smoke ? { E2E_SMOKE: "1" } : {}),
      ...(failTest ? { E2E_FAIL_TEST: "1" } : {}),
      ...(process.env.E2E_FAIL_TEST ? { E2E_FAIL_TEST: process.env.E2E_FAIL_TEST } : {}),
      ...(process.env.E2E_MISSING_BLOB ? { E2E_MISSING_BLOB: process.env.E2E_MISSING_BLOB } : {}),
      ...(process.env.E2E_SUPPRESS_BLOB ? { E2E_SUPPRESS_BLOB: process.env.E2E_SUPPRESS_BLOB } : {}),
      ...(process.env.E2E_SMOKE_GREP ? { E2E_SMOKE_GREP: process.env.E2E_SMOKE_GREP } : {}),
      ...(process.env.E2E_SIMULATE_INFRA_EXIT ? { E2E_SIMULATE_INFRA_EXIT: process.env.E2E_SIMULATE_INFRA_EXIT } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  for (const [stream, label] of [[child.stdout, "out"], [child.stderr, "err"]]) {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => console.log(`[shard ${shard}]${label === "err" ? " (err)" : ""} ${line}`));
  }
  return child;
}

const exitOf = (child) => new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1)));

async function gatherBlobs() {
  const mergeDir = path.join(runRoot, "merge");
  await mkdir(mergeDir, { recursive: true });
  let count = 0;
  const missingBlobs = [];
  for (const shard of [1, 2]) {
    const expectedName = `report-shard${shard}.zip`;
    const dir = dirFor("blob", shard);
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      files = [];
    }
    const zips = files.filter((f) => f.endsWith(".zip"));
    if (zips.includes(expectedName) && zips.length === 1) {
      await rename(path.join(dir, expectedName), path.join(mergeDir, `${shard}-${expectedName}`));
      count += 1;
    } else {
      missingBlobs.push({ shard, expected: expectedName, found: zips });
    }
  }
  return { mergeDir, count, missingBlobs };
}

async function merge(mergeDir, count) {
  if (count === 0) {
    log("no blob reports produced — skipping merge");
    return false;
  }
  log(`merging ${count} blob report(s) from ${mergeDir}`);
  const mergeChild = spawnSync(playwright, ["merge-reports", mergeDir, "--reporter", "list,html"], {
    cwd: appsWeb,
    env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
    stdio: "inherit",
  });
  return mergeChild.status === 0;
}

(async () => {
  const children = { 1: runShard(1), 2: runShard(2) };
  liveChildren.set("1", children[1]);
  liveChildren.set("2", children[2]);
  const codes = { 1: null, 2: null };
  const finished = new Set();
  log(`run ${runId} · shard 1 and shard 2 concurrently${smoke ? " · smoke (bounded selection)" : ""}`);
  log(`ports: shard 1 (${JSON.stringify(SHARD_PORTS[1])}), shard 2 (${JSON.stringify(SHARD_PORTS[2])})`);

  const waitBoth = Promise.all(
    Object.entries(children).map(async ([shard, child]) => {
      const code = await exitOf(child);
      codes[shard] = code;
      finished.add(shard);
      // Only an unrecoverable stack/startup failure (run-shards infra exit 2,
      // e.g. migration, port bind, or readiness timeout) is worth aborting the
      // sibling for. Ordinary test failures (exit 1) must let the sibling
      // finish so both blob reports merge into one honest combined report.
      if (code === 2) {
        const other = shard === "1" ? "2" : "1";
        if (children[other] && !finished.has(other)) {
          log(`shard ${shard} had an infrastructure failure (exit ${code}) — stopping shard ${other}`);
          await stopChild(children[other], 5000);
        }
      }
      return code;
    }),
  );

  await waitBoth;
  // Unconditionally reap each shard wrapper's process group after exit
  await reapAllGroups();
  if (stopping) return;
  const [code1, code2] = [codes[1], codes[2]];

  const { mergeDir, count, missingBlobs } = await gatherBlobs();
  const hasAllBlobs = count === 2 && missingBlobs.length === 0;
  if (!hasAllBlobs) {
    log(`blob validation failed: expected 2 shard blobs, gathered ${count}. Details: ${JSON.stringify(missingBlobs)}`);
  }

  const mergeOk = count > 0 ? await merge(mergeDir, count) : false;

  const ok = code1 === 0 && code2 === 0 && hasAllBlobs && mergeOk;

  if (ok) {
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    log(`removed temporary run state ${runRoot}`);
    log(`merged HTML report: ${path.join(appsWeb, "playwright-report", "index.html")}`);
    log(`COMBINED: PASS`);
    await releaseE2eLock(runLock);
    process.exit(0);
  } else {
    await retainFailureState(`shards ${code1}/${code2}, blobs ${count}/2, merge ${mergeOk ? "ok" : "failed"}`);
    log(`COMBINED: FAIL (shards ${code1}/${code2}, blobs ${count}/2, merge ${mergeOk ? "ok" : "failed"})`);
    await releaseE2eLock(runLock);
    process.exit(1);
  }
})();
