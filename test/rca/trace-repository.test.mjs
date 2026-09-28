import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TraceRepository, traceText } from "../../src/rca/trace-repository.mjs";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-repository-"));
  await mkdir(path.join(root, "spans", "details"), { recursive: true });
  await mkdir(path.join(root, "traces", "trees"), { recursive: true });
  const spans = [
    { id: "agent-1", traceId: "trace-1", sessionId: "session-1", spanType: "AGENT", name: "ida", status: "SUCCESS", startTime: 1, endTime: 10, input: "分析请求", output: "开始分析" },
    { id: "schema-1", traceId: "trace-1", sessionId: "session-1", spanType: "TOOL", name: "aeolus_data_set_insight", status: "SUCCESS", startTime: 2, endTime: 3, input: JSON.stringify({ arguments: { goal: "读取schema" } }), output: "字段：`就业状况`、贷款用途" },
    { id: "sql-1", traceId: "trace-1", sessionId: "session-1", spanType: "TOOL", name: "aeolus_sql_query", status: "SUCCESS", startTime: 4, endTime: 5, input: JSON.stringify({ arguments: { goal: "分析用途", instruction: "按用途聚合", ansi_sql: "SELECT loan_purpose, COUNT(*) FROM loans GROUP BY loan_purpose", output_file_prefix: "result" } }), output: "Debt Consolidation=304" },
    { id: "generation-1", traceId: "trace-1", sessionId: "session-1", spanType: "GENERATION", name: "model", status: "SUCCESS", startTime: 6, endTime: 9, input: "Schema包含就业状况", output: "Debt Consolidation增多" },
  ];
  for (const span of spans) await writeFile(path.join(root, "spans", "details", `${span.id}.json`), JSON.stringify({ data: span }));
  await writeFile(path.join(root, "traces", "trees", "trace-1.json"), JSON.stringify({ data: { id: "agent-1", childs: [
    { id: "schema-1", childs: [] }, { id: "sql-1", childs: [] }, { id: "generation-1", childs: [] },
  ] } }));
  await writeFile(path.join(root, "integrity-report.json"), JSON.stringify({ result: "complete_no_observed_truncation", counts: { spans: 4 }, expandedToolResults: { unresolvedSpanIds: [] } }));
  return root;
}

async function withRepository(callback) {
  const root = await createFixture();
  try { await callback(await TraceRepository.open(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test("builds an objective overview and primary execution map", async () => {
  await withRepository(async (repository) => {
    const overview = repository.getOverview();
    assert.equal(overview.spanCount, 4);
    assert.equal(overview.typeCounts.AGENT, 1);
    assert.equal(overview.typeCounts.GENERATION, 1);
    assert.equal(overview.typeCounts.TOOL, 2);
    assert.equal(overview.integrity.result, "complete_no_observed_truncation");
    const steps = repository.listExecutionSteps();
    assert.equal(steps.length, 4);
    assert.equal(steps[0].spanType, "AGENT");
    assert.equal(steps.at(-1).spanId, "generation-1");
  });
});

test("searches complete raw fields and keeps verifiable references", async () => {
  await withRepository(async (repository) => {
    const result = repository.search({ query: "Self-Employed", scope: "all" });
    assert.equal(result.coverage.searchedSpans, 4);
    assert.equal(result.coverage.searchedFields, 8);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.negativeEvidenceEligible, true);
    assert.equal(result.totalMatches, 0);
    const field = repository.search({ query: "就业状况", scope: "all" });
    assert.equal(field.totalMatches, 2);
    const first = field.hits[0];
    const span = repository.byId.get(first.spanId);
    assert.equal(first.contentSha256, traceText.sha256(span[first.field]));
  });
});

test("lists every SQL query and exposes the schema Tool exchange", async () => {
  await withRepository(async (repository) => {
    const queries = repository.listToolQueries();
    assert.equal(queries.length, 1);
    assert.equal(queries.some((item) => item.sql.includes("就业状况")), false);
    const schema = repository.getToolExchange({ spanId: "schema-1" });
    assert.match(schema.response, /`就业状况`/);
  });
});
