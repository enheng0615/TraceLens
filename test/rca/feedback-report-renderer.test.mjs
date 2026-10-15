import assert from "node:assert/strict";
import test from "node:test";
import { renderFeedbackReportMarkdown } from "../../src/rca/scenarios/feedback-report-renderer.mjs";

test("puts two scoped sentences before a source-to-feedback account", () => {
  const markdown = renderFeedbackReportMarkdown({
    causalInvestigationStatus: "localized_unverified",
    anchor: { query: "表里的金额为什么更高？" },
    requirements: [{ status: "active", quote: "统计过去14天", evidenceId: "EV-1" }],
    report: {
      rootCauseHeadline: "取数窗口覆盖28天而制表直接使用金额列，使可疑数值进入交付，是否造成投诉仍待核验。",
      executiveSummary: "当前只观察到取数与制表之间的口径传递。",
      problemClassification: { category: "疑似数据口径衔接问题", rationale: "取数与制表口径有差异。", evidenceIds: ["EV-2"] },
      causalFindings: [{ status: "localized_unverified", localizationLevel: "execution_field",
        location: { spanId: "tool-1", field: "input", pointer: "/arguments/report_filters" },
        expectedBehavior: "区分当前期与基期", contractEvidenceIds: ["EV-1"], evidenceIds: ["EV-2"],
        mechanism: "取数窗口覆盖28天；为什么选择该窗口尚未查明。",
        downstream: [{ spanId: "tool-2", mapping: "制表直接使用返回金额列。", evidenceIds: ["EV-3"] }] }],
      phenomenon: { finding: "交付表出现21852。", evidenceIds: ["EV-4"] },
      evidenceBoundary: { confirmed: "取数参数及制表代码。", notProven: "投诉数值和表格版本。" },
      feedbackAssessment: "partially_supported",
    },
  });
  const causeHeading = markdown.indexOf("## 根因及成因");
  const categoryHeading = markdown.indexOf("## 问题类别");
  const explanation = markdown.indexOf("## 详细分析：从原因到用户反馈");
  const rawEvidence = markdown.indexOf("## 字段级证据与引用");
  assert.ok(causeHeading < categoryHeading && categoryHeading < explanation && explanation < rawEvidence);
  assert.doesNotMatch(markdown, /两句话结论/);
  assert.match(markdown, /候选原因（尚未证实）.*取数窗口覆盖28天/);
  assert.match(markdown, /## 问题类别\n\n疑似数据口径衔接问题。/);
  assert.match(markdown, /统计过去14天.*EV-1/);
  assert.match(markdown, /制表直接使用返回金额列.*EV-3/);
  assert.match(markdown, /用户反馈原文：.*表里的金额为什么更高/);
  assert.match(markdown, /候选机制（未证实）/);
});

test("does not fabricate an upstream cause from a final-answer symptom", () => {
  const markdown = renderFeedbackReportMarkdown({
    causalInvestigationStatus: "symptom_only",
    anchor: { query: "汇报不够深入" },
    report: {
      rootCauseHeadline: "模型忽略了全文档。",
      executiveSummary: "只定位到最终回答。",
      problemClassification: { category: "内容质量反馈，具体缺陷未定位" },
      causalFindings: [{ status: "localized_unverified", localizationLevel: "symptom_only", location: { spanId: "agent-1", field: "output", startOffset: 0, endOffset: 3 }, mechanism: "最终回答提到主题。", evidenceIds: [] }],
      evidenceBoundary: { confirmed: "最终回答可见。", notProven: "具体内容缺口及其上游来源。" },
    },
  });
  assert.match(markdown, /根因尚未定位：当前证据尚不能说明/);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf("## 详细分析")), /模型忽略了全文档/);
  assert.match(markdown, /尚未定位有证据支持的上游偏差/);
  assert.match(markdown, /用户反馈原文：.*汇报不够深入/);
});
