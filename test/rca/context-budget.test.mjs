import assert from "node:assert/strict";
import test from "node:test";
import { buildWithinPromptBudget } from "../../src/rca/context-budget.mjs";

test("prompt budget deterministically falls back instead of increasing the model limit", () => {
  const result = buildWithinPromptBudget({
    stage: "investigation",
    maxPromptChars: 20_000,
    builder: ({ evidenceBudget, executionBudget }) => "x".repeat(2_000 + evidenceBudget + executionBudget),
  });
  assert.equal(result.compacted, true);
  assert.equal(result.plan.evidenceBudget, 12_000);
  assert.ok(result.prompt.length <= 18_800);
});

test("prompt budget fails with a stable error code only after all compaction plans", () => {
  assert.throws(() => buildWithinPromptBudget({
    stage: "final", maxPromptChars: 10_000, builder: () => "x".repeat(20_000),
  }), (error) => error.code === "RCA_CONTEXT_BUDGET_EXHAUSTED");
});
