import assert from "node:assert/strict";
import test from "node:test";
import { compareEvaluatedQuery, stripControlledEvaluationQuerySuffixes } from "../../src/workflows/trace-rca/content-alignment.mjs";

test("accepts a known evaluation-only Query suffix while preserving provenance", () => {
  const result = compareEvaluatedQuery(
    "全网搜索下，ios 26.6 什么时候正式发布,请回答北京时间",
    "全网搜索下，ios 26.6 什么时候正式发布",
  );
  assert.equal(result.matches, true);
  assert.equal(result.resolution, "controlled_evaluation_instruction_removed");
  assert.deepEqual(result.provenance.removedEvaluationInstructions.expected, ["请回答北京时间"]);
});

test("does not remove unregistered substantive Query differences", () => {
  const result = compareEvaluatedQuery("查询价格并回答北京时间", "查询价格");
  assert.equal(result.matches, false);
});

test("strips the known no-follow-up evaluation instruction only at the suffix", () => {
  const value = stripControlledEvaluationQuerySuffixes(
    "找到首页并截图。注意不要让用户二次回复来明确相关定义，需要自行判定或按默认处理。",
  );
  assert.equal(value.text, "找到首页并截图");
  assert.equal(value.removed.length, 1);
});
