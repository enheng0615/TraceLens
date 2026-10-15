import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebAuditLogger } from "../../src/web/audit-logger.mjs";
import { buildJobDiagnosis, renderWebFailureSummary } from "../../src/web/job-diagnostics.mjs";

function quote(value) { return `"${String(value).replaceAll('"', '""')}"`; }

test("Web audit logs redact secrets and CSV content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-web-audit-"));
  const logger = new WebAuditLogger(root);
  const job = { id: "job-1", jobDir: path.join(root, "jobs", "job-1") };
  await logger.job(job, "test_event", {
    line: "failed https://example.test/?jwtToken=SECRET_TOKEN authorization: Bearer PRIVATE",
    apiKey: "API_SECRET",
    csvText: "sensitive CSV row",
  }, "error");
  const text = await readFile(path.join(job.jobDir, "web-job.jsonl"), "utf8");
  assert.doesNotMatch(text, /SECRET_TOKEN|PRIVATE|API_SECRET|sensitive CSV row/);
  assert.match(text, /<redacted>/);
});

test("Web diagnosis reports the exact CSV row instead of the last stack frame", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-web-diagnosis-"));
  const inputPath = path.join(root, "input.csv");
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const rows = [
    ["full", "gt", "1", "grading", "", "answer"],
    ["bad", "gt", "", "grading", "", "answer"],
  ];
  await writeFile(inputPath, `${header.map(quote).join(",")}\n${rows.map((row) => row.map(quote).join(",")).join("\n")}\n`, "utf8");
  const diagnosis = await buildJobDiagnosis({
    id: "job-2", type: "csv", status: "failed", inputPath, exitCode: 1,
    stderr: ["CSV Trace RCA workflow failed: TraceIngestionError: query URL 格式非法", " at async scripts/run-trace-rca-csv.mjs:52:18"],
  });
  assert.equal(diagnosis.stage, "input_validation");
  assert.equal(diagnosis.code, "SESSION_ID_MISSING");
  assert.match(diagnosis.message, /CSV第3行/);
  assert.doesNotMatch(diagnosis.message, /run-trace-rca-csv/);
  assert.match(renderWebFailureSummary(diagnosis), /CSV第3行/);
});

test("Web diagnosis prioritizes a systemic CLI failure over a smaller input-error group", async () => {
  const diagnosis = await buildJobDiagnosis({
    id: "job-systemic", type: "csv", status: "failed", exitCode: 2, stderr: [],
  }, {
    items: [
      { status: "failed", stage: "input_validation", error: { code: "SESSION_ID_MISSING", message: "missing" } },
      { status: "failed", stage: "ingestion", error: { code: "SOPHON_CLI_ERROR", message: "sophon-cli 退出码为 2：--since 与 --until 必须同时提供" } },
      { status: "failed", stage: "ingestion", error: { code: "SOPHON_CLI_ERROR", message: "sophon-cli 退出码为 2：--since 与 --until 必须同时提供" } },
    ],
  });
  assert.equal(diagnosis.code, "SOPHON_CLI_ERROR");
  assert.equal(diagnosis.failureGroups[0].count, 2);
  assert.match(diagnosis.impact, /2个待归因输入/);
  assert.match(diagnosis.remediation, /成对提供/);
});

test("Web diagnosis explains Sophon's 30-day Session lookup limit", async () => {
  const diagnosis = await buildJobDiagnosis({
    id: "job-window", type: "csv", status: "failed", exitCode: 2, stderr: [],
  }, {
    items: Array.from({ length: 3 }, () => ({
      status: "failed", stage: "ingestion",
      error: { code: "SOPHON_CLI_ERROR", message: "sophon-cli 退出码为 2：Session查询范围不能超过30天" },
    })),
  });
  assert.equal(diagnosis.code, "SOPHON_CLI_ERROR");
  assert.match(diagnosis.remediation, /小于30天的窗口逐段回溯/);
});

test("completed batch diagnosis uses the dominant Manifest failure instead of stale process context", async () => {
  const diagnosis = await buildJobDiagnosis({
    id: "job-completed-partial", type: "csv", status: "completed_with_failures",
    failureContext: { stage: "input_validation", code: "OLD", message: "stale context" },
    stderr: [],
  }, { items: [
    { status: "failed", error: { code: "RCA_INVESTIGATION_STALLED", message: "Investigation stalled" } },
    { status: "failed", error: { code: "RCA_INVESTIGATION_STALLED", message: "Investigation stalled again" } },
    { status: "failed", stage: "preparation", error: { code: "CASE_TRACE_MISMATCH", message: "mismatch" } },
  ] });
  assert.equal(diagnosis.stage, "investigation");
  assert.equal(diagnosis.stageLabel, "Trace调查");
  assert.equal(diagnosis.code, "RCA_INVESTIGATION_STALLED");
});
