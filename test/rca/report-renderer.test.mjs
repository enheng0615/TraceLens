import assert from "node:assert/strict";
import test from "node:test";
import { buildKeyExecutionEvidence, renderReportMarkdown } from "../../src/rca/report-renderer.mjs";

const report = {
  caseId: "case-tool-audit",
  executiveSummary: "Python筛选口径发生分叉。",
  scoreGap: { criterionId: "GT-1", observedDifference: "缺少指定主体" },
  actualAnswerProductionChain: [{ step: "执行Python筛选", evidenceIds: ["EV-006"] }],
  requiredFactLifecycle: [],
  earliestMaterialDivergence: { finding: "筛选条件不同", whyMaterial: "影响最终主体", evidenceIds: ["EV-006"] },
  causalChain: [{ finding: "错误筛选延续至答案", evidenceIds: ["EV-006"] }],
  alternativeExplanations: [],
  rootCauseAssessment: { finding: "筛选口径错误", confidence: "medium", evidenceIds: ["EV-006"] },
  evidenceBoundary: { confirmed: "可见代码和输出", notProven: "未重放" },
  recommendedNextVerification: [],
};
const ledger = { entries: [{
  evidenceId: "EV-006", tool: "get_tool_exchange", purpose: "读取关键Python执行",
  result: {
    spanId: "python-span", name: "python_executor", status: "SUCCESS",
    request: { arguments: { code: "winner = df[df['award'] == True]" } },
    response: "RoyalTaste Ltd.; difference=-2", responseTruncated: false,
  },
  rawRefs: [{ spanId: "python-span", field: "input", startOffset: 0, endOffset: 55 }],
}] };

test("expands every cited Tool exchange into auditable report evidence", () => {
  const evidence = buildKeyExecutionEvidence(report, ledger);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].toolName, "python_executor");
  const markdown = renderReportMarkdown(
    report, { valid: true }, { valid: true }, { valid: true },
    { classification: "complete", analysisAllowed: true, negativeEvidenceEligible: true }, ledger,
  );
  assert.match(markdown, /关键 Tool\/Skill 调用审计/);
  assert.match(markdown, /winner = df/);
  assert.match(markdown, /RoyalTaste Ltd/);
  assert.match(markdown, /python-span\.input\[0:55\]/);
  assert.match(markdown, /## 根因及成因\n\n根因尚未定位/);
  assert.match(markdown, /## 问题类别\n\n尚未归类/);
  assert.ok(markdown.indexOf("## 详细分析：从原因到最终结果") < markdown.indexOf("## 关键 Tool/Skill 调用审计"));
});

test("RCA report uses the fixed opening for a supported cause and category", () => {
  const markdown = renderReportMarkdown({ ...report,
    causalInvestigationStatus: "mechanism_supported",
    rootCauseHeadline: "筛选口径偏离任务要求，使指定主体在最终答案中缺失。",
    problemClassification: { category: "查询筛选口径错误", rationale: "筛选条件与要求不一致。" },
  }, { valid: true }, { valid: true }, { valid: true }, {}, ledger);
  assert.match(markdown, /## 根因及成因\n\n当前证据支持的原因：筛选口径偏离任务要求/);
  assert.match(markdown, /## 问题类别\n\n查询筛选口径错误。/);
  assert.match(markdown, /### 3\. 偏差如何传递至最终答案[\s\S]*错误筛选延续至答案/);
});

test("expands uncited Tool exchanges that the investigation explicitly inspected", () => {
  const unrelated = { entries: [{ ...ledger.entries[0], evidenceId: "EV-999" }] };
  const evidence = buildKeyExecutionEvidence(report, unrelated);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].citedByFinalReport, false);
});

test("expands the tool exchange when a cited search hit points to the same Span", () => {
  const searchReport = { causalChain: [{ finding: "python output caused the answer", evidenceIds: ["EV-001"] }] };
  const spanLinkedLedger = {
    entries: [
      {
        evidenceId: "EV-001", tool: "search_trace", result: { totalMatches: 1 },
        rawRefs: [{ spanId: "tool-9", field: "output", contentSha256: "abc" }],
      },
      {
        evidenceId: "EV-002", tool: "get_tool_exchange", purpose: "read python",
        result: { spanId: "tool-9", name: "python_executor", request: { code: "print(2)" }, response: "2" },
        rawRefs: [],
      },
    ],
  };
  const result = buildKeyExecutionEvidence(searchReport, spanLinkedLedger);
  assert.equal(result.length, 1);
  assert.equal(result[0].evidenceId, "EV-002");
  assert.equal(result[0].request.code, "print(2)");
});

test("renders Skill input, output, truncation state, and raw source path", () => {
  const skillLedger = { entries: [{
    evidenceId: "EV-010", tool: "get_tool_exchange", purpose: "读取Skill执行",
    result: {
      spanId: "skill-10", name: "skill_operation", executionKind: "skill", status: "SUCCESS",
      request: { skill: "sheet-analysis", arguments: { file: "input.csv" } },
      response: "first 12000 chars", responseTruncated: true, responseTotalChars: 20000, requestTotalChars: 88,
      requestEvidenceRef: { rawPath: "/trace/spans/details/skill-10.json" },
      responseEvidenceRef: { rawPath: "/trace/spans/details/skill-10.json" },
    },
    rawRefs: [
      { spanId: "skill-10", field: "input", startOffset: 0, endOffset: 88 },
      { spanId: "skill-10", field: "output", startOffset: 0, endOffset: 20000 },
    ],
  }] };
  const markdown = renderReportMarkdown(
    { ...report, causalChain: [{ finding: "Skill返回影响结论", evidenceIds: ["EV-010"] }] },
    { valid: true }, { valid: true }, { valid: true },
    { classification: "complete", analysisAllowed: true, negativeEvidenceEligible: true }, skillLedger,
  );
  assert.match(markdown, /EV-010 · Skill · skill_operation/);
  assert.match(markdown, /实际 Skill 输入\/参数/);
  assert.match(markdown, /sheet-analysis/);
  assert.match(markdown, /first 12000 chars/);
  assert.match(markdown, /RCA 读取窗口：仅读取前 17\/20000 字符/);
  assert.match(markdown, /原始 Trace 返回载荷：本项不以报告篇幅判断是否截断/);
  assert.match(markdown, /skill-10\.json#\$\.data\.output/);
});

test("labels report-only omission without claiming that the raw Trace is truncated", () => {
  const longRequest = { content: "x".repeat(13_000) };
  const longLedger = { entries: [{
    evidenceId: "EV-020", tool: "get_tool_exchange", purpose: "读取长输入",
    result: {
      spanId: "long-tool", name: "write_file", request: longRequest, response: "ok",
      requestTotalChars: 13_014, responseTotalChars: 2, responseTruncated: false,
    }, rawRefs: [],
  }] };
  const markdown = renderReportMarkdown(
    report, { valid: true }, { valid: true }, { valid: true },
    { classification: "complete", analysisAllowed: true, negativeEvidenceEligible: true }, longLedger,
  );
  assert.match(markdown, /仅报告正文为控制篇幅省略；这不表示原始 Trace 截断/);
  assert.match(markdown, /报告正文展示：输入展示前 12000\/13019 字符；返回完整展示 2 字符/);
  assert.doesNotMatch(markdown, /报告展示截断/);
});
