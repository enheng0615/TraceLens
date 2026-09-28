import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runCsvTraceRcaWorkflow,
  runSingleSessionTraceRcaWorkflow,
} from "../../src/workflows/trace-rca/workflow.mjs";

function dependencies(calls, { mismatch = false } = {}) {
  return {
    collector: {},
    ensureTrace: async ({ sessionId }) => {
      calls.ensureTrace.push(sessionId);
      return { traceRoot: `/trace/${sessionId}`, source: "cache" };
    },
    extractExchange: async (_root, { expectedQuery, expectedAnswer }) => ({
      query: mismatch ? `${expectedQuery ?? "trace-query"}-different` : (expectedQuery ?? "trace-query"),
      idaAnswer: expectedAnswer,
      spanId: "agent-span",
    }),
    runRca: async ({ casePath, traceRoot }) => {
      const data = JSON.parse(await readFile(casePath, "utf8"));
      calls.cases.push(data);
      return { outputDir: `/rca/${data.caseId}`, traceRoot };
    },
  };
}

function grading() {
  return {
    conclusion: { 结论: { 缺失项: { inReportMissedRecall: [
      { 未命中GT: "2. Missing B", 未命中项编号: 1, 缺失说明: "B absent" },
      { 未命中GT: "3. Missing C", 未命中项编号: 2, 缺失说明: "C absent" },
    ] } } },
  };
}

test("CSV workflow reuses one Trace and fans a row out into per-GT RCA cases", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-workflow-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    traceOutputRoot: "/trace-cache",
    csvReader: async () => ({ records: [{
      rowNumber: 2,
      sessionId: "100",
      query: "query",
      groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }),
      score: "0.33",
      machineGrading: grading(),
      idaAnswer: "answer",
    }] }),
    dependencies: dependencies(calls),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.counts.completed, 2);
  assert.equal(result.counts.plannedCriteria, 2);
  assert.deepEqual(calls.ensureTrace, ["100"]);
  assert.deepEqual(calls.cases.map((item) => item.officialMissedCriteria[0].id), ["报告GT2", "报告GT3"]);
  assert.ok(calls.cases.every((item) => item.query === "query" && item.idaAnswer === "answer"));
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.items.length, 2);
});

test("CSV workflow skips exact full-score rows before Trace collection and RCA", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-full-score-skip-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "100", query: "full", score: "1.00", machineGrading: '{"未命中GT":"must not run"}', idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "partial", score: "0.5", machineGrading: '{"未命中GT":"run this"}', idaAnswer: "a2" },
      { rowNumber: 4, sessionId: "300", query: "invalid", score: "2", machineGrading: '{"未命中GT":"still run"}', idaAnswer: "a3" },
    ] }),
    dependencies: dependencies(calls),
  });
  assert.deepEqual([...calls.ensureTrace].sort(), ["200", "300"]);
  assert.equal(calls.ensureTrace.includes("100"), false);
  assert.deepEqual(calls.cases.map((item) => item.sessionId).sort(), ["200", "300"]);
  assert.equal(result.items[0].status, "skipped");
  assert.equal(result.items[0].stage, "score_filter");
  assert.equal(result.items[0].reason, "full_score");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.configuration.skipFullScore, true);
  assert.equal(manifest.configuration.fullScoreRule, "strict_numeric_score_equals_1");
});

test("workflow blocks mismatched business inputs before RCA", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-mismatch-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [{
      rowNumber: 2, sessionId: "100", query: "query", groundTruth: "[]", score: "0",
      machineGrading: grading(), idaAnswer: "answer",
    }] }),
    dependencies: dependencies(calls, { mismatch: true }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.items[0].error.code, "CASE_TRACE_MISMATCH");
  assert.equal(calls.cases.length, 0);
});

test("single-session workflow requires three inputs and derives Query/GT for one RCA case", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-single-"));
  await assert.rejects(
    runSingleSessionTraceRcaWorkflow({ sessionId: "1", machineGrading: "m" }),
    /idaAnswer is required/,
  );
  const result = await runSingleSessionTraceRcaWorkflow({
    sessionId: "1",
    machineGrading: '{"未命中GT":"g"}',
    idaAnswer: "a",
    workflowOutputRoot: output,
    dependencies: dependencies(calls),
  });
  assert.equal(result.counts.completed, 1);
  assert.equal(calls.cases[0].officialMissedCriteria[0].text, "g");
  assert.equal(calls.cases[0].machineGrading, '{"未命中GT":"g"}');
  assert.equal(calls.cases[0].query, "trace-query");
});

test("explicitly truncated input answer is replaced by complete Trace output after exact Query match", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-truncated-"));
  const deps = dependencies(calls);
  deps.extractExchange = async () => ({ query: "q", idaAnswer: "complete trace answer", spanId: "agent-span" });
  const result = await runSingleSessionTraceRcaWorkflow({
    sessionId: "1",
    query: "q",
    machineGrading: '{"未命中GT":"g"}',
    idaAnswer: "partial answer\n[内容过长，飞书单元格最多支持约50000 bytes，已截断；原始长度 123352 bytes。]",
    workflowOutputRoot: output,
    dependencies: deps,
  });
  assert.equal(result.counts.completed, 1);
  assert.equal(calls.cases[0].idaAnswer, "complete trace answer");
  assert.equal(calls.cases[0].inputProvenance.answerResolution, "explicitly_truncated_input_replaced_with_trace_output");
});

test("workflow records RCA failure output and failure summary paths in its manifest", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-failure-paths-"));
  const deps = dependencies(calls);
  deps.runRca = async () => {
    const error = new Error("Investigation coverage incomplete: fact group");
    error.rcaOutputDir = "/rca/run-failed";
    error.failureSummaryPath = "/rca/run-failed/failure-summary.md";
    throw error;
  };

  const result = await runSingleSessionTraceRcaWorkflow({
    sessionId: "1",
    machineGrading: '{"未命中GT":"g"}',
    idaAnswer: "a",
    workflowOutputRoot: output,
    dependencies: deps,
  });
  assert.equal(result.status, "failed");

  const [workflowDir] = await (await import("node:fs/promises")).readdir(output);
  const manifest = JSON.parse(await readFile(path.join(output, workflowDir, "workflow-manifest.json"), "utf8"));
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.items[0].rcaOutputDir, "/rca/run-failed");
  assert.equal(manifest.items[0].failureSummaryPath, "/rca/run-failed/failure-summary.md");
});

test("failed-only retry filters exact CSV rows and GT criteria and records lineage", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-retry-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "100", query: "q1", groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }), score: "0", machineGrading: grading(), idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "q2", groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }), score: "0", machineGrading: grading(), idaAnswer: "a2" },
    ] }),
    retrySelection: [{ rowNumber: 3, sessionId: "200", criterionId: "报告GT3" }],
    lineage: { rootJobId: "job-root", parentJobId: "job-parent", attempt: 2, scope: "failed_only" },
    dependencies: dependencies(calls),
  });
  assert.deepEqual(calls.ensureTrace, ["200"]);
  assert.deepEqual(calls.cases.map((item) => [item.sessionId, item.officialMissedCriteria[0].id]), [["200", "报告GT3"]]);
  assert.equal(result.counts.plannedCriteria, 1);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.lineage.attempt, 2);
  assert.equal(manifest.retrySelection[0].criterionId, "报告GT3");
});

test("preparation-stage retry without criterion reruns the whole selected row", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-retry-row-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "100", query: "q1", groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }), score: "0", machineGrading: grading(), idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "q2", groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }), score: "0", machineGrading: grading(), idaAnswer: "a2" },
    ] }),
    retrySelection: [{ rowNumber: 2, sessionId: "100", failureStage: "preparation" }],
    dependencies: dependencies(calls),
  });
  assert.equal(result.counts.completed, 2);
  assert.deepEqual(calls.cases.map((item) => item.officialMissedCriteria[0].id), ["报告GT2", "报告GT3"]);
});

test("failed-only retry fails closed when a selected criterion no longer matches grading", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-retry-mismatch-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [{
      rowNumber: 2, sessionId: "100", query: "q", groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit A", "2. Missing B", "3. Missing C"] } }), score: "0", machineGrading: grading(), idaAnswer: "a",
    }] }),
    retrySelection: [{ rowNumber: 2, sessionId: "100", criterionId: "报告GT99" }],
    dependencies: dependencies(calls),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.items[0].error.code, "RETRY_SELECTION_MISMATCH");
  assert.equal(calls.cases.length, 0);
});

test("CSV workflow runs different Sessions in a bounded pool and serializes the same Session", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-parallel-"));
  let active = 0;
  let maxActive = 0;
  const perSession = new Map();
  const maxPerSession = new Map();
  const deps = dependencies(calls);
  deps.runRca = async ({ casePath }) => {
    const data = JSON.parse(await readFile(casePath, "utf8"));
    const sessionId = String(data.sessionId);
    calls.cases.push(data);
    active += 1;
    maxActive = Math.max(maxActive, active);
    perSession.set(sessionId, (perSession.get(sessionId) || 0) + 1);
    maxPerSession.set(sessionId, Math.max(maxPerSession.get(sessionId) || 0, perSession.get(sessionId)));
    await new Promise((resolve) => setTimeout(resolve, 25));
    perSession.set(sessionId, perSession.get(sessionId) - 1);
    active -= 1;
    return { outputDir: `/rca/${data.caseId}` };
  };
  const records = [
    { rowNumber: 2, sessionId: "100", query: "q1", machineGrading: '{"未命中GT":"g1"}', idaAnswer: "a1" },
    { rowNumber: 3, sessionId: "100", query: "q2", machineGrading: '{"未命中GT":"g2"}', idaAnswer: "a2" },
    { rowNumber: 4, sessionId: "200", query: "q3", machineGrading: '{"未命中GT":"g3"}', idaAnswer: "a3" },
    { rowNumber: 5, sessionId: "300", query: "q4", machineGrading: '{"未命中GT":"g4"}', idaAnswer: "a4" },
  ];
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    concurrency: 2,
    csvReader: async () => ({ records }),
    dependencies: deps,
  });
  assert.equal(result.status, "completed");
  assert.equal(maxActive, 2);
  assert.equal(maxPerSession.get("100"), 1);
  assert.equal(calls.ensureTrace.filter((id) => id === "100").length, 1);
  assert.deepEqual(result.items.map((item) => item.rowNumber), [2, 3, 4, 5]);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.configuration.concurrency, 2);
  assert.equal(manifest.configuration.schedulingUnit, "session");
  assert.equal(manifest.configuration.sequential, false);
});

test("CSV workflow rejects fail-fast with parallel workers", async () => {
  await assert.rejects(
    runCsvTraceRcaWorkflow({
      csvPath: "/safe/input.csv",
      concurrency: 2,
      continueOnError: false,
      csvReader: async () => ({ records: [] }),
    }),
    /fail-fast requires concurrency=1/,
  );
});

test("parallel CSV failures are isolated and successful Sessions still finish", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-parallel-failure-"));
  const deps = dependencies(calls);
  deps.runRca = async ({ casePath }) => {
    const data = JSON.parse(await readFile(casePath, "utf8"));
    calls.cases.push(data);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (data.sessionId === "200") throw new Error("isolated failure");
    return { outputDir: `/rca/${data.caseId}` };
  };
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    concurrency: 2,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "100", query: "q1", machineGrading: '{"未命中GT":"g1"}', idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "q2", machineGrading: '{"未命中GT":"g2"}', idaAnswer: "a2" },
      { rowNumber: 4, sessionId: "300", query: "q3", machineGrading: '{"未命中GT":"g3"}', idaAnswer: "a3" },
    ] }),
    dependencies: deps,
  });
  assert.equal(result.status, "completed_with_failures");
  assert.equal(result.counts.completed, 2);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(result.items.map((item) => [item.sessionId, item.status]), [["100", "completed"], ["200", "failed"], ["300", "completed"]]);
});

test("concurrency one preserves original CSV row order", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-serial-order-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    concurrency: 1,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "100", query: "q1", machineGrading: '{"未命中GT":"g1"}', idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "q2", machineGrading: '{"未命中GT":"g2"}', idaAnswer: "a2" },
      { rowNumber: 4, sessionId: "100", query: "q3", machineGrading: '{"未命中GT":"g3"}', idaAnswer: "a3" },
    ] }),
    dependencies: dependencies(calls),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.cases.map((item) => item.inputProvenance.csvRow), [2, 3, 4]);
  assert.deepEqual(result.items.map((item) => item.rowNumber), [2, 3, 4]);
});

test("CSV workflow isolates a missing Session ID and continues valid rows", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-input-isolation-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    concurrency: 2,
    csvReader: async () => ({ records: [
      { rowNumber: 2, sessionId: "", query: "full", score: "1", machineGrading: '{"未命中GT":"skip"}', idaAnswer: "a1" },
      { rowNumber: 3, sessionId: "200", query: "valid", score: "0.5", machineGrading: '{"未命中GT":"run"}', idaAnswer: "a2" },
      {
        rowNumber: 4, sessionId: "", query: "invalid", score: "", machineGrading: '{"未命中GT":"cannot run"}', idaAnswer: "a3",
        inputError: { code: "SESSION_ID_MISSING", field: "ida_url", rowNumber: 4, message: "CSV第4行的ida_url为空，无法进行Trace归因", remediation: "修复源CSV第4行" },
      },
    ] }),
    dependencies: dependencies(calls),
  });
  assert.equal(result.status, "completed_with_failures");
  assert.deepEqual(calls.ensureTrace, ["200"]);
  assert.equal(result.counts.completed, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.fullScoreSkipped, 1);
  assert.deepEqual(result.items.map((item) => [item.rowNumber, item.status, item.stage || item.reason]), [
    [2, "skipped", "score_filter"],
    [3, "completed", undefined],
    [4, "failed", "input_validation"],
  ]);
  assert.equal(result.items[2].error.code, "SESSION_ID_MISSING");
  assert.match(result.items[2].error.remediation, /第4行/);
});


test("workflow stores reports by batch time, Session, then GT", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-storage-v2-"));
  const deps = dependencies(calls);
  deps.runRca = async ({ casePath, outputDir }) => {
    const data = JSON.parse(await readFile(casePath, "utf8"));
    calls.cases.push(data);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "rca-report.md"), "# report\n", "utf8");
    await writeFile(path.join(outputDir, "agent-run.md"), "# log\n", "utf8");
    return { outputDir };
  };
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [{
      rowNumber: 2,
      sessionId: "100",
      query: "query",
      groundTruth: JSON.stringify({ 结论: { groundTruth: ["1. Hit", "2. Missing"] } }),
      score: "0.5",
      machineGrading: { conclusion: { 结论: { 缺失项: { inReportMissedRecall: [{ 未命中GT: "2. Missing", 未命中项编号: 1 }] } } } },
      idaAnswer: "answer",
    }] }),
    dependencies: deps,
  });
  assert.match(path.basename(result.outputDir), /^batch-/);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.storageLayout.version, 2);
  assert.equal(manifest.storageLayout.hierarchy, "batch/session/gt");
  const [item] = manifest.items;
  assert.match(item.casePath, /sessions[/\\]session-100[/\\]gt[/\\]报告GT2-[a-f0-9]{10}[/\\]case\.json$/);
  assert.equal(item.rcaOutputDir, path.dirname(item.casePath));
  const sessionSummary = JSON.parse(await readFile(path.join(result.outputDir, "sessions", "session-100", "session-summary.json"), "utf8"));
  assert.equal(sessionSummary.sessionId, "100");
  assert.equal(sessionSummary.items[0].criterionId, "报告GT2");
  assert.equal(await readFile(path.join(item.rcaOutputDir, "rca-report.md"), "utf8"), "# report\n");
});

test("CSV workflow records upstream source failures without counting them as RCA failures", async () => {
  const calls = { ensureTrace: [], cases: [] };
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-rca-source-run-failed-"));
  const result = await runCsvTraceRcaWorkflow({
    csvPath: "/safe/input.csv",
    workflowOutputRoot: output,
    csvReader: async () => ({ records: [{
      rowNumber: 2,
      sessionId: "",
      score: "",
      machineGrading: "{}",
      idaAnswer: "failed",
      sourceRunStatus: {
        code: "SOURCE_RUN_FAILED",
        status: "source_run_failed",
        label: "源任务未成功运行",
        detail: "Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}",
        conditions: { sessionIdEmpty: true, scoreEmpty: true, idaAnswerEmptyOrFailed: true, machineGradingEmptyOrEmptyObject: true },
      },
    }] }),
    dependencies: dependencies(calls),
  });
  assert.equal(result.status, "completed_no_action");
  assert.equal(result.counts.failed, 0);
  assert.equal(result.counts.sourceRunFailed, 1);
  assert.deepEqual(calls.ensureTrace, []);
  assert.equal(result.items[0].status, "source_run_failed");
  assert.equal(result.items[0].detail, "Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}");
});
