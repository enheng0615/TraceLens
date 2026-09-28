import assert from "node:assert/strict";
import test from "node:test";
import { evaluateInvestigationCoverage } from "../../src/rca/coverage-validator.mjs";

function entry(tool, args = {}, result = {}) {
  return { tool, arguments: args, result };
}

const policy = {
  allTraceSearches: ["Self-Employed", "就业状况"],
  factChainTerms: ["Debt Consolidation", "Personal Loan"],
  requireToolQueryInventory: true,
  schemaToolNames: ["aeolus_data_set_insight"],
  executionToolNames: ["aeolus_sql_query"],
  requireFinalGenerationOutput: true,
};
const executionSteps = [{ spanId: "final-generation", spanType: "GENERATION" }];

test("requires an explicit case policy", () => {
  assert.throws(() => evaluateInvestigationCoverage({ entries: [] }), /investigationPolicy/);
});

test("requires both answer-path and missing-fact-path coverage", () => {
  const ledger = { entries: [entry("list_tool_queries")] };
  const result = evaluateInvestigationCoverage(ledger, { policy, executionSteps });
  assert.equal(result.complete, false);
  assert.ok(result.missing.some((item) => item.includes("Self-Employed")));
});

test("accepts a declarative minimum investigation contract", () => {
  const ledger = {
    entries: [
      entry("list_tool_queries"),
      entry("search_trace", { query: "Self-Employed", scope: "all" }),
      entry("search_trace", { query: "就业状况", scope: "all" }),
      entry("search_trace", { query: "Debt Consolidation", scope: "primary" }),
      entry("search_trace", { query: "Personal Loan", scope: "primary" }),
      entry("get_tool_exchange", {}, { name: "aeolus_data_set_insight" }),
      entry("get_tool_exchange", {}, { name: "aeolus_sql_query" }),
      entry("get_span_content", {}, { span: { spanId: "final-generation", spanType: "GENERATION" }, field: "output" }),
    ],
  };
  assert.equal(evaluateInvestigationCoverage(ledger, { policy, executionSteps }).complete, true);
});

test("accepts critical execution exchanges as fact-chain evidence", () => {
  const ledger = {
    entries: [
      entry("list_tool_queries"),
      entry("search_trace", { query: "Self-Employed", scope: "all" }),
      entry("search_trace", { query: "就业状况", scope: "all" }),
      entry("get_tool_exchange", {}, { name: "aeolus_data_set_insight" }),
      entry("get_tool_exchange", {}, {
        name: "aeolus_sql_query",
        request: { arguments: { ansi_sql: "WHERE 贷款类型 = 'Personal Loan' GROUP BY 贷款用途" } },
        response: "Debt Consolidation",
      }),
      entry("get_span_content", {}, {
        span: { spanId: "final-generation", spanType: "GENERATION" },
        field: "output",
      }),
    ],
  };
  assert.equal(evaluateInvestigationCoverage(ledger, { policy, executionSteps }).complete, true);
});


test("supports generic execution and exact published artifact coverage", () => {
  const genericPolicy = {
    allTraceSearches: ["人力"],
    factChainTerms: ["积压"],
    requireToolInventory: true,
    requireToolQueryInventory: false,
    schemaToolNames: [],
    executionToolNames: [],
    requireAnyExecutionTool: true,
    executionToolCandidates: ["python_executor", "bash"],
    artifactToolSpanIds: ["write", "publish"],
    requireFinalGenerationOutput: true,
  };
  const genericSteps = [{ spanId: "final", spanType: "GENERATION" }];
  const ledger = { entries: [
    entry("get_trace_overview", {}, { toolNames: [{ name: "python_executor" }] }),
    entry("search_trace", { query: "人力", scope: "all" }),
    entry("search_trace", { query: "积压", scope: "primary" }),
    entry("get_tool_exchange", {}, { spanId: "python", name: "python_executor" }),
    entry("get_tool_exchange", {}, { spanId: "write", name: "write_file" }),
    entry("get_tool_exchange", {}, { spanId: "publish", name: "lark_doc" }),
    entry("get_span_content", {}, { span: { spanId: "final", spanType: "GENERATION" }, field: "output" }),
  ] };
  assert.equal(evaluateInvestigationCoverage(ledger, { policy: genericPolicy, executionSteps: genericSteps }).complete, true);
});

test("generic coverage remains incomplete until every published artifact span is read", () => {
  const result = evaluateInvestigationCoverage({ entries: [
    entry("get_trace_overview", {}, { toolNames: [] }),
    entry("search_trace", { query: "人力", scope: "all" }),
    entry("search_trace", { query: "积压", scope: "all" }),
    entry("get_tool_exchange", {}, { spanId: "write", name: "write_file" }),
  ] }, { policy: {
    allTraceSearches: ["人力"], factChainTerms: ["积压"], requireToolInventory: true,
    artifactToolSpanIds: ["write", "publish"], requireFinalGenerationOutput: false,
  } });
  assert.equal(result.complete, false);
  assert.ok(result.missing.some((item) => item.includes("publish")));
});


test("structured fact groups accept full final Generation content without exact search query", () => {
  const groupedPolicy = {
    allTraceSearches: ["长期债务达到历史最高水平"],
    factChainTerms: ["短期借款 + 492.29亿元"],
    factEvidenceGroups: [{
      id: "answer-fact-1",
      sourceQuote: "| **短期借款** | 为492.29亿元 |",
      anchors: ["短期借款", "492.29亿元"],
      match: "all_anchors_in_one_evidence",
    }],
    requireFinalGenerationOutput: true,
  };
  const steps = [{ spanId: "final", spanType: "GENERATION" }];
  const ledger = { entries: [
    entry("search_trace", { query: "长期债务达到历史最高水平", scope: "all" }, { hits: [], totalMatches: 0 }),
    { evidenceId: "EV-FINAL", tool: "get_span_content", arguments: {}, result: {
      span: { spanId: "final", spanType: "GENERATION" }, field: "output",
      content: "| **短期借款** | 为492.29亿元，较去年增长 |",
    } },
  ] };
  const result = evaluateInvestigationCoverage(ledger, { policy: groupedPolicy, executionSteps: steps });
  assert.equal(result.complete, true);
  assert.deepEqual(result.checks.find((item) => item.details?.factGroupId)?.details.evidenceIds, ["EV-FINAL"]);
});
