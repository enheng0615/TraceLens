import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRcaCase } from "../../src/rca/orchestrator.mjs";

test("persists failure diagnostics even when initialization fails before scoring gap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-init-failure-"));
  const casePath = path.join(root, "case.json");
  const outputRoot = path.join(root, "runs");
  await (await import("node:fs/promises")).writeFile(casePath, JSON.stringify({
    caseId: "case-init-failure",
    sessionId: "1",
    query: "q",
    machineGrading: "missed",
    idaAnswer: "answer",
    officialMissedCriteria: [{ id: "gt-1", text: "missing fact", officialVerdict: "missed" }],
  }));

  let failure;
  try {
    await runRcaCase({
      casePath,
      traceRoot: path.join(root, "missing-trace"),
      outputRoot,
      mode: "offline",
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.match(failure.message, /ENOENT|manifest|Trace/i);
  assert.ok(failure.rcaOutputDir);
  assert.ok(failure.failureSummaryPath);
  const files = await readdir(failure.rcaOutputDir);
  assert.ok(files.includes("failure-summary.md"));
  assert.ok(files.includes("evidence-ledger.partial.json"));
  assert.ok(files.includes("validation.partial.json"));
  const summary = await readFile(failure.failureSummaryPath, "utf8");
  assert.match(summary, /Trace RCA 失败摘要/);
  assert.match(summary, /Checkpoint：尚未生成/);
  assert.match(summary, /不能使用--resume/);
  assert.equal(summary.includes("  --resume "), false);
});
