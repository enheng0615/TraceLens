import assert from "node:assert/strict";
import test from "node:test";
import { TraceRepository } from "../../src/rca/trace-repository.mjs";
import { EvidenceLedger } from "../../src/rca/evidence-ledger.mjs";
import { executeTraceTool } from "../../src/rca/trace-tools.mjs";
import { validateCausalClosure, scopeCausalFindings, materializeLocationEvidence } from "../../src/rca/causal-closure.mjs";

function repository() {
  return new TraceRepository({ root: ".", relations: new Map(), manifest: null, integrity: null, spans: [
    { id: "g", traceId: "t", spanType: "GENERATION", startTime: 10,
      input: JSON.stringify({ tools: [{ type: "function", function: { name: "query", description: "Historical definition", parameters: { properties: { filters: { description: "single snapshot" } } } } }] }),
      output: JSON.stringify({ tool_calls: [{ id: "c", function: { name: "query", arguments: '{"filters":[1,2]}' } }] }) },
    { id: "tool", traceId: "t", spanType: "TOOL", name: "query", startTime: 20,
      input: JSON.stringify({ call_id: "c", arguments: { filters: [1, 2], custom_key: "visible" } }), output: JSON.stringify({ values: [1, 2], total: 4 }) },
    { id: "next", traceId: "t", spanType: "GENERATION", startTime: 30, input: JSON.stringify({ messages: [{ role: "tool", tool_call_id: "c", content: '{"values":[1,2],"total":4}' }] }), output: "answer" },
  ] });
}

test("links historical definition, emitted call and exact received result by call ID", async () => {
  const r = repository();
  const result = await executeTraceTool(r, { tool: "get_tool_call_bundle", arguments: { spanId: "tool" } });
  assert.equal(result.status, "call_linked");
  assert.equal(result.historicalDefinition.definition.value.description, "Historical definition");
  const nested = await executeTraceTool(r, { tool: "get_json_field", arguments: { spanId: "g", field: "output", pointer: "/tool_calls/0/function/arguments/filters", decodeJsonStrings: true } });
  assert.deepEqual(nested.value, [1, 2]);
  assert.equal(nested.evidenceRef.decoding.length, 2);
  assert.equal(result.consumers[0].bodyEqualsRawReturn, true);
  r.byId.get("g").output = JSON.stringify({ content: JSON.stringify({ constraint_verification_enabled: false }) });
  const contract = await executeTraceTool(r, { tool: "get_generation_contract", arguments: { spanId: "g" } });
  assert.equal(contract.decisionFields[0].pointer, "/content/constraint_verification_enabled");
  assert.ok(result.unavailableLayers.includes("effective_backend_parameters"));
  r.byId.get("tool").input = JSON.stringify({ call_id: "missing", arguments: {} });
  assert.equal((await executeTraceTool(r, { tool: "get_tool_definition_at_call", arguments: { spanId: "tool" } })).status, "unobservable");
});

test("keeps arbitrary request keys in model context and compares exact recorded fields", async () => {
  const r = repository(), ledger = new EvidenceLedger();
  ledger.add({ tool: "get_tool_exchange", arguments: { spanId: "tool" }, result: r.getToolExchange({ spanId: "tool" }) });
  const ctx = ledger.toModelContext();
  assert.deepEqual(ctx.detailedEntries[0].result.request.filters, [1, 2]);
  assert.equal(ctx.detailedEntries[0].result.request.custom_key, "visible");
  const check = await executeTraceTool(r, { tool: "check_data_invariant", arguments: {
    kind: "sum_equals", left: { spanId: "tool", field: "output", pointer: "/values" }, right: { spanId: "tool", field: "output", pointer: "/total" },
  } });
  assert.equal(check.passed, false);
  assert.equal(check.causalIntervention, false);
});

test("rejects invented field locations and unbacked causal confidence", async () => {
  const r = repository(), ledger = new EvidenceLedger();
  const args = { spanId: "tool", field: "input", pointer: "/arguments/filters" };
  const field = await executeTraceTool(r, { tool: "get_json_field", arguments: args });
  const ev = ledger.add({ tool: "get_json_field", arguments: args, result: field });
  const contract = ledger.add({ tool: "get_tool_definition_at_call", arguments: { spanId: "tool" }, result: await executeTraceTool(r, { tool: "get_tool_definition_at_call", arguments: { spanId: "tool" } }) });
  const finding = { status: "localized_unverified", location: { ...args, fieldSha256: field.fieldSha256 }, evidenceIds: [ev.evidenceId], expectedBehavior: "one snapshot", contractEvidenceIds: [contract.evidenceId] };
  assert.equal(validateCausalClosure({ causalFindings: [finding] }, ledger, r).valid, true);
  assert.equal(validateCausalClosure({ causalFindings: [{ ...finding, status: "mechanism_supported" }] }, ledger, r).valid, false);
  assert.equal(validateCausalClosure({ causalFindings: [finding], rootCauseAssessment: { confidence: "medium-high" } }, ledger, r).valid, false);
  assert.equal(validateCausalClosure({ causalFindings: [{ ...finding, location: { ...finding.location, fieldSha256: "invented" } }] }, ledger, r).valid, false);
});

test("text locations bind exact source reads and unresolved alternatives remain explicitly unverified", () => {
  const r = repository(), ledger = new EvidenceLedger();
  const report = { causalFindings: [{ status: "mechanism_supported", location: { spanId: "next", field: "output", quote: "answer" },
    evidenceIds: [], expectedBehavior: "source contract", contractEvidenceIds: [], alternatives: [{ status: "possible" }] }] };
  const added = materializeLocationEvidence(report, ledger, r);
  assert.equal(added.length, 1);
  assert.equal(scopeCausalFindings(report).length, 1);
  assert.equal(report.causalFindings[0].status, "localized_unverified");
  assert.deepEqual(materializeLocationEvidence(report, ledger, r), []);
  const contract = ledger.add({ tool: "get_span_content", arguments: {}, result: r.getSpanContent({ spanId: "g", field: "input" }) });
  report.causalFindings[0].contractEvidenceIds = [contract.evidenceId];
  const result = validateCausalClosure(report, ledger, r);
  assert.equal(result.valid, true);
  assert.equal(report.causalFindings[0].location.startOffset, 0);
  assert.equal(report.causalFindings[0].contractAvailability, "available_before_call");
  r.byId.get("next").spanType = "AGENT";
  assert.equal(validateCausalClosure(report, ledger, r).status, "symptom_only");
});
