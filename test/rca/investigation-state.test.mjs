import assert from "node:assert/strict";
import test from "node:test";
import {
  actionSubjectKey,
  closeCoverageAsUnobservable,
  coverageSignature,
  isSubstantiveTraceEvidence,
  updateStallCount,
  workingState,
} from "../../src/rca/investigation-state.mjs";

test("normalizes action subjects and detects no-progress rounds", () => {
  assert.equal(actionSubjectKey({ tool: "get_span_content", arguments: { spanId: "s1", field: "output", start: 10 } }), "get_span_content:s1:output:10");
  const coverage = { checks: [{ description: "search GT", ok: false }], missing: ["search GT"] };
  const updated = updateStallCount({ previousEvidenceCount: 3, evidenceCount: 3, previousCoverageSignature: coverageSignature(coverage), coverage, stallCount: 1 });
  assert.deepEqual(updated, { progressed: false, stallCount: 2 });
  assert.match(workingState({ coverage, stallCount: 2 }).instruction, /unobservable/);
});

test("irrelevant new evidence does not reset a stable coverage stall", () => {
  const coverage = { checks: [{ description: "search GT", ok: false }], missing: ["search GT"] };
  const result = updateStallCount({
    previousEvidenceCount: 3,
    evidenceCount: 4,
    previousCoverageSignature: coverageSignature(coverage),
    coverage,
    stallCount: 2,
    newEvidenceEntries: [{ tool: "search_trace", result: { totalMatches: 0 } }],
  });
  assert.deepEqual(result, { progressed: false, stallCount: 3 });
});

test("new non-empty raw Trace evidence resets a stable coverage stall", () => {
  const coverage = { checks: [{ description: "search GT", ok: false }], missing: ["search GT"] };
  const evidence = { tool: "get_tool_exchange", result: { request: { code: "print(1)" }, response: "1" } };
  assert.equal(isSubstantiveTraceEvidence(evidence), true);
  const result = updateStallCount({
    previousEvidenceCount: 3,
    evidenceCount: 4,
    previousCoverageSignature: coverageSignature(coverage),
    coverage,
    stallCount: 2,
    newEvidenceEntries: [evidence],
  });
  assert.deepEqual(result, { progressed: true, stallCount: 0 });
});

test("new evidence bound to a required fact is useful progress", () => {
  const before = { checks: [{ description: "locate answer fact", ok: false, details: { evidenceIds: [] } }] };
  const after = { checks: [{ description: "locate answer fact", ok: false, details: { evidenceIds: ["EV-9"], matchedAnchors: [{ anchor: "金额", evidenceIds: ["EV-9"] }] } }] };
  const result = updateStallCount({
    previousEvidenceCount: 3, evidenceCount: 4, previousCoverageSignature: coverageSignature(before), coverage: after, stallCount: 2,
  });
  assert.deepEqual(result, { progressed: true, stallCount: 0 });
});

test("closes unresolved checks as explicit unobservable evidence boundary", () => {
  const result = closeCoverageAsUnobservable({
    complete: false, missing: ["read unavailable tool output"],
    checks: [{ ok: false, description: "read unavailable tool output" }],
  }, "three no-progress rounds");
  assert.equal(result.complete, true);
  assert.equal(result.forcedEvidenceBoundary, true);
  assert.deepEqual(result.originalMissing, ["read unavailable tool output"]);
  assert.equal(result.checks[0].disposition, "unobservable");
});
