import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebJobStore } from "../../src/web/job-store.mjs";

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-web-store-"));
  return new WebJobStore({ projectRoot: root, outputRoot: path.join(root, "web"), traceOutputRoot: path.join(root, "trace") }).initialize();
}

test("validates session form before spawning a workflow", async () => {
  const jobs = await store();
  await assert.rejects(jobs.createSession({ sessionId: "abc", machineGrading: "m", idaAnswer: "a" }), /纯数字/);
  await assert.rejects(jobs.createSession({ sessionId: "1", machineGrading: "", idaAnswer: "a" }), /机评结果/);
  await assert.rejects(jobs.createSession({ sessionId: "1", machineGrading: "m", idaAnswer: "" }), /IDA答案/);
  await assert.rejects(jobs.createSession({ sessionId: "1", machineGrading: "m", idaAnswer: "a", maxRounds: 201 }), /1到200/);
  assert.equal(jobs.list().length, 0);
});

test("CSV jobs validate and persist bounded Session concurrency", async () => {
  const jobs = await store();
  jobs.start = () => {};
  await assert.rejects(jobs.createCsv({ csvText: "a\n1", concurrency: 17 }), /1到16/);
  await assert.rejects(jobs.createCsv({ csvText: "a\n1", concurrency: 3, failFast: true }), /并发数为1/);
  const job = await jobs.createCsv({ fileName: "batch.csv", csvText: "a\n1", concurrency: 4 });
  assert.equal(job.inputSummary.concurrency, 4);
  const stored = jobs.jobs.get(job.id);
  assert.deepEqual(stored.commandArgs.slice(stored.commandArgs.indexOf("--concurrency"), stored.commandArgs.indexOf("--concurrency") + 2), ["--concurrency", "4"]);
  const failFast = await jobs.createCsv({ fileName: "serial.csv", csvText: "a\n1", failFast: true });
  assert.equal(failFast.inputSummary.concurrency, 1);
});

test("artifact reads are constrained to the job directory and text formats", async () => {
  const jobs = await store();
  const id = "job-fixture";
  const directory = jobs.jobDirectory(id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "report.md"), "# report", "utf8");
  const job = { id, type: "session", status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), jobDir: directory, inputSummary: {}, progress: {} };
  jobs.jobs.set(id, job);
  assert.equal((await jobs.artifact(id, "report.md")).content, "# report");
  await assert.rejects(jobs.artifact(id, "../secret.md"), /非法产物路径/);
  await assert.rejects(jobs.artifact(id, "image.png"), /不支持/);
});

test("initialize marks orphaned running jobs failed without losing audit paths", async () => {
  const jobs = await store();
  const directory = jobs.jobDirectory("job-orphan");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "job.json"), JSON.stringify({
    id: "job-orphan", type: "session", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", jobDir: directory, inputSummary: {}, progress: {},
  }));
  const reloaded = await new WebJobStore({ projectRoot: jobs.projectRoot, outputRoot: jobs.outputRoot }).initialize();
  assert.equal(reloaded.get("job-orphan").status, "failed");
  assert.match(reloaded.get("job-orphan").error, /Web进程已重启/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "job.json"), "utf8")).status, "failed");
});

test("multi-GT progress uses completed criteria plus the active criterion round", async () => {
  const { calculateWorkflowProgress } = await import("../../src/web/job-store.mjs");
  const job = { status: "running", inputSummary: { maxRounds: 50 }, progress: { percent: 30 } };
  const manifest = {
    configuration: { maxRounds: 50 },
    counts: { criteria: 2, plannedCriteria: 2, completed: 1, failed: 0 },
    items: [
      { criterionId: "报告GT2", status: "completed" },
      { criterionId: "报告GT3", status: "running" },
    ],
  };
  const progress = calculateWorkflowProgress({
    job,
    manifest,
    events: [{ criterionId: "报告GT3", phase: "investigation_round_25" }],
    previous: 30,
  });
  assert.ok(progress.percent > 65 && progress.percent < 95, `unexpected progress ${progress.percent}`);
  assert.match(progress.label, /报告GT3/);
  assert.match(progress.label, /1\/2项完成/);
});

test("workflow progress is monotonic and terminal states are exactly 100 percent", async () => {
  const { calculateWorkflowProgress } = await import("../../src/web/job-store.mjs");
  const running = calculateWorkflowProgress({
    job: { status: "running", inputSummary: { maxRounds: 20 }, progress: { percent: 80 } },
    manifest: { counts: { criteria: 2, plannedCriteria: 2 }, items: [{ criterionId: "报告GT2", status: "running" }] },
    events: [{ criterionId: "报告GT2", phase: "scoring_gap" }],
    previous: 80,
  });
  assert.equal(running.percent, 80);
  const failed = calculateWorkflowProgress({ job: { status: "failed" }, previous: 80 });
  assert.deepEqual(failed, { percent: 100, stage: "failed", label: "任务失败" });
  const partial = calculateWorkflowProgress({ job: { status: "completed_with_evidence_gaps" }, previous: 80 });
  assert.deepEqual(partial, { percent: 100, stage: "completed_with_evidence_gaps", label: "归因完成，Trace局部不完整" });
});

test("artifact metadata distinguishes reports from different GT criteria", async () => {
  const jobs = await store();
  const id = "job-artifacts";
  const directory = jobs.jobDirectory(id);
  const gt2 = path.join(directory, "workflows", "single-session-2026-09-23T11-12-17", "rca-runs", "session-1-single-报告GT2-abc", "rca-report.md");
  const gt3 = path.join(directory, "workflows", "single-session-2026-09-23T11-12-17", "rca-runs", "session-1-single-报告GT3-def", "failure-summary.md");
  await mkdir(path.dirname(gt2), { recursive: true });
  await mkdir(path.dirname(gt3), { recursive: true });
  await writeFile(gt2, "# report", "utf8");
  await writeFile(gt3, "# failed", "utf8");
  const job = { id, type: "session", status: "completed_with_failures", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), jobDir: directory, workflowRoot: path.join(directory, "workflows"), inputSummary: {}, progress: {} };
  jobs.jobs.set(id, job);
  const detail = await jobs.details(id);
  assert.equal(detail.artifacts.find((item) => item.name === "rca-report.md").label, "报告GT2 · RCA报告");
  assert.equal(detail.artifacts.find((item) => item.name === "failure-summary.md").label, "报告GT3 · 失败摘要");
  assert.equal(detail.reportTree.sessions.length, 1);
  assert.equal(detail.reportTree.sessions[0].sessionId, "1");
  assert.deepEqual(detail.reportTree.sessions[0].criteria.map((item) => item.criterionId), ["报告GT2", "报告GT3"]);
  assert.equal(detail.reportTree.sessions[0].criteria[0].preferredArtifact.name, "rca-report.md");
});

test("report tree maps the new batch/session/gt storage hierarchy", async () => {
  const jobs = await store();
  const id = "job-report-tree-v2";
  const directory = jobs.jobDirectory(id);
  const workflowDir = path.join(directory, "workflows", "batch-2026-09-23T12-00-00-000Z-test");
  const gtDir = path.join(workflowDir, "sessions", "session-100", "gt", "报告GT2-abcdef");
  await mkdir(gtDir, { recursive: true });
  await writeFile(path.join(gtDir, "rca-report.md"), "# report", "utf8");
  await writeFile(path.join(gtDir, "agent-run.md"), "# log", "utf8");
  await writeFile(path.join(workflowDir, "workflow-manifest.json"), JSON.stringify({
    workflowId: "batch-2026-09-23T12-00-00-000Z-test", status: "completed", startedAt: "2026-09-23T12:00:00.000Z",
    storageLayout: { version: 2, hierarchy: "batch/session/gt" },
    items: [{ sessionId: "100", criterionId: "报告GT2", caseId: "case-2", status: "completed", rcaOutputDir: gtDir }],
  }), "utf8");
  jobs.jobs.set(id, { id, type: "csv", status: "completed", createdAt: "2026-09-23T12:00:00.000Z", updatedAt: "2026-09-23T12:00:00.000Z", jobDir: directory, workflowRoot: path.join(directory, "workflows"), workflowOutputDir: workflowDir, manifestPath: path.join(workflowDir, "workflow-manifest.json"), inputSummary: {}, progress: {} });
  const detail = await jobs.details(id);
  assert.equal(detail.reportTree.batch.storageLayout.version, 2);
  assert.equal(detail.reportTree.sessions[0].sessionId, "100");
  assert.deepEqual(detail.reportTree.sessions[0].criteria[0].artifacts.map((item) => item.name).sort(), ["agent-run.md", "rca-report.md"]);
});

test("batch report tree hides full-score rows and exposes CSV row numbers for actionable Sessions", async () => {
  const jobs = await store();
  const id = "job-report-full-score-hidden";
  const directory = jobs.jobDirectory(id);
  const workflowDir = path.join(directory, "workflows", "batch-test");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(path.join(workflowDir, "workflow-manifest.json"), JSON.stringify({
    workflowId: "batch-test", status: "completed", startedAt: "2026-09-24T00:00:00.000Z",
    items: [
      { rowNumber: 2, sessionId: "full-score-session", status: "skipped", stage: "score_filter", reason: "full_score" },
      { rowNumber: 7, sessionId: "actionable-session", criterionId: "报告GT1", caseId: "case-1", status: "completed" },
    ],
  }), "utf8");
  jobs.jobs.set(id, { id, type: "csv", status: "completed", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z", jobDir: directory, workflowRoot: path.join(directory, "workflows"), workflowOutputDir: workflowDir, manifestPath: path.join(workflowDir, "workflow-manifest.json"), inputSummary: {}, progress: {} });
  const detail = await jobs.details(id);
  assert.deepEqual(detail.reportTree.sessions.map((item) => item.sessionId), ["actionable-session"]);
  assert.deepEqual(detail.reportTree.sessions[0].rowNumbers, [7]);
});

test("batch report tree includes queued non-full-score rows and reports started over total", async () => {
  const { buildReportTree } = await import("../../src/web/job-store.mjs");
  const job = { id: "job-plan", type: "csv", status: "running", createdAt: "2026-09-24T00:00:00.000Z", jobDir: "/tmp/job-plan", lineage: { attempt: 1 } };
  const manifest = {
    workflowId: "batch-plan", status: "running", startedAt: job.createdAt,
    executionPlan: { nonFullScoreRows: 3, records: [
      { rowNumber: 2, sessionId: "100", initialStatus: "queued" },
      { rowNumber: 3, sessionId: "200", initialStatus: "queued" },
      { rowNumber: 4, sessionId: "", initialStatus: "source_run_failed" },
    ] },
    items: [
      { rowNumber: 2, sessionId: "100", criterionId: "报告GT1", status: "running" },
      { rowNumber: 4, sessionId: "", status: "source_run_failed", reason: "source_run_failed" },
    ],
  };
  const tree = buildReportTree({ job, manifest, artifacts: [] });
  assert.equal(tree.counts.nonFullScoreRows, 3);
  assert.equal(tree.counts.startedRows, 2);
  assert.equal(tree.counts.queued, 1);
  assert.deepEqual(new Map(tree.sessions.map((item) => [item.sessionId ?? "missing", { rows: item.rowNumbers, status: item.status }])), new Map([
    ["missing", { rows: [4], status: "source_run_failed" }],
    ["100", { rows: [2], status: "running" }],
    ["200", { rows: [3], status: "queued" }],
  ]));
});

test("report tree exposes Session-level failure and source-run diagnostics", async () => {
  const { buildReportTree } = await import("../../src/web/job-store.mjs");
  const tree = buildReportTree({
    job: { id: "job-errors", type: "csv", status: "completed_with_failures", createdAt: "2026-09-24T00:00:00.000Z", jobDir: "/tmp/job-errors", lineage: { attempt: 1 } },
    manifest: { items: [
      { rowNumber: 24, sessionId: "30697560", status: "failed", stage: "ingestion", error: { code: "TRACE_PARTIAL_RECOVERABLE", message: "Trace不完整", remediation: "补拉后重跑" } },
      { rowNumber: 14, sessionId: "", status: "source_run_failed", stage: "source_run", code: "SOURCE_RUN_FAILED", label: "源任务未成功运行", detail: "Session ID为空；score为空" },
    ] },
    artifacts: [],
  });
  const failure = tree.sessions.find((item) => item.sessionId === "30697560");
  assert.deepEqual(failure.issue, { kind: "failure", status: "failed", stage: "ingestion", code: "TRACE_PARTIAL_RECOVERABLE", label: "Session处理失败", detail: "Trace不完整", remediation: "补拉后重跑", rowNumber: 24 });
  const source = tree.sessions.find((item) => !item.sessionId);
  assert.equal(source.issue.kind, "source_run_failed");
  assert.equal(source.issue.code, "SOURCE_RUN_FAILED");
  assert.match(source.issue.detail, /Session ID为空/);
});

test("failed-only retry creates an immutable child attempt and copies the input snapshot", async () => {
  const jobs = await store();
  const parentId = "job-parent";
  const parentDir = jobs.jobDirectory(parentId);
  const inputPath = path.join(parentDir, "input", "batch.csv");
  const workflowDir = path.join(parentDir, "workflows", "run-1");
  const manifestPath = path.join(workflowDir, "workflow-manifest.json");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await writeFile(inputPath, "header\nvalue\n", "utf8");
  await writeFile(manifestPath, JSON.stringify({
    status: "completed_with_failures",
    items: [
      { rowNumber: 2, sessionId: "100", criterionId: "报告GT2", status: "completed" },
      { rowNumber: 3, sessionId: "200", criterionId: "报告GT3", caseId: "case-3", status: "failed", error: { message: "coverage" }, rcaOutputDir: "/old/run" },
    ],
  }), "utf8");
  const parent = {
    id: parentId, type: "csv", status: "completed_with_failures", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    jobDir: parentDir, workflowRoot: path.join(parentDir, "workflows"), workflowOutputDir: workflowDir, manifestPath, inputPath,
    lineage: { rootJobId: parentId, parentJobId: null, attempt: 1, scope: "initial" },
    inputSummary: { fileName: "batch.csv", maxRounds: 20, concurrency: 4, mode: "live", failFast: false }, progress: {}, stdout: [], stderr: [],
  };
  jobs.jobs.set(parentId, parent);
  jobs.start = () => {};
  const retry = await jobs.createRetry(parentId, { scope: "failed_only", maxRounds: 30, reason: "fixed policy" });
  assert.notEqual(retry.id, parentId);
  assert.equal(retry.lineage.attempt, 2);
  assert.equal(retry.lineage.parentJobId, parentId);
  assert.equal(retry.inputSummary.retryItemCount, 1);
  assert.equal(retry.inputSummary.concurrency, 4);
  assert.equal(await readFile(retry.inputPath, "utf8"), "header\nvalue\n");
  const plan = JSON.parse(await readFile(retry.retryPlanPath, "utf8"));
  assert.equal(plan.retrySelection[0].sessionId, "200");
  assert.equal(plan.retrySelection[0].criterionId, "报告GT3");
  assert.equal(plan.policy.preserveParentArtifacts, true);
  assert.equal(parent.status, "completed_with_failures");
  assert.ok(!jobs.jobs.get(retry.id).commandArgs.includes("--force-ingestion"));
});

test("selected Session retry creates a new attempt for every CSV row of that Session", async () => {
  const jobs = await store();
  const parentId = "job-session-selection";
  const parentDir = jobs.jobDirectory(parentId);
  const inputPath = path.join(parentDir, "input", "batch.csv");
  const workflowDir = path.join(parentDir, "workflows", "run-1");
  const manifestPath = path.join(workflowDir, "workflow-manifest.json");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await writeFile(inputPath, "header\nvalue\n", "utf8");
  await writeFile(manifestPath, JSON.stringify({
    status: "completed_with_failures",
    executionPlan: { records: [
      { rowNumber: 2, sessionId: "100", initialStatus: "queued" },
      { rowNumber: 3, sessionId: "100", initialStatus: "queued" },
      { rowNumber: 4, sessionId: "200", initialStatus: "queued" },
      { rowNumber: 5, sessionId: "", initialStatus: "source_run_failed" },
    ] },
    items: [
      { rowNumber: 2, sessionId: "100", criterionId: "报告GT1", status: "completed" },
      { rowNumber: 3, sessionId: "100", criterionId: "报告GT2", status: "failed" },
      { rowNumber: 4, sessionId: "200", criterionId: "报告GT1", status: "completed" },
    ],
  }), "utf8");
  const parent = {
    id: parentId, type: "csv", status: "completed_with_failures", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    jobDir: parentDir, workflowRoot: path.join(parentDir, "workflows"), workflowOutputDir: workflowDir, manifestPath, inputPath,
    lineage: { rootJobId: parentId, attempt: 1, scope: "initial" },
    inputSummary: { fileName: "batch.csv", maxRounds: 20, concurrency: 3, mode: "live", failFast: false }, progress: {}, stdout: [], stderr: [],
  };
  jobs.jobs.set(parentId, parent);
  jobs.start = () => {};

  const detail = await jobs.details(parentId);
  assert.equal(detail.retry.canRetrySelectedSessions, true);
  assert.equal(detail.retry.selectableSessions.length, 2);
  const selected = detail.retry.selectableSessions.find((item) => item.sessionId === "100");
  assert.deepEqual(selected.rowNumbers, [2, 3]);
  assert.equal(detail.reportTree.sessions.find((item) => item.sessionId === "100").retryKey, selected.retryKey);

  const retry = await jobs.createRetry(parentId, {
    scope: "selected_sessions", selectedSessionKeys: [selected.retryKey], maxRounds: 25, reason: "指定复跑Session 100",
  });
  assert.equal(retry.lineage.scope, "selected_sessions");
  assert.equal(retry.inputSummary.retrySessionCount, 1);
  assert.equal(retry.inputSummary.retryItemCount, 2);
  const plan = JSON.parse(await readFile(retry.retryPlanPath, "utf8"));
  assert.deepEqual(plan.retrySelection.map((item) => [item.rowNumber, item.sessionId, item.criterionId]), [
    [2, "100", undefined], [3, "100", undefined],
  ]);
  assert.ok(plan.retrySelection.every((item) => item.selectionSource === "selected_session"));
  assert.equal(parent.status, "completed_with_failures");
});

test("selected Session retry rejects empty and stale selections", async () => {
  const jobs = await store();
  const id = "job-stale-session-selection";
  const directory = jobs.jobDirectory(id);
  const inputPath = path.join(directory, "input", "batch.csv");
  const workflowDir = path.join(directory, "workflows", "run");
  const manifestPath = path.join(workflowDir, "workflow-manifest.json");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await writeFile(inputPath, "header\nvalue\n");
  await writeFile(manifestPath, JSON.stringify({ executionPlan: { records: [{ rowNumber: 2, sessionId: "100", initialStatus: "queued" }] }, items: [] }));
  jobs.jobs.set(id, {
    id, type: "csv", status: "completed_no_action", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    jobDir: directory, workflowRoot: path.join(directory, "workflows"), workflowOutputDir: workflowDir, manifestPath, inputPath,
    lineage: { rootJobId: id, attempt: 1, scope: "initial" }, inputSummary: { maxRounds: 20, concurrency: 1, mode: "live" }, progress: {}, stdout: [], stderr: [],
  });
  await assert.rejects(jobs.createRetry(id, { scope: "selected_sessions", selectedSessionKeys: [] }), /至少选择一个Session/);
  await assert.rejects(jobs.createRetry(id, { scope: "selected_sessions", selectedSessionKeys: ["SR-stale"] }), /无效或过期/);
});

test("failed-only retry is blocked when the parent stopped before all planned criteria", async () => {
  const jobs = await store();
  const id = "job-incomplete-parent";
  const directory = jobs.jobDirectory(id);
  const inputPath = path.join(directory, "input", "1.json");
  const workflowDir = path.join(directory, "workflows", "run");
  const manifestPath = path.join(workflowDir, "workflow-manifest.json");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await writeFile(inputPath, "{}", "utf8");
  await writeFile(manifestPath, JSON.stringify({
    counts: { plannedCriteria: 3 },
    items: [{ sessionId: "1", criterionId: "报告GT1", status: "failed", error: { message: "first failed" } }],
  }), "utf8");
  jobs.jobs.set(id, {
    id, type: "session", status: "failed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    jobDir: directory, workflowRoot: path.join(directory, "workflows"), workflowOutputDir: workflowDir, manifestPath, inputPath,
    inputSummary: { sessionId: "1", maxRounds: 20, mode: "live" }, progress: {}, stdout: [], stderr: [],
  });
  await assert.rejects(jobs.createRetry(id, { scope: "failed_only" }), /未执行GT.*完整重跑/);
});

test("a later partial retry still exposes unresolved failures from the whole attempt chain", async () => {
  const jobs = await store();
  const rootId = "job-chain-root";
  const childId = "job-chain-child";
  const rootDir = jobs.jobDirectory(rootId);
  const childDir = jobs.jobDirectory(childId);
  const rootWorkflow = path.join(rootDir, "workflows", "run-1");
  const childWorkflow = path.join(childDir, "workflows", "run-2");
  await mkdir(rootWorkflow, { recursive: true });
  await mkdir(childWorkflow, { recursive: true });
  await writeFile(path.join(rootWorkflow, "workflow-manifest.json"), JSON.stringify({ counts: { plannedCriteria: 2 }, items: [
    { rowNumber: 2, sessionId: "100", criterionId: "报告GT2", caseId: "case-2", status: "failed", error: { message: "e2" } },
    { rowNumber: 3, sessionId: "200", criterionId: "报告GT3", caseId: "case-3", status: "failed", error: { message: "e3" } },
  ] }), "utf8");
  await writeFile(path.join(childWorkflow, "workflow-manifest.json"), JSON.stringify({ items: [
    { rowNumber: 2, sessionId: "100", criterionId: "报告GT2", caseId: "case-2-new", status: "completed" },
  ] }), "utf8");
  const root = {
    id: rootId, type: "csv", status: "completed_with_failures", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    jobDir: rootDir, workflowRoot: path.join(rootDir, "workflows"), workflowOutputDir: rootWorkflow, manifestPath: path.join(rootWorkflow, "workflow-manifest.json"),
    lineage: { rootJobId: rootId, attempt: 1, scope: "initial" }, inputSummary: { fileName: "x.csv", maxRounds: 20, mode: "live" }, progress: {}, stdout: [], stderr: [],
  };
  const child = {
    id: childId, type: "csv", status: "completed", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    jobDir: childDir, workflowRoot: path.join(childDir, "workflows"), workflowOutputDir: childWorkflow, manifestPath: path.join(childWorkflow, "workflow-manifest.json"),
    lineage: { rootJobId: rootId, parentJobId: rootId, attempt: 2, scope: "failed_only" }, inputSummary: { fileName: "x.csv", maxRounds: 20, mode: "live" }, progress: {}, stdout: [], stderr: [],
  };
  jobs.jobs.set(rootId, root);
  jobs.jobs.set(childId, child);
  const detail = await jobs.details(childId);
  assert.deepEqual(detail.chainSummary, { total: 2, completed: 1, failed: 1, skipped: 0, sourceRunFailed: 0, running: 0 });
  assert.equal(detail.retry.failedItems.length, 1);
  assert.equal(detail.retry.failedItems[0].sessionId, "200");
  assert.equal(detail.retry.canRetryFailed, true);
});

test("parallel progress aggregates every active criterion", async () => {
  const { calculateWorkflowProgress } = await import("../../src/web/job-store.mjs");
  const progress = calculateWorkflowProgress({
    job: { status: "running", inputSummary: { maxRounds: 20 }, progress: { percent: 30 } },
    manifest: {
      configuration: { maxRounds: 20, concurrency: 2 },
      counts: { plannedCriteria: 4 },
      items: [
        { sessionId: "100", criterionId: "报告GT1", status: "completed" },
        { sessionId: "200", criterionId: "报告GT2", status: "running" },
        { sessionId: "300", criterionId: "报告GT3", status: "running" },
      ],
    },
    events: [
      { sessionId: "200", criterionId: "报告GT2", phase: "investigation_round_10" },
      { sessionId: "300", criterionId: "报告GT3", phase: "investigation_round_10" },
    ],
  });
  assert.ok(progress.percent > 60 && progress.percent < 90, `unexpected progress ${progress.percent}`);
  assert.match(progress.label, /2个GT并行/);
});


test("listWithProgress refreshes running batch cards from the workflow Manifest", async () => {
  const jobs = await store();
  const id = "job-running-progress";
  const directory = jobs.jobDirectory(id);
  const workflowDir = path.join(directory, "workflows", "batch-running");
  const manifestPath = path.join(workflowDir, "workflow-manifest.json");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    status: "running",
    counts: { totalWorkUnits: 4, criteria: 4 },
    items: [
      { sessionId: "1", criterionId: "报告GT1", status: "completed" },
      { sessionId: "2", criterionId: "报告GT1", status: "completed" },
      { sessionId: "3", criterionId: "报告GT1", status: "running" },
    ],
  }), "utf8");
  jobs.jobs.set(id, {
    id, type: "csv", status: "running", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    jobDir: directory, workflowRoot: path.join(directory, "workflows"), workflowOutputDir: workflowDir, manifestPath,
    inputSummary: { maxRounds: 20 }, progress: { percent: 30, stage: "trace", label: "旧Trace进度" }, stdout: [], stderr: [],
  });
  const listed = await jobs.listWithProgress();
  assert.ok(listed[0].progress.percent > 60, `unexpected ${listed[0].progress.percent}`);
  assert.match(listed[0].progress.label, /2\/4项完成/);
});
