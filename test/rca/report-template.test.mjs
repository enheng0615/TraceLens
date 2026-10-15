import assert from "node:assert/strict";
import test from "node:test";
import { renderReportOpening, validateReportOpening } from "../../src/rca/report-template.mjs";

test("case report opening fixes heading order without a wrapper heading", () => {
  const markdown = renderReportOpening({ title: "案例报告", rootCause: "根因尚未定位", category: "内容质量反馈", detailHeading: "详细分析：从原因到用户反馈" }).join("\n");
  assert.match(markdown, /^# 案例报告\n\n## 根因及成因\n\n根因尚未定位。\n\n## 问题类别\n\n内容质量反馈。\n\n## 详细分析：从原因到用户反馈/u);
  assert.doesNotMatch(markdown, /两句话结论|结论摘要/u);
});

test("new report opening requires a single scoped headline and classification", () => {
  const valid = validateReportOpening({ rootCauseHeadline: "查询规划遗漏就业维度，使主体限定没有进入最终答案。", problemClassification: { category: "查询规划缺漏", rationale: "查询没有按就业维度分组。" } });
  assert.equal(valid.valid, true);
  const invalid = validateReportOpening({ rootCauseHeadline: "先漏查。后又漏写。", problemClassification: { category: "", rationale: "" } });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 2);
});
