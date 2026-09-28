const REQUIRED_TEXT_FIELDS = ["caseId", "sessionId", "query", "machineGrading", "idaAnswer"];

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`RCA case ${field} must be a non-empty string`);
}

function requireStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`RCA case ${field} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  value.forEach((item, index) => requireText(item, `${field}[${index}]`));
}

function normalizeFactEvidenceGroups(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("RCA case investigationPolicy.factEvidenceGroups must be an array");
  return value.map((group, index) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(`RCA case investigationPolicy.factEvidenceGroups[${index}] must be an object`);
    }
    requireText(group.id, `investigationPolicy.factEvidenceGroups[${index}].id`);
    requireText(group.sourceQuote, `investigationPolicy.factEvidenceGroups[${index}].sourceQuote`);
    requireStringArray(group.anchors, `investigationPolicy.factEvidenceGroups[${index}].anchors`, { allowEmpty: false });
    return {
      id: group.id,
      sourceQuote: group.sourceQuote,
      anchors: [...new Set(group.anchors)],
      match: "all_anchors_in_one_evidence",
    };
  });
}

/**
 * Validate and normalize the public RCA case contract.
 * The first production version intentionally analyzes one official missed item
 * per run. Callers should fan out a multi-GT case into multiple runs.
 */
export function validateRcaCase(caseData) {
  if (!caseData || typeof caseData !== "object" || Array.isArray(caseData)) {
    throw new Error("RCA case must be a JSON object");
  }
  for (const field of REQUIRED_TEXT_FIELDS) requireText(caseData[field], field);
  if (!Array.isArray(caseData.officialMissedCriteria) || caseData.officialMissedCriteria.length !== 1) {
    throw new Error("RCA case officialMissedCriteria must contain exactly one missed criterion per run");
  }
  const criterion = caseData.officialMissedCriteria[0];
  requireText(criterion?.id, "officialMissedCriteria[0].id");
  requireText(criterion?.text, "officialMissedCriteria[0].text");
  requireText(criterion?.officialVerdict, "officialMissedCriteria[0].officialVerdict");
  if (caseData.traceEvidenceBoundary !== undefined) {
    const boundary = caseData.traceEvidenceBoundary;
    if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
      throw new Error("RCA case traceEvidenceBoundary must be an object when provided");
    }
    if (!["complete", "partial_analyzable", "partial_critical"].includes(boundary.classification)) {
      throw new Error("RCA case traceEvidenceBoundary.classification is invalid");
    }
    if (boundary.analysisAllowed !== true) {
      throw new Error("RCA case traceEvidenceBoundary does not allow analysis");
    }
  }

  const policy = caseData.investigationPolicy;
  let normalizedPolicy;
  if (policy !== undefined) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error("RCA case investigationPolicy must be an object when provided");
    }
    requireStringArray(policy.allTraceSearches, "investigationPolicy.allTraceSearches", { allowEmpty: false });
    if (policy.factChainTerms !== undefined) {
      requireStringArray(policy.factChainTerms, "investigationPolicy.factChainTerms", { allowEmpty: false });
    }
    if (policy.factEvidenceGroups === undefined && policy.factChainTerms === undefined) {
      throw new Error("RCA case investigationPolicy requires factEvidenceGroups or factChainTerms");
    }
    const arrayFields = [
      "schemaToolNames",
      "executionToolNames",
      "executionToolCandidates",
      "requiredToolSpanIds",
      "artifactToolSpanIds",
    ];
    for (const field of arrayFields) {
      if (policy[field] !== undefined) requireStringArray(policy[field], `investigationPolicy.${field}`);
    }
    normalizedPolicy = {
      allTraceSearches: [...new Set(policy.allTraceSearches)],
      factChainTerms: [...new Set(policy.factChainTerms ?? [])],
      ...(policy.factEvidenceGroups !== undefined
        ? { factEvidenceGroups: normalizeFactEvidenceGroups(policy.factEvidenceGroups) }
        : {}),
      requireToolInventory: policy.requireToolInventory !== false,
      requireToolQueryInventory: policy.requireToolQueryInventory === true,
      schemaToolNames: [...new Set(policy.schemaToolNames ?? [])],
      executionToolNames: [...new Set(policy.executionToolNames ?? [])],
      requireAnyExecutionTool: policy.requireAnyExecutionTool === true,
      executionToolCandidates: [...new Set(policy.executionToolCandidates ?? [])],
      requiredToolSpanIds: [...new Set(policy.requiredToolSpanIds ?? [])],
      artifactToolSpanIds: [...new Set(policy.artifactToolSpanIds ?? [])],
      requireFinalGenerationOutput: policy.requireFinalGenerationOutput !== false,
    };
  }

  return {
    ...caseData,
    schemaVersion: caseData.schemaVersion || "rca-case-v1",
    ...(normalizedPolicy ? { investigationPolicy: normalizedPolicy } : {}),
  };
}
