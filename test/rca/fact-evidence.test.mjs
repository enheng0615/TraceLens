import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactEvidenceGroup,
  evidenceSatisfiesFactGroup,
  findCompositeFactGroupEvidence,
  normalizeEvidenceText,
} from "../../src/rca/fact-evidence.mjs";

function entry(tool, result) {
  return { tool, arguments: {}, result };
}

test("builds stable label-plus-number anchors from a Markdown table row", () => {
  const group = buildFactEvidenceGroup("| **短期借款** | 为492.29亿元，较2021年增长30.88% |", 0);
  assert.deepEqual(group.anchors, ["短期借款", "492.29亿元"]);
  assert.equal(group.sourceQuote.includes("**短期借款**"), true);
});


test("prefers a measured value over a leading year in a Markdown row", () => {
  const group = buildFactEvidenceGroup("| **长期借款** | 2022年达到383.59亿元，为历史最高 |", 0);
  assert.deepEqual(group.anchors, ["长期借款", "383.59亿元"]);
});

test("does not split explanatory parentheses into extra fact requirements", () => {
  const group = buildFactEvidenceGroup("| **短期有息负债合计** | 达836.07亿元（短期借款492.29亿+一年内到期非流动负债343.78亿） |", 0);
  assert.deepEqual(group.anchors, ["短期有息负债合计", "836.07亿元"]);
});

test("accepts get_span_content as source-bearing fact evidence after display normalization", () => {
  const group = buildFactEvidenceGroup("| **短期借款** | 为492.29亿元，较2021年增长30.88% |", 0);
  const evidence = entry("get_span_content", {
    content: "报告内容：\n| **短期借款** | 为 492.29亿元，较2021年增长30.88% |",
  });
  assert.equal(evidenceSatisfiesFactGroup(evidence, group), true);
});

test("accepts a search hit only when one returned excerpt contains every anchor", () => {
  const group = buildFactEvidenceGroup("| **短期借款** | 为492.29亿元 |", 0);
  const good = entry("search_trace", { hits: [{ excerpt: "短期借款为492.29亿元" }] });
  const splitAcrossHits = entry("search_trace", { hits: [{ excerpt: "短期借款" }, { excerpt: "492.29亿元" }] });
  assert.equal(evidenceSatisfiesFactGroup(good, group), true);
  assert.equal(evidenceSatisfiesFactGroup(splitAcrossHits, group), false);
});

test("does not count search arguments themselves as source evidence", () => {
  const group = buildFactEvidenceGroup("短期借款492.29亿元", 0);
  const evidence = { tool: "search_trace", arguments: { query: "短期借款492.29亿元" }, result: { hits: [] } };
  assert.equal(evidenceSatisfiesFactGroup(evidence, group), false);
});

test("normalizes Markdown presentation without removing semantic punctuation", () => {
  assert.equal(normalizeEvidenceText("| **短期 借款** | 492.29亿元 |"), "短期借款492.29亿元");
});

test("composes one answer fact from multiple source-bearing evidence records", () => {
  const group = buildFactEvidenceGroup("| 工作上的刚需 | 满意度20.72% |", 0);
  const result = findCompositeFactGroupEvidence([
    { evidenceId: "EV-1", ...entry("get_tool_exchange", { request: {}, response: "工作上的刚需被纳入计算" }) },
    { evidenceId: "EV-2", ...entry("get_span_content", { content: "该标签满意度为20.72%" }) },
  ], group);
  assert.equal(result.complete, true);
  assert.deepEqual(result.evidenceIds, ["EV-1", "EV-2"]);
});
