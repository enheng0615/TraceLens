import { buildFactEvidenceGroup } from "./fact-evidence.mjs";

function splitExplicitAliases(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const aliases = new Set([text]);
  // Only explicit “或” syntax denotes aliases. Ordinary explanatory
  // parentheses in answer quotes must never become extra requirements.
  for (const match of text.matchAll(/([^（(]+)[（(]或([^）)]+)[）)]/g)) {
    aliases.add(match[1].trim());
    aliases.add(match[2].trim());
  }
  return [...aliases].filter(Boolean);
}

const NON_ANALYSIS_TOOLS = new Set(["write_file", "lark_doc", "final_output_prepare"]);

function toolInventory(overview = {}) {
  return new Set((overview.toolNames ?? []).map((item) => typeof item === "string" ? item : item?.name).filter(Boolean));
}

function artifactSpanIds(caseData, executionSteps = []) {
  const declared = [caseData.inputProvenance?.artifactToolSpanId, caseData.inputProvenance?.publishToolSpanId].filter(Boolean);
  if (declared.length) return [...new Set(declared)];
  return executionSteps
    .filter((step) => step.spanType === "TOOL" && ["write_file", "lark_doc"].includes(step.name))
    .map((step) => step.spanId);
}

/** Build a neutral minimum evidence contract from the gap and actual Trace inventory. */
export function buildInvestigationPolicy(caseData, target, { overview = {}, executionSteps = [] } = {}) {
  if (caseData.investigationPolicy) return caseData.investigationPolicy;

  const requiredExcerpts = (target.requiredState?.elements ?? [])
    .filter((item) => item?.source?.type === "ground_truth")
    .flatMap((item) => splitExplicitAliases(item.source.excerpt));
  // requiredButNotPresent is model-authored explanatory prose. It is useful
  // context for investigation, but it is not source-grounded enough to become
  // an exact deterministic search contract. Only validated GT excerpts may
  // create mandatory all-Trace searches.
  const groundedQuotes = (target.answerState?.relevantExcerpts ?? []).map((item) => item?.quote).filter(Boolean);
  const summarizedPresentText = (target.difference?.presentAndRelevant ?? []).filter(Boolean);

  const allTraceSearches = [...new Set(requiredExcerpts)].filter((item) => item.length <= 160);
  const factEvidenceGroups = (groundedQuotes.length ? groundedQuotes : summarizedPresentText)
    .map((quote, index) => buildFactEvidenceGroup(quote, index))
    .filter((group) => group.anchors.length);
  // Kept as a compact human-readable compatibility field. Coverage uses the
  // structured groups whenever present.
  const factChainTerms = factEvidenceGroups.map((group) => group.anchors.join(" + "));
  if (!allTraceSearches.length) throw new Error("Unable to derive missing-fact Trace searches from the validated scoring gap");
  if (!factEvidenceGroups.length) throw new Error("Unable to derive actual-answer fact evidence groups from the validated scoring gap");

  const tools = toolInventory(overview);
  const schemaToolNames = ["aeolus_data_set_insight"].filter((name) => tools.has(name));
  const executionToolNames = ["aeolus_sql_query"].filter((name) => tools.has(name));
  const executionToolCandidates = [...tools].filter((name) => !NON_ANALYSIS_TOOLS.has(name) && !schemaToolNames.includes(name));

  return {
    allTraceSearches,
    factChainTerms,
    factEvidenceGroups,
    requireToolInventory: true,
    requireToolQueryInventory: tools.has("aeolus_sql_query"),
    schemaToolNames,
    executionToolNames,
    requireAnyExecutionTool: executionToolCandidates.length > 0 && executionToolNames.length === 0,
    executionToolCandidates,
    artifactToolSpanIds: artifactSpanIds(caseData, executionSteps),
    requireFinalGenerationOutput: executionSteps.some((step) => step.spanType === "GENERATION"),
    derived: true,
  };
}
