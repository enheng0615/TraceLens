import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireFeedbackCacheLock } from "../../src/ingestion/sophon-trace/feedback-cache-lock.mjs";

const logger = { info() {}, warn() {} };

test("a second collector waits for the live owner and then acquires the cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feedback-cache-live-"));
  const lockPath = path.join(directory, ".collection.lock");
  try {
    const releaseFirst = await acquireFeedbackCacheLock(lockPath, { logger });
    let acquired = false;
    const second = acquireFeedbackCacheLock(lockPath, { logger }).then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(acquired, false);
    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(acquired, true);
    await releaseSecond();
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a cancelled collector's lock is recovered without deleting cached data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feedback-cache-cancel-"));
  const lockPath = path.join(directory, ".collection.lock");
  const dataPath = path.join(directory, "existing-tree.json");
  const moduleUrl = pathToFileURL(path.resolve("src/ingestion/sophon-trace/feedback-cache-lock.mjs")).href;
  const script = `const { acquireFeedbackCacheLock } = await import(process.argv[1]); await acquireFeedbackCacheLock(process.argv[2]); process.stdout.write("LOCKED\\n"); setInterval(() => {}, 1000);`;
  let child;
  try {
    await writeFile(dataPath, "{\"data\":true}\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => chunk.toString().includes("LOCKED") ? resolve() : reject(new Error("child did not acquire lock")));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("child exited before acquiring lock")));
    });
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(owner.pid, child.pid);
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    const release = await acquireFeedbackCacheLock(lockPath, { logger });
    assert.equal(JSON.parse(await readFile(dataPath, "utf8")).data, true);
    await release();
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an old empty lock after its owner-write grace interval", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feedback-cache-legacy-"));
  const lockPath = path.join(directory, ".collection.lock");
  try {
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const release = await acquireFeedbackCacheLock(lockPath, { logger });
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("contenders reclaim one dead owner's lock without overlapping collection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feedback-cache-reclaim-race-"));
  const lockPath = path.join(directory, ".collection.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, host: os.hostname(), token: "dead-owner" }));
    let active = 0;
    let maximumActive = 0;
    const collect = async () => {
      const release = await acquireFeedbackCacheLock(lockPath, { logger });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      await release();
    };
    await Promise.all([collect(), collect(), collect()]);
    assert.equal(maximumActive, 1);
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
