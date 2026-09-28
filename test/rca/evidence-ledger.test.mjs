import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceLedger } from "../../src/rca/evidence-ledger.mjs";

test("model context is compact, bounded, and keeps every evidence id", () => {
  const ledger = new EvidenceLedger();
  for (let index = 0; index < 12; index += 1) {
    ledger.add({
      source: "agent",
      tool: "get_tool_exchange",
      arguments: { spanId: `span-${index}` },
      purpose: `purpose-${index}`,
      result: {
        spanId: `span-${index}`,
        name: "aeolus_sql_query",
        request: { arguments: { ansi_sql: "x".repeat(5000) } },
        response: "y".repeat(10000),
      },
    });
  }
  const context = ledger.toModelContext({ maxTotalChars: 12000 });
  assert.equal(context.totalEntries, 12);
  assert.ok(JSON.stringify(context).length <= 12000);
  assert.deepEqual(context.evidenceIndex.map((item) => typeof item === "string" ? item.split(":")[0] : item.evidenceId), ledger.entries.map((item) => item.evidenceId));
  assert.ok(context.omittedDetails > 0);
});

test("refreshes an existing result for model context without a new Trace read", () => {
  const ledger = new EvidenceLedger();
  const original = ledger.add({
    source: "agent",
    tool: "get_span_content",
    arguments: { spanId: "span-1", field: "output", start: 0, length: 12000 },
    purpose: "read once",
    result: { span: { spanId: "span-1" }, content: "important detail" },
  });
  const refreshed = ledger.refreshExisting({
    tool: "get_span_content",
    arguments: { spanId: "span-1", field: "output", start: 0, length: 12000 },
    purpose: "bring detail back into bounded context",
  });
  assert.equal(refreshed.source, "agent");
  assert.equal(refreshed.result, original.result);
  assert.equal(refreshed.evidenceId, original.evidenceId);
  assert.equal(refreshed.reused, true);
  assert.equal(refreshed.referenceCount, 2);
  assert.equal(ledger.entries.length, 1);
});

test("does not fabricate a refresh when no exact prior action exists", () => {
  const ledger = new EvidenceLedger();
  assert.equal(ledger.refreshExisting({ tool: "search_trace", arguments: { query: "x" } }), null);
  assert.equal(ledger.entries.length, 0);
});
