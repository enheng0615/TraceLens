import assert from "node:assert/strict";
import test from "node:test";
import { validateReportEvidenceConsistency } from "../../src/rca/report-consistency-validator.mjs";

function ledger(matches = 74) {
  return {
    entries: [{
      evidenceId: "EV-009",
      source: "agent",
      tool: "search_trace",
      arguments: { query: "就业状况", scope: "all" },
      result: { totalMatches: matches },
    }],
  };
}

test("rejects whole-Trace absence claims contradicted by nonzero search matches", () => {
  const report = {
    executiveSummary: "全Trace中就业状况无匹配。",
    causalChain: [{ finding: "就业状况从未出现。", evidenceIds: ["EV-009"] }],
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-009"] },
  };
  const result = validateReportEvidenceConsistency(report, ledger());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("74 matches")));
});

test("allows a precise distinction between field propagation and query non-use", () => {
  const report = {
    executiveSummary: "就业状况字段进入上下文，但没有进入SQL查询。",
    causalChain: [{ finding: "就业状况有搜索命中，但未产生值域统计。", evidenceIds: ["EV-009"] }],
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-009"] },
  };
  assert.equal(validateReportEvidenceConsistency(report, ledger()).valid, true);
});

test("caps observational causal confidence at medium", () => {
  const report = { rootCauseAssessment: { confidence: "high", evidenceIds: ["EV-009"] } };
  const result = validateReportEvidenceConsistency(report, ledger(0));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("intervention")));
});

test("does not confuse a short positive query with an absent longer quoted query", () => {
  const report = {
    requiredFactLifecycle: [{
      finding: "全Trace搜索“人力相对增长较小”0命中，搜索“人力”命中109处，但均为无关模板文本。",
      evidenceIds: ["EV-LONG", "EV-SHORT"],
    }],
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-LONG"] },
  };
  const mixedLedger = { entries: [
    { evidenceId: "EV-LONG", tool: "search_trace", arguments: { query: "人力相对增长较小", scope: "all" }, result: { totalMatches: 0 } },
    { evidenceId: "EV-SHORT", tool: "search_trace", arguments: { query: "人力", scope: "all" }, result: { totalMatches: 109 } },
  ] };
  assert.equal(validateReportEvidenceConsistency(report, mixedLedger).valid, true);
});

test("still rejects an exact quoted absence claim for a nonzero query", () => {
  const report = {
    executiveSummary: "全Trace搜索“人力”0命中。",
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-SHORT"] },
  };
  const mixedLedger = { entries: [
    { evidenceId: "EV-SHORT", tool: "search_trace", arguments: { query: "人力", scope: "all" }, result: { totalMatches: 109 } },
  ] };
  const result = validateReportEvidenceConsistency(report, mixedLedger);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("109 matches")));
});

test("partial Trace permits only visible-scope absence and requires an explicit unknown boundary", () => {
  const partialLedger = { entries: [{
    evidenceId: "EV-PARTIAL",
    tool: "search_trace",
    arguments: { query: "Self-Employed", scope: "all" },
    result: {
      totalMatches: 0,
      coverage: { negativeEvidenceEligible: false, unknownSegments: [{ spanId: "span-cut", field: "output" }] },
    },
  }] };
  const invalid = validateReportEvidenceConsistency({
    executiveSummary: "全Trace中Self-Employed不存在。",
    evidenceBoundary: { notProven: "未知。" },
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-PARTIAL"] },
  }, partialLedger);
  assert.equal(invalid.valid, false);

  const valid = validateReportEvidenceConsistency({
    executiveSummary: "当前可见Trace未发现Self-Employed。",
    evidenceBoundary: { notProven: "截断的span-cut.output属于未知区间。" },
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-PARTIAL"] },
  }, partialLedger);
  assert.equal(valid.valid, true);
});

test("one-character searches do not contradict absence of a longer compound requirement", () => {
  const shortLedger = { entries: [{
    evidenceId: "EV-SHORT", tool: "search_trace", arguments: { query: "丙", scope: "all" }, result: { totalMatches: 9 },
  }] };
  const report = {
    executiveSummary: "全Trace未出现“神鼠丙和神鼠丁”这一完整组合。",
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-SHORT"] },
  };
  assert.equal(validateReportEvidenceConsistency(report, shortLedger).valid, true);
});

test("does not misread inability to prove absence as an absence assertion", () => {
  const partialLedger = { entries: [{
    evidenceId: "EV-N", tool: "search_trace", arguments: { query: "-7.23", scope: "all" },
    result: { totalMatches: 0, coverage: { negativeEvidenceEligible: false } },
  }] };
  const report = {
    executiveSummary: "无法证明完整Trace中不存在-7.23。",
    evidenceBoundary: { notProven: "截断Tool输出仍未知。" },
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-N"] },
  };
  assert.equal(validateReportEvidenceConsistency(report, partialLedger).valid, true);
});

test("pure-number lexical hits do not contradict a scoped semantic absence claim", () => {
  const numericLedger = { entries: [{
    evidenceId: "EV-820", tool: "search_trace", arguments: { query: "820", scope: "all" },
    result: { totalMatches: 1055 },
  }] };
  const scoped = {
    executiveSummary: "未发现将820作为VaseVolume合理范围使用的计算证据。",
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-820"] },
  };
  assert.equal(validateReportEvidenceConsistency(scoped, numericLedger).valid, true);
  const literal = {
    executiveSummary: "字符820在整个Trace任何位置一次都未出现。",
    rootCauseAssessment: { confidence: "medium", evidenceIds: ["EV-820"] },
  };
  assert.equal(validateReportEvidenceConsistency(literal, numericLedger).valid, false);
});
