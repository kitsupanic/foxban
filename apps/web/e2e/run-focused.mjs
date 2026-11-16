#!/usr/bin/env node
// Wrapper for supported focused non-sharded Playwright package scripts.
//
// Ensures:
// 1. Exclusive shared E2E lock is acquired BEFORE Playwright or its webServer starts.
// 2. All target ports on 127.0.0.1 (API 8787, Vite 5173, GitHub stub 8788) are free.
//    If any port is occupied, fails fast immediately without spawning Playwright,
//    without running migrations, and without reusing foreign servers.
// 3. Spawns Playwright with all arguments preserved.
// 4. Propagates signals (SIGINT, SIGTERM) to Playwright child process.
// 5. Cleans up lock after Playwright completes and webServer is torn down.
// 6. Exits with Playwright's exact exit code.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acquireE2eLock,
  releaseE2eLock,
  assertPortsFree,
} from "./e2e-lock.mjs";

const e2eDir = path.dirname(fileURLToPath(import.meta.url)); // apps/web/e2e
const appsWeb = path.resolve(e2eDir, "..");
const ext = process.platform === "win32" ? ".cmd" : "";
const playwrightBin = path.join(appsWeb, "node_modules", ".bin", `playwright${ext}`);

const apiPort = Number(process.env.API_PORT ?? 8787);
const vitePort = Number(process.env.VITE_PORT ?? 5173);
const githubPort = Number(process.env.GITHUB_STUB_PORT ?? 8788);

const rawArgs = process.argv.slice(2);
// In package scripts, arguments may begin with "test" or options directly.
// If first arg is not "test", prepend "test" so playwright CLI behaves consistently.
const playwrightArgs = rawArgs[0] === "test" ? rawArgs : ["test", ...rawArgs];

let lock = null;

async function cleanup() {
  if (lock) {
    const l = lock;
    lock = null;
    await releaseE2eLock(l);
  }
}

// 1. Acquire the atomic exclusive E2E lock directory
try {
  lock = await acquireE2eLock({
    owner: `focused-playwright-${process.pid}`,
    onLog: (msg) => console.log(`[e2e-focused] ${msg}`),
  });
} catch (err) {
  console.error(`[e2e-focused] ${err.message}`);
  process.exit(2);
}

// 2. Assert ports are free before Playwright can start webServer or run migrations
try {
  await assertPortsFree({
    api: apiPort,
    vite: vitePort,
    github: githubPort,
  });
} catch (err) {
  console.error(`[e2e-focused] ${err.message}`);
  await cleanup();
  process.exit(2);
}

// 3. Spawn Playwright directly with inherited stdio
let child = null;

const handleSignal = (sig) => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(sig);
    } catch {}
  }
};

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

const exitCode = await new Promise((resolve) => {
  child = spawn(playwrightBin, playwrightArgs, {
    cwd: appsWeb,
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    console.error(`[e2e-focused] Failed to spawn Playwright: ${err.message}`);
    resolve(1);
  });

  child.on("close", (code, signal) => {
    if (signal) {
      const sigNum = os.constants.signals[signal];
      resolve(typeof sigNum === "number" ? 128 + sigNum : 143);
    } else {
      resolve(code ?? 0);
    }
  });
});

// 4. Release lock after child has closed (which includes webServer teardown)
await cleanup();
process.exit(exitCode);
