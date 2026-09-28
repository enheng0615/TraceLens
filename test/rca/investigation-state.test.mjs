import assert from "node:assert/strict";
import test from "node:test";
import { actionSubjectKey, coverageSignature, updateStallCount, workingState } from "../../src/rca/investigation-state.mjs";

test("normalizes action subjects and detects no-progress rounds", () => {
  assert.equal(actionSubjectKey({ tool: "get_span_content", arguments: { spanId: "s1", field: "output", start: 10 } }), "get_span_content:s1:output");
  const coverage = { checks: [{ description: "search GT", ok: false }], missing: ["search GT"] };
  const updated = updateStallCount({ previousEvidenceCount: 3, evidenceCount: 3, previousCoverageSignature: coverageSignature(coverage), coverage, stallCount: 1 });
  assert.deepEqual(updated, { progressed: false, stallCount: 2 });
  assert.match(workingState({ coverage, stallCount: 2 }).instruction, /unobservable/);
});

test("irrelevant new evidence does not reset a stable coverage stall", () => {
  const coverage = { checks: [{ description: "search GT", ok: false }], missing: ["search GT"] };
  const result = updateStallCount({ previousEvidenceCount: 3, evidenceCount: 9, previousCoverageSignature: coverageSignature(coverage), coverage, stallCount: 2 });
  assert.deepEqual(result, { progressed: false, stallCount: 3 });
});
