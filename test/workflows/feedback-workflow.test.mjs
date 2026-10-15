import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { runFeedbackWorkflow, prepareFeedbackTimeline } from "../../src/workflows/online-feedback/workflow.mjs";
import { WebJobStore } from "../../src/web/job-store.mjs";

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feedback-web-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function timeline(root, sessionId = "1") {
  const dir = path.join(root, "timeline/session/detail-pages");
  await mkdir(dir, { recursive: true });
  const turns = [{ turnId: "t1", sessionId, businessTraceId: "trace1", startTime: 1, endTime: 2, input: "请统计", output: "已交付" },
    { turnId: "t2", sessionId, businessTraceId: "trace2", startTime: 3, endTime: 4, input: "数据不对", output: "更正" }];
  await writeFile(path.join(dir, "page-0001.json"), JSON.stringify({ data: { sessionId, hasMore: false, total: 2, turns } }));
  return path.join(root, "timeline");
}

test("feedback Web job needs no GT, keeps feedback in the input snapshot, and retries in a new directory", async () => fixture(async root => {
  const store = await new WebJobStore({ projectRoot: root, outputRoot: path.join(root, "web") }).initialize();
  store.start = () => {};
  await assert.rejects(store.createFeedback({ sessionId: "bad", requestQuery: "x" }), /纯数字/);
  await assert.rejects(store.createFeedback({ sessionId: "1", requestQuery: " " }), /反馈原文/);
  await assert.rejects(store.createFeedback({ sessionId: "1", requestQuery: "x", maxTurns: 101 }), /1到100/);
  const job = await store.createFeedback({ sessionId: "1", requestQuery: "数据不对", requestIdList: "request-1" });
  assert.equal(job.type, "feedback");
  assert.equal(JSON.stringify(store.list()).includes("数据不对"), false);
  assert.equal(job.commandArgs, undefined);
  const input = JSON.parse(await readFile(job.inputPath, "utf8"));
  assert.equal(input.requestQuery, "数据不对");
  assert.equal(input.requestIdList, "request-1");
  const stored = store.jobs.get(job.id);
  assert.ok(stored.commandArgs.includes("scripts/run-feedback-workflow.mjs"));
  stored.status = "failed";
  const next = await store.createRetry(job.id, { scope: "failed_only" });
  assert.equal(next.lineage.parentJobId, job.id);
  assert.equal(next.lineage.attempt, 2);
  assert.notEqual(next.jobDir, job.jobDir);
  assert.deepEqual(JSON.parse(await readFile(next.inputPath, "utf8")), input);
}));

test("shared feedback workflow produces a browsable Session report without inventing a GT", async () => fixture(async root => {
  const timelineRoot = await timeline(root);
  const manifest = await runFeedbackWorkflow({ input: { sessionId: "1", requestQuery: "数据不对", timelineRoot, fetchMissing: false },
    projectRoot: root, traceOutputRoot: path.join(root, "trace"), workflowOutputRoot: path.join(root, "workflows"), agentFactory: () => ({}), logger: {},
    runCase: async args => {
      assert.equal(args.candidate.requestQuery, "数据不对");
      assert.equal(args.timeline.length, 2);
      assert.equal(args.collectEpisode, undefined);
      assert.equal(args.gt, undefined);
      await mkdir(args.outputDir, { recursive: true });
      await writeFile(path.join(args.outputDir, "feedback-report.md"), "# 测试报告\n");
      return { status: "completed", causalInvestigationStatus: "localized_unverified", report: { executiveSummary: "测试工作流产物", feedbackAssessment: "partially_supported", problemClassification: { category: "候选缺陷" } } };
    } });
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.items[0].criterionId, "反馈分析");
  const store = await new WebJobStore({ projectRoot: root, outputRoot: path.join(root, "web") }).initialize();
  const job = { id: "job-test", type: "feedback", status: manifest.status, jobDir: root, workflowRoot: path.join(root, "workflows"), workflowOutputDir: manifest.outputDir,
    manifestPath: manifest.manifestPath, createdAt: new Date().toISOString(), inputSummary: { sessionId: "1" }, progress: {} };
  store.jobs.set(job.id, job);
  const details = await store.details(job.id);
  assert.equal(details.reportTree.sessions[0].criteria[0].preferredArtifact.name, "feedback-report.md");
  assert.equal(details.feedbackSummary.problemClassification.category, "候选缺陷");
  assert.ok(details.artifacts.some(a => a.kind === "report"));
}));

test("missing feedback anchor gets an explicit unresolved report, and wrong Session is a failure", async () => fixture(async root => {
  const timelineRoot = await timeline(root);
  const options = { input: { sessionId: "1", requestQuery: "不存在的反馈", timelineRoot, fetchMissing: false }, projectRoot: root,
    traceOutputRoot: path.join(root, "trace"), workflowOutputRoot: path.join(root, "workflows"), agentFactory: () => ({ invoke() { throw new Error("must not call model"); } }), logger: {} };
  const result = await runFeedbackWorkflow(options);
  assert.equal(result.status, "completed_with_evidence_gaps");
  assert.match(await readFile(path.join(result.items[0].rcaOutputDir, "feedback-report.md"), "utf8"), /无法唯一定位/);
  await assert.rejects(runFeedbackWorkflow({ ...options, input: { ...options.input, sessionId: "2" } }), /Session mismatch/);
}));

test("timeline acquisition uses session-only pagination and validates the returned identity", async () => fixture(async root => {
  const calls = [];
  const client = { tenant: "data", async fetchJson(file, args) {
    calls.push(args);
    const data = args[1] === "list" ? { sessions: [{ sessionId: "1", agentId: "agent1" }] } : {
      sessionId: "1", agentId: "agent1", agentType: "ida", hasMore: false, total: 1,
      turns: [{ sessionId: "1", turnId: "t1", businessTraceId: "trace1", startTime: 1, endTime: 2, input: "q", output: "a" }],
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ data }));
    return { data };
  } };
  const result = await prepareFeedbackTimeline({ sessionId: "1", outputDir: root, client });
  assert.equal(result.timeline.length, 1);
  assert.equal(result.coverage.identity.agentId, "agent1");
  assert.ok(calls.every(args => args[0] === "session"));
}));

test("automatic lookup refreshes stale cached history when feedback is missing", async () => fixture(async root => {
  const cached = path.join(root, "data/raw/sophon-session-turns/1/session/detail-pages");
  await mkdir(cached, { recursive: true });
  const turn = { sessionId: "1", turnId: "t1", businessTraceId: "trace1", startTime: 1, endTime: 2, input: "旧请求", output: "回答" };
  await writeFile(path.join(cached, "page-0001.json"), JSON.stringify({ data: { sessionId: "1", agentId: "a1", agentType: "ida", hasMore: false, total: 1, turns: [turn] } }));
  let refreshed = false;
  const client = { async fetchJson(file, args) {
    const data = args[1] === "list" ? { sessions: [{ sessionId: "1", agentId: "a1" }] } : {
      sessionId: "1", agentId: "a1", agentType: "ida", hasMore: false, total: 2,
      turns: [turn, { ...turn, turnId: "t2", businessTraceId: "trace2", startTime: 3, endTime: 4, input: "新反馈" }],
    };
    refreshed = true; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ data })); return { data };
  } };
  const result = await runFeedbackWorkflow({ input: { sessionId: "1", requestQuery: "新反馈" }, projectRoot: root,
    workflowOutputRoot: path.join(root, "workflows"), traceOutputRoot: path.join(root, "trace"), client, logger: {}, agentFactory: () => ({}),
    runCase: async args => { assert.equal(args.timeline.length, 2); return { status: "anchor_unresolved", anchor: { status: "ambiguous" } }; } });
  assert.equal(refreshed, true);
  assert.ok(result.source.timelineRoot.endsWith("source"));
  assert.equal(result.status, "completed_with_evidence_gaps");
}));
