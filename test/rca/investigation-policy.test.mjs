import assert from "node:assert/strict";
import test from "node:test";
import { buildInvestigationPolicy } from "../../src/rca/investigation-policy.mjs";

function target() {
  return {
    requiredState: { elements: [
      { source: { type: "ground_truth", excerpt: "Self-Employed(或个体经营者)" } },
      { source: { type: "ground_truth", excerpt: "Debt Consolidation(或债务重组)" } },
    ] },
    answerState: { relevantExcerpts: [
      { quote: "Personal Loan（个人贷款）" },
      { quote: "Debt Consolidation（债务重组）" },
    ] },
    difference: {
      requiredButNotPresent: ["模型生成的缺失说明"],
      presentAndRelevant: ["模型概括但非原文措辞"],
    },
  };
}

test("derives neutral searches and a generic policy from actual Trace tools", () => {
  const policy = buildInvestigationPolicy({}, target(), {
    overview: { toolNames: [{ name: "python_executor", count: 2 }, { name: "write_file", count: 1 }] },
    executionSteps: [{ spanId: "generation", spanType: "GENERATION" }],
  });
  assert.equal(policy.derived, true);
  assert.ok(policy.allTraceSearches.includes("Self-Employed"));
  assert.equal(policy.allTraceSearches.includes("模型生成的缺失说明"), false);
  assert.ok(policy.factChainTerms.some((item) => item.includes("Personal Loan")));
  assert.equal(policy.factEvidenceGroups.length, 2);
  assert.ok(policy.factEvidenceGroups[0].anchors.includes("Personal Loan（个人贷款）"));
  assert.ok(!policy.factChainTerms.includes("模型概括但非原文措辞"));
  assert.equal(policy.requireToolQueryInventory, false);
  assert.deepEqual(policy.schemaToolNames, []);
  assert.deepEqual(policy.executionToolNames, []);
  assert.deepEqual(policy.executionToolCandidates, ["python_executor"]);
  assert.equal(policy.requireAnyExecutionTool, true);
});

test("keeps SQL-specific coverage only when the Trace actually contains Aeolus tools", () => {
  const policy = buildInvestigationPolicy({}, target(), {
    overview: { toolNames: [{ name: "aeolus_data_set_insight" }, { name: "aeolus_sql_query" }] },
  });
  assert.equal(policy.requireToolQueryInventory, true);
  assert.deepEqual(policy.schemaToolNames, ["aeolus_data_set_insight"]);
  assert.deepEqual(policy.executionToolNames, ["aeolus_sql_query"]);
  assert.equal(policy.requireAnyExecutionTool, false);
});

test("requires the evaluated published artifact chain declared by provenance", () => {
  const policy = buildInvestigationPolicy({ inputProvenance: {
    artifactToolSpanId: "write",
    publishToolSpanId: "publish",
  } }, target(), { overview: { toolNames: [{ name: "write_file" }, { name: "lark_doc" }] } });
  assert.deepEqual(policy.artifactToolSpanIds, ["write", "publish"]);
});

test("uses an explicit validated policy as an override", () => {
  const policy = { allTraceSearches: ["x"], factChainTerms: ["y"] };
  assert.equal(buildInvestigationPolicy({ investigationPolicy: policy }, {}), policy);
});


test("falls back to model summary terms only when no grounded answer quote exists", () => {
  const t = target();
  delete t.answerState;
  const policy = buildInvestigationPolicy({}, t);
  assert.ok(policy.factChainTerms.some((item) => item.includes("模型概括但非原文措辞")));
  assert.equal(policy.factEvidenceGroups[0].sourceQuote, "模型概括但非原文措辞");
});


test("turns Markdown table quotes into grouped anchors without parenthetical alias expansion", () => {
  const t = target();
  t.answerState.relevantExcerpts = [
    { quote: "| **短期借款** | 为492.29亿元，较2021年增长30.88% |" },
    { quote: "| **短期有息负债合计** | 达836.07亿元（短期借款492.29亿+其他343.78亿） |" },
  ];
  const policy = buildInvestigationPolicy({}, t);
  assert.deepEqual(policy.factEvidenceGroups.map((item) => item.anchors), [
    ["短期借款", "492.29亿元"],
    ["短期有息负债合计", "836.07亿元"],
  ]);
});


test("mandatory searches never use model-authored scoring-gap explanations", () => {
  const t = {
    requiredState: { elements: [
      { description: "必须明确表述核心结论", source: { type: "ground_truth", excerpt: "3. 债务收入比上升" } },
      { description: "必须作为相关核心原因", source: { type: "ground_truth", excerpt: "债务收入比上升" } },
    ] },
    answerState: { relevantExcerpts: [{ quote: "平均债务收入比从8.83%微升至9.22%" }] },
    difference: {
      requiredButNotPresent: [
        "明确表述“债务收入比上升”这一核心结论",
        "将债务收入比上升作为贷款通过率下降的相关核心原因",
      ],
      presentAndRelevant: [],
    },
  };
  const policy = buildInvestigationPolicy({}, t);
  assert.deepEqual(policy.allTraceSearches, ["3. 债务收入比上升", "债务收入比上升"]);
});
