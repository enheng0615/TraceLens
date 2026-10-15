import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFeedbackBatchCsv, selectFeedbackBatchSessions, runFeedbackBatchWorkflow } from "../../src/workflows/online-feedback/feedback-batch.mjs";
import { buildReportTree } from "../../src/web/report-tree.mjs";

test("feedback batch accepts candidate CSV, preserves multiline feedback, filters labels and deduplicates", () => {
  const parsed = parseFeedbackBatchCsv([
    "session_id,request_query,label,request_id_list",
    '101,"第一行\n第二行",negative,r1',
    '101,"第一行\n第二行",negative,r1',
    "102,正常结果,positive,r2",
    "103,仍然错误,负向,r3",
  ].join("\n"));
  assert.equal(parsed.inputRows, 4);
  assert.equal(parsed.excludedRows, 1);
  assert.equal(parsed.duplicateRows, 1);
  assert.deepEqual(parsed.candidates.map((item) => [item.rowNumber, item.sessionId, item.requestQuery]), [
    [2, "101", "第一行\n第二行"], [5, "103", "仍然错误"],
  ]);
  assert.throws(() => parseFeedbackBatchCsv("session_id,request_query\nx,wrong"), /第 2 行.*数字/);
});

test("feedback batch records each outcome and continues after one case fails", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-feedback-batch-"));
  const seen = [];
  const result = await runFeedbackBatchWorkflow({
    csvText: "session_id,request_query\n101,wrong\n102,broken",
    workflowOutputRoot: output,
    fileName: "negative.csv",
    logger: { info() {} },
    runOne: async ({ input, workflowOutputRoot }) => {
      seen.push(input.sessionId);
      if (input.sessionId === "102") throw new Error("测试失败");
      return { status: "completed", items: [{ status: "completed", rcaOutputDir: path.join(workflowOutputRoot, "report") }] };
    },
  });
  assert.deepEqual(seen, ["101", "102"]);
  assert.equal(result.status, "completed_with_failures");
  assert.equal(result.counts.completed, 1);
  assert.equal(result.counts.failed, 1);
  assert.match(result.items[1].error.message, /测试失败/);
  assert.equal(JSON.parse(await readFile(result.manifestPath, "utf8")).status, "completed_with_failures");
});

test("session slice keeps all feedback for each Session and distinct task associations", () => {
  const parsed = parseFeedbackBatchCsv("session_id,request_query,task_id,request_id_list\n101,same,t1,r1\n101,same,t2,r1\n102,next,t3,r2\n103,last,t4,r3");
  const slice = selectFeedbackBatchSessions(parsed, { sessionStart: 1, sessionCount: 1 });
  assert.equal(slice.totalSessions, 3);
  assert.equal(slice.selectedSessions, 1);
  assert.equal(slice.candidates.length, 2);
  assert.equal(slice.nextSessionStart, 2);
  assert.deepEqual(slice.candidates.map((item) => item.taskId), ["t1", "t2"]);
  assert.deepEqual(selectFeedbackBatchSessions(parsed, { sessionStart: 2, sessionCount: 2 }).candidates.map((item) => item.sessionId), ["102", "103"]);
});

test("two consecutive 150-Session slices do not overlap and retain every feedback per Session", () => {
  const rows = ["session_id,request_query"];
  for (let id = 1; id <= 301; id += 1) {
    rows.push(`${id},feedback-${id}`);
    if (id === 150 || id === 151) rows.push(`${id},another-${id}`);
  }
  const parsed = parseFeedbackBatchCsv(rows.join("\n"));
  const first = selectFeedbackBatchSessions(parsed, { sessionStart: 1, sessionCount: 150 });
  const second = selectFeedbackBatchSessions(parsed, { sessionStart: first.nextSessionStart, sessionCount: 150 });
  assert.equal(first.selectedSessions, 150);
  assert.equal(first.nextSessionStart, 151);
  assert.equal(second.selectedSessions, 150);
  assert.equal(second.nextSessionStart, 301);
  assert.equal(first.candidates.length, 151);
  assert.equal(second.candidates.length, 151);
  assert.equal(new Set([...first.candidates.map((item) => item.sessionId),
    ...second.candidates.map((item) => item.sessionId)]).size, 300);
  assert.throws(() => selectFeedbackBatchSessions(parsed, { sessionCount: 151 }), /1到150/);
});

test("feedback workers parallelize Sessions while serializing repeated feedback in one Session", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "trace-feedback-parallel-"));
  let active = 0;
  let maximum = 0;
  const perSession = new Map();
  const seen = [];
  const result = await runFeedbackBatchWorkflow({
    csvText: "session_id,request_query\n101,first\n101,second\n102,third\n103,fourth",
    workflowOutputRoot: output, sessionCount: 2, concurrency: 2, logger: { info() {} },
    runOne: async ({ input }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      perSession.set(input.sessionId, (perSession.get(input.sessionId) ?? 0) + 1);
      assert.equal(perSession.get(input.sessionId), 1);
      seen.push(input.requestQuery);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      perSession.set(input.sessionId, 0);
      return { status: "completed", items: [{ status: "completed" }] };
    },
  });
  assert.equal(maximum, 2);
  assert.deepEqual(seen, ["first", "third", "second"]);
  assert.equal(result.source.selectedSessions, 2);
  assert.equal(result.source.nextSessionStart, 3);
  assert.equal(result.items.length, 3);
  assert.equal(result.configuration.concurrency, 2);
});

test("feedback batch report tree keeps multiple reports for the same Session distinct", () => {
  const jobDir = "/tmp/feedback-batch-job";
  const first = `${jobDir}/workflows/batch/cases/1/report`;
  const second = `${jobDir}/workflows/batch/cases/2/report`;
  const artifacts = [first, second].map((root) => ({
    name: "feedback-report.md", path: `${path.relative(jobDir, root)}/feedback-report.md`,
    sessionId: "101", criterionId: null,
  }));
  const tree = buildReportTree({ job: { id: "batch", type: "feedback-batch", jobDir, createdAt: "2026-10-15T00:00:00Z" },
    manifest: { items: [
      { rowNumber: 2, sessionId: "101", criterionId: "反馈分析", scenario: "online-feedback", status: "completed", rcaOutputDir: first },
      { rowNumber: 3, sessionId: "101", criterionId: "反馈分析", scenario: "online-feedback", status: "completed", rcaOutputDir: second },
    ], counts: { plannedCriteria: 2 } }, artifacts });
  assert.equal(tree.sessions.length, 1);
  assert.equal(tree.sessions[0].criteria.length, 2);
  assert.deepEqual(tree.sessions[0].criteria.map((item) => item.artifacts[0].path), artifacts.map((item) => item.path));
  assert.equal(tree.counts.nonFullScoreRows, 2);
});
