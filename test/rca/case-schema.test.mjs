import assert from "node:assert/strict";
import test from "node:test";
import { validateRcaCase } from "../../src/rca/case-schema.mjs";

function validCase() {
  return {
    caseId: "case-1",
    sessionId: "1",
    query: "q",
    machineGrading: "missed x",
    idaAnswer: "answer",
    officialMissedCriteria: [{ id: "GT-1", text: "x", officialVerdict: "未命中" }],
    investigationPolicy: {
      allTraceSearches: ["x"],
      factChainTerms: ["y"],
      factEvidenceGroups: [{ id: "fact-1", sourceQuote: "**Y** 1", anchors: ["Y", "1"] }],
    },
  };
}

test("normalizes the public single-criterion RCA contract", () => {
  const result = validateRcaCase(validCase());
  assert.equal(result.schemaVersion, "rca-case-v1");
  assert.deepEqual(result.investigationPolicy.schemaToolNames, []);
  assert.deepEqual(result.investigationPolicy.executionToolNames, []);
  assert.equal(result.investigationPolicy.requireFinalGenerationOutput, true);
  assert.deepEqual(result.investigationPolicy.factEvidenceGroups[0], {
    id: "fact-1", sourceQuote: "**Y** 1", anchors: ["Y", "1"], match: "all_anchors_in_one_evidence",
  });
});

test("accepts normal input without an internal policy and rejects multi-criterion input", () => {
  const missingPolicy = validCase();
  delete missingPolicy.investigationPolicy;
  assert.equal(validateRcaCase(missingPolicy).investigationPolicy, undefined);

  const multiple = validCase();
  multiple.officialMissedCriteria.push({ id: "GT-2", text: "z", officialVerdict: "未命中" });
  assert.throws(() => validateRcaCase(multiple), /exactly one/);
});


test("accepts a structured policy without legacy factChainTerms", () => {
  const result = validateRcaCase({
    caseId: "case-structured-policy",
    sessionId: "1",
    query: "q",
    machineGrading: "missed",
    idaAnswer: "answer",
    officialMissedCriteria: [{ id: "gt-1", text: "missing", officialVerdict: "missed" }],
    investigationPolicy: {
      allTraceSearches: ["missing"],
      factEvidenceGroups: [{ id: "fact-1", sourceQuote: "answer", anchors: ["answer"] }],
    },
  });
  assert.deepEqual(result.investigationPolicy.factChainTerms, []);
  assert.deepEqual(result.investigationPolicy.factEvidenceGroups[0].anchors, ["answer"]);
});
