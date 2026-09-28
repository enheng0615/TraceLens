import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { TraceRepository, traceText } from "../../src/rca/trace-repository.mjs";

const root = path.resolve("test_data/29785869/full-raw");

test("builds an objective overview and primary execution map", async () => {
  const repository = await TraceRepository.open(root);
  const overview = repository.getOverview();
  assert.equal(overview.spanCount, 144);
  assert.equal(overview.typeCounts.AGENT, 1);
  assert.equal(overview.typeCounts.GENERATION, 14);
  assert.equal(overview.typeCounts.TOOL, 16);
  assert.equal(overview.integrity.result, "complete_no_observed_truncation");
  const steps = repository.listExecutionSteps();
  assert.equal(steps.length, 31);
  assert.equal(steps[0].spanType, "AGENT");
  assert.equal(steps.at(-1).spanId, "42c3c1457afb17c9");
});

test("searches complete raw fields and keeps verifiable references", async () => {
  const repository = await TraceRepository.open(root);
  const result = repository.search({ query: "Self-Employed", scope: "all" });
  assert.equal(result.coverage.searchedSpans, 144);
  assert.equal(result.coverage.searchedFields, 288);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.totalMatches, 0);

  const field = repository.search({ query: "就业状况", scope: "all" });
  assert.ok(field.totalMatches > 0);
  const first = field.hits[0];
  const span = repository.byId.get(first.spanId);
  assert.equal(first.contentSha256, traceText.sha256(span[first.field]));
});

test("lists every SQL query and exposes the schema Tool exchange", async () => {
  const repository = await TraceRepository.open(root);
  const queries = repository.listToolQueries();
  assert.equal(queries.length, 11);
  assert.equal(queries.some((item) => item.sql.includes("`就业状况`")), false);
  const schema = repository.getToolExchange({ spanId: "3d1358b5940c2b9a" });
  assert.match(schema.response, /`就业状况`/);
});
