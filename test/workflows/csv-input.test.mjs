import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCsv, readRcaCsv } from "../../src/workflows/trace-rca/csv-input.mjs";

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test("parses RFC4180 fields containing commas, quotes, and newlines", () => {
  const rows = parseCsv('a,b\r\n"x,y","line1\nline2"\r\n');
  assert.deepEqual(rows, [["a", "b"], ["x,y", "line1\nline2"]]);
});

test("maps the evaluation CSV and keeps JWT-bearing URLs out of records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-csv-"));
  const file = path.join(root, "input.csv");
  const header = ["问题", "agentId", "gt_attribution", "题目类型", "问题类型", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_耗时", "ida_答案"];
  const row = [
    "query", "1", JSON.stringify({ 结论: { groundTruth: ["gt"] } }), "x", "y", "0.5",
    JSON.stringify({ complete_v2: { 用户需求一致性: [] } }),
    "https://ida.example/agent/session?agentId=17368&jwtToken=SECRET&sessionId=30509282", "1", "answer\nline2",
  ];
  await writeFile(file, `${header.map(quote).join(",")}\n${row.map(quote).join(",")}\n`, "utf8");
  const result = await readRcaCsv(file);
  assert.equal(result.records[0].sessionId, "30509282");
  assert.equal(result.records[0].agentId, "17368");
  assert.equal(result.records[0].idaAnswer, "answer\nline2");
  assert.equal(JSON.stringify(result.records).includes("SECRET"), false);
  assert.equal(JSON.stringify(result.records).includes("jwtToken"), false);
});

test("extracts only the decimal sessionId value from a long IDA URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-long-url-"));
  const file = path.join(root, "input.csv");
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const row = ["q", "gt", "0", "grading", "https://ida.bytedance.net/agent/session?agentId=17368&jwtToken=SECRET&sessionId=27071569&appId=1", "answer"];
  await writeFile(file, `${header.map(quote).join(",")}\n${row.map(quote).join(",")}\n`, "utf8");
  const result = await readRcaCsv(file);
  assert.equal(result.records[0].sessionId, "27071569");
  assert.equal(JSON.stringify(result.records).includes("SECRET"), false);
});

test("allows a full-score row without Session ID and marks an actionable row invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-full-score-no-session-"));
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const fullFile = path.join(root, "full.csv");
  const fullRow = ["q", "gt", "1.00", "grading", "", "answer"];
  await writeFile(fullFile, `${header.map(quote).join(",")}\n${fullRow.map(quote).join(",")}\n`, "utf8");
  const full = await readRcaCsv(fullFile);
  assert.equal(full.records[0].sessionId, "");
  assert.equal(full.records[0].score, "1.00");

  const actionableFile = path.join(root, "actionable.csv");
  const actionableRow = ["q", "gt", "0.5", "grading", "", "answer"];
  await writeFile(actionableFile, `${header.map(quote).join(",")}\n${actionableRow.map(quote).join(",")}\n`, "utf8");
  const actionable = await readRcaCsv(actionableFile);
  assert.equal(actionable.records[0].sessionId, "");
  assert.equal(actionable.records[0].inputError.code, "SESSION_ID_MISSING");
  assert.equal(actionable.records[0].inputError.rowNumber, 2);
  assert.match(actionable.records[0].inputError.remediation, /源CSV第2行/);
});

test("classifies only the exact four-condition upstream failure as source_run_failed", async () => {
  const { classifySourceRunStatus } = await import("../../src/workflows/trace-rca/csv-input.mjs");
  const classified = classifySourceRunStatus({ sessionId: "", score: "", idaAnswer: "failed", machineGrading: "{}" });
  assert.equal(classified.status, "source_run_failed");
  assert.equal(classified.detail, "Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}");
  assert.equal(classifySourceRunStatus({ sessionId: "1", score: "", idaAnswer: "failed", machineGrading: "{}" }), null);
  assert.equal(classifySourceRunStatus({ sessionId: "", score: "0", idaAnswer: "failed", machineGrading: "{}" }), null);
  assert.equal(classifySourceRunStatus({ sessionId: "", score: "", idaAnswer: "answer", machineGrading: "{}" }), null);
  assert.equal(classifySourceRunStatus({ sessionId: "", score: "", idaAnswer: "failed", machineGrading: '{"error":true}' }), null);
});


test("readRcaCsv writes the four-condition source status instead of an input error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-source-status-"));
  const file = path.join(root, "source-failed.csv");
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const row = ["q", "gt", "", "{}", "", "failed"];
  await writeFile(file, `${header.map(quote).join(",")}\n${row.map(quote).join(",")}\n`, "utf8");
  const result = await readRcaCsv(file);
  assert.equal(result.records[0].inputError, undefined);
  assert.equal(result.records[0].sourceRunStatus.status, "source_run_failed");
  assert.equal(result.records[0].sourceRunStatus.detail, "Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}");
});

test("readRcaCsv classifies incomplete evaluation output without calling it an RCA failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-evaluation-status-"));
  const file = path.join(root, "evaluation-incomplete.csv");
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const grading = JSON.stringify({ origin_critic_res: {}, score_dict: { error100: 0 }, agent_type: "ida" });
  const row = ["q", JSON.stringify({ 结论: { groundTruth: ["required"] } }), "", grading, "sessionId=30658545", "answer"];
  await writeFile(file, `${header.map(quote).join(",")}\n${row.map(quote).join(",")}\n`, "utf8");
  const result = await readRcaCsv(file);
  assert.equal(result.records[0].evaluationInputStatus.status, "evaluation_input_issue");
  assert.equal(result.records[0].evaluationInputStatus.code, "EVALUATION_SCORE_OR_TARGET_MISSING");
  assert.match(result.records[0].evaluationInputStatus.detail, /score为空/);
  assert.match(result.records[0].evaluationInputStatus.detail, /origin_critic_res为空对象/);
  assert.equal(result.records[0].inputError, undefined);
});

test("readRcaCsv reports every missing evaluation component for empty GT rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-rca-evaluation-empty-"));
  const file = path.join(root, "evaluation-empty.csv");
  const header = ["问题", "gt_attribution", "ida_结论报告评分", "ida_decompressed_data", "ida_url", "ida_答案"];
  const grading = JSON.stringify({ origin_critic_res: { missing_indicators: [] }, score_dict: { error100: 0, labeling_eval_score: [] } });
  const row = ["q", "", "", grading, "sessionId=30665165", "answer"];
  await writeFile(file, `${header.map(quote).join(",")}\n${row.map(quote).join(",")}\n`, "utf8");
  const result = await readRcaCsv(file);
  const issue = result.records[0].evaluationInputStatus;
  assert.equal(issue.label, "评测结果缺失：无分数、无GT和未命中项");
  assert.match(issue.detail, /GT为空/);
  assert.match(issue.detail, /missing_indicators为空数组/);
  assert.match(issue.detail, /labeling_eval_score为空数组/);
});
