import assert from "node:assert/strict";
import test from "node:test";
import { extractMissedCriteria } from "../../src/workflows/trace-rca/grading-parser.mjs";

const groundTruth = JSON.stringify({ 结论: { groundTruth: [
  "1. 分钟级响应",
  "2. 及时止损",
  "3. 需通过 Argos或Slardar 接收告警",
  "4. 5 分钟内标记处理中",
] } });

test("maps missed-list ordinal entries back to full GT text by normalized content", () => {
  const grading = {
    conclusion: { 结论: { 缺失项: { inReportMissedRecall: [
      { 未命中项编号: 1, 未命中GT: "3.需通过Argos或Slardar接收告警", 缺失说明: "missing channel" },
      { 未命中项编号: 2, 未命中GT: "4. 5分钟内标记处理中", 缺失说明: "missing mark" },
    ] } } },
  };
  const result = extractMissedCriteria({ machineGrading: grading, groundTruth });
  assert.deepEqual(result.map((item) => item.id), ["报告GT3", "报告GT4"]);
  assert.deepEqual(result.map((item) => item.text), [
    "3. 需通过 Argos或Slardar 接收告警",
    "4. 5 分钟内标记处理中",
  ]);
});

test("returns no work for a recognized grading payload with no missed GT", () => {
  const result = extractMissedCriteria({
    machineGrading: { complete_v2: { 用户需求一致性: [{ GT编号: "报告GT1", 验证结果: "完全满足" }] } },
    groundTruth,
  });
  assert.deepEqual(result, []);
});

test("single-session explicit GT remains authoritative", () => {
  const result = extractMissedCriteria({ machineGrading: "未命中主体限定", explicitGt: "Self-Employed主体" });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Self-Employed主体");
  assert.equal(result[0].reason, "未命中主体限定");
});

test("single-session structured GT object is used as a catalog for missed-item mapping", () => {
  const explicitGt = { 结论: { groundTruth: [
    "1. 亏损恶化：连续亏损且规模扩大",
    "2. 经营现金流枯竭：经营活动现金流转负",
    "3. 债务压力过重：短期与长期债务达到高位",
    "4. 财务费用显著上升",
  ], groundTruthCount: 4 } };
  const machineGrading = {
    conclusion: { 结论: { 缺失项: { inReportMissedRecall: [
      { 未命中GT: "3. 债务压力过重：短期与长期债务达到高位", 缺失说明: "未分析债务结构" },
      { 未命中GT: "4. 财务费用显著上升", 缺失说明: "未分析财务费用" },
    ] } } },
  };
  const result = extractMissedCriteria({ machineGrading, explicitGt });
  assert.deepEqual(result.map((item) => item.id), ["报告GT3", "报告GT4"]);
  assert.deepEqual(result.map((item) => item.text), explicitGt.结论.groundTruth.slice(2));
});

test("single-session structured GT also accepts a JSON-encoded object string", () => {
  const explicitGt = JSON.stringify({ 结论: { groundTruth: ["1. A", "2. B"] } });
  const machineGrading = { conclusion: { 结论: { 缺失项: { inReportMissedRecall: [
    { 未命中GT: "2. B", 缺失说明: "missing B" },
  ] } } } };
  const result = extractMissedCriteria({ machineGrading, explicitGt });
  assert.equal(result[0].id, "报告GT2");
  assert.equal(result[0].text, "2. B");
});
