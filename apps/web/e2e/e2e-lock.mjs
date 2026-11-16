import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import net from "node:net";

export const DEFAULT_LOCK_DIR = path.join(os.tmpdir(), "foxban-e2e.lock");
export const SHARD_DEFAULT_PORTS = {
  1: { api: 8787, vite: 5173, github: 8788, inspector: 9233 },
  2: { api: 8790, vite: 5174, github: 8791, inspector: 9234 },
};

export function getLockPath() {
  return process.env.E2E_LOCK_DIR ?? process.env.E2E_LOCK_FILE ?? DEFAULT_LOCK_DIR;
}

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH means process doesn't exist. EPERM means exists but belongs to another user (alive).
    return err.code === "EPERM";
  }
}

/**
 * Atomically acquires the shared E2E run lock directory.
 *
 * Acquisition uses mkdir(lockDir) so directory creation is atomic without any
 * create-before-payload race window. Once mkdir succeeds, the owner writes its
 * metadata (pid, owner, runId, token, time) into `owner.json` inside the directory.
 *
 * If the directory already exists (EEXIST), acquisition fails closed immediately.
 * Automatic stale-lock reclamation is completely disabled to eliminate dual-owner
 * race conditions. Contenders never rename, unlink, or overwrite existing lock
 * directories they do not own. If the lock directory belongs to a dead process or
 * contains incomplete/corrupt metadata, it must be inspected and safely removed
 * manually by the operator after confirming no E2E test process is running:
 *   rm -rf "<lockDir>"
 */
export async function acquireE2eLock({
  lockDir = getLockPath(),
  owner = `pid-${process.pid}`,
  runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  onLog = (msg) => console.log(`[e2e-lock] ${msg}`),
} = {}) {
  const token = randomUUID();
  const meta = { pid: process.pid, owner, runId, token, time: Date.now() };
  const metaFile = path.join(lockDir, "owner.json");

  async function tryClaimNew() {
    try {
      await mkdir(lockDir);
    } catch (err) {
      if (err.code === "EEXIST") return null;
      throw err;
    }
    try {
      await writeFile(metaFile, JSON.stringify(meta, null, 2), { encoding: "utf8" });
    } catch (writeErr) {
      // If writing metadata failed immediately after mkdir, clean up our own directory
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      throw writeErr;
    }
    return { lockDir, owner, runId, token, pid: process.pid };
  }

  // 1. Try direct atomic creation
  const initialClaim = await tryClaimNew();
  if (initialClaim) return initialClaim;

  // 2. Directory exists (EEXIST). Read existing owner metadata if possible to provide diagnostic info.
  let holder = null;
  try {
    const raw = await readFile(metaFile, { encoding: "utf8" });
    holder = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Another E2E run is currently active or lock directory exists with unreadable/incomplete metadata at ${lockDir} (${err.message}).\n` +
      `Automatic reclamation is disabled for safety. If no E2E process is running, manually remove the lock directory:\n` +
      `  rm -rf "${lockDir}"`
    );
  }

  const holderPid = typeof holder?.pid === "number" ? holder.pid : undefined;
  const holderOwner = holder?.owner ?? "unknown";
  const holderRunId = holder?.runId ?? "unknown";
  const alive = holderPid !== undefined ? isProcessAlive(holderPid) : false;
  const statusStr = alive ? "active" : "dead/stale";

  throw new Error(
    `Another E2E run is currently holding the lock at ${lockDir} (holder PID: ${holderPid ?? "unknown"} [${statusStr}], owner: ${holderOwner}, runId: ${holderRunId}).\n` +
    `Automatic stale reclamation is disabled to prevent contender races. If no E2E process is running, verify with 'ps -p ${holderPid ?? "<pid>"}' and safely clean up the lock:\n` +
    `  rm -rf "${lockDir}"`
  );
}

/**
 * Releases the E2E lock directory only after verifying the ownership token.
 * Prevents unlinking or removing another process's lock.
 */
export async function releaseE2eLock(lock) {
  if (!lock || !lock.lockDir || !lock.token) return;
  const metaFile = path.join(lock.lockDir, "owner.json");

  try {
    const raw = await readFile(metaFile, { encoding: "utf8" });
    const currentMeta = JSON.parse(raw);
    if (currentMeta?.token !== lock.token) {
      console.warn(
        `[e2e-lock] Refusing to release lock at ${lock.lockDir}: ownership token mismatch (expected ${lock.token}, found ${currentMeta?.token})`
      );
      return;
    }
  } catch (err) {
    console.warn(`[e2e-lock] Could not verify lock token at ${lock.lockDir}: ${err.message}`);
    return;
  }

  // Token verified: remove lock directory safely
  await rm(lock.lockDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Checks whether a single TCP port is free on 127.0.0.1.
 */
export async function checkPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

/**
 * Validates that all ports in a given map/array are free on 127.0.0.1.
 * Throws immediately with an informative error if any port is occupied.
 */
export async function assertPortsFree(ports) {
  const entries = Array.isArray(ports)
    ? ports.map((p) => [String(p), p])
    : Object.entries(ports);

  for (const [name, port] of entries) {
    const isFree = await checkPortFree(port);
    if (!isFree) {
      throw new Error(`Port ${port} (${name}) is already occupied on 127.0.0.1`);
    }
  }
}

/**
 * Reaps an entire process group unconditionally and awaits ESRCH.
 * Even if the leader process has already exited normally, any background/orphaned
 * descendants sharing that PGID are terminated.
 */
export async function reapProcessGroup(pgid, { termTimeoutMs = 1000, killTimeoutMs = 2000 } = {}) {
  if (!pgid || typeof pgid !== "number" || pgid <= 0) return;

  const isGroupAlive = () => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM"; // EPERM means process group still exists
    }
  };

  if (!isGroupAlive()) return;

  // 1. SIGTERM whole process group
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {}

  // Bounded check for exit after SIGTERM
  const termDeadline = Date.now() + termTimeoutMs;
  while (Date.now() < termDeadline) {
    if (!isGroupAlive()) return;
    await new Promise((r) => setTimeout(r, 50));
  }

  // 2. SIGKILL whole process group
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}

  // Bounded check to confirm ESRCH after SIGKILL
  const killDeadline = Date.now() + killTimeoutMs;
  while (Date.now() < killDeadline) {
    if (!isGroupAlive()) return;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (isGroupAlive()) {
    console.warn(`[reapProcessGroup] Warning: Process group ${pgid} still alive after SIGKILL`);
  }
}
