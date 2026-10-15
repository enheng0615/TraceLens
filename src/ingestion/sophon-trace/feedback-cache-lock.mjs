import { randomUUID } from "node:crypto";
import { link, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";

const POLL_MS = 200;
// An owner writes its metadata immediately after O_EXCL creates the file.
// Allow that short interval before treating an empty legacy/crashed file as stale.
const OWNER_WRITE_GRACE_MS = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function readOwner(filePath) {
  let info;
  let raw;
  try {
    info = await stat(filePath);
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  let owner;
  try { owner = JSON.parse(raw); } catch { /* An empty legacy lock has no owner. */ }
  if (owner?.host && owner.host !== os.hostname()) return { state: "active", token: owner.token ?? null };
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || typeof owner?.token !== "string") {
    return Date.now() - info.mtimeMs >= OWNER_WRITE_GRACE_MS
      ? { state: "stale", token: null }
      : { state: "initializing" };
  }
  return { state: isProcessAlive(owner.pid) ? "active" : "stale", token: owner.token };
}

async function createOwnedFile(filePath, owner) {
  const tempPath = `${filePath}.${owner.token}.tmp`;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`); }
    finally { await handle.close(); }
    await link(tempPath, filePath);
  } finally { await rm(tempPath, { force: true }); }
}

async function reclaimStaleLock(lockPath, observedToken) {
  const guardPath = `${lockPath}.reclaim`;
  const guardOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  try {
    await createOwnedFile(guardPath, guardOwner);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const guard = await readOwner(guardPath);
    if (guard.state === "stale") await rm(guardPath, { force: true });
    return false;
  }
  try {
    const current = await readOwner(lockPath);
    if (current.state !== "stale" || current.token !== observedToken) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    const guard = await readOwner(guardPath);
    if (guard.token === guardOwner.token) await rm(guardPath, { force: true });
  }
}

/** Wait for live collectors, and recover locks left by an exited process. */
export async function acquireFeedbackCacheLock(lockPath, { logger = console } = {}) {
  const owner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  let waiting = false;
  for (;;) {
    try {
      await createOwnedFile(lockPath, owner);
      return async () => {
        const current = await readOwner(lockPath);
        if (current.token === owner.token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const current = await readOwner(lockPath);
    if (current.state === "stale") {
      if (await reclaimStaleLock(lockPath, current.token)) {
        logger.warn?.(`回收已退出采集进程留下的 Trace 缓存锁: ${lockPath}`);
      }
    } else if (current.state === "active" && !waiting) {
      logger.info?.(`等待其他采集进程完成 Trace 缓存: ${lockPath}`);
      waiting = true;
    }
    await sleep(POLL_MS);
  }
}
