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

function uniqueTerms(values) {
  const seen = new Set();
  const terms = values.map((value) => String(value ?? "").trim().replace(/的$/u, ""))
    .filter((value) => {
      const key = value.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLocaleLowerCase();
      // A one-digit official GT such as "9" is a complete scored fact, not a
      // noisy one-character language fragment. Preserve explicit numbers while
      // retaining the old minimum length for ordinary lexical terms.
      const explicitNumber = /^[-+]?\d+(?:\.\d+)?$/u.test(value.trim());
      if ((!explicitNumber && key.length < 2) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return terms.filter((term) => {
    const normalized = term.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLocaleLowerCase();
    if (/^-?\d/.test(normalized)) return true;
    return !terms.some((other) => {
      if (other === term) return false;
      const longer = other.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLocaleLowerCase();
      return longer.length > normalized.length && longer.includes(normalized);
    });
  });
}

/**
 * Convert one grounded GT excerpt into compact literal search atoms. This is
 * deliberately lexical: it never invents a synonym. Quoted labels, explicit
 * aliases, dates/numbers and relation-separated phrases remain exact source
 * substrings, so a long GT sentence is not one brittle search requirement.
 */
export function deriveAtomicSearchTerms(value) {
  // Strip a real list ordinal ("1. text" / "1、text") without consuming
  // the integer part of a decimal GT such as 11.59 or 8.23.
  const source = String(value ?? "").trim().replace(/^\s*\d+(?:[、)）]|[.．](?!\d))\s*/, "");
  if (!source) return [];
  const quoted = [...source.matchAll(/[“"]([^”"]{2,80})[”"]/g)].map((match) => match[1]);
  const aliases = splitExplicitAliases(source).filter((item) => item !== source);
  const normalized = source
    .replace(/[“"]/g, "").replace(/[”"]/g, "")
    .replace(/[（(]或[^）)]+[）)]/g, "")
    .replace(/(?:在|于)(?=\d{1,4}年|\d{1,2}月)/g, "|")
    .replace(/(?<=客户|用户|人群|主体)(?:在|于)/g, "|")
    .replace(/(?:用于|购买|住在|升到|降到|达到|增至|降至)/g, "|")
    .replace(/(?=占比|通过率|发起率|满意度|关注度)/g, "|")
    .replace(/(?:较|比)(?=\d)/g, "|");
  const clauses = normalized.split(/[|，,；;。\n]/).map((item) => item.trim()).filter(Boolean);
  const compact = [];
  for (const clause of clauses) {
    if ([...clause].length <= 28) {
      compact.push(clause);
      continue;
    }
    compact.push(...[...clause.matchAll(/[\p{Script=Han}A-Za-z-]{2,18}(?:客户|用户|人群|主体|产品|贷款|工单|标签|字段|方案|问题|场景)/gu)].map((match) => match[0]));
    compact.push(...(clause.match(/-?\d[\d,.]*(?:个百分点|亿元|万元|小时|分钟|万|亿|元|%|月|年|笔|张|人|个|次|条)?/g) ?? []));
    compact.push(...clause.split(/的|且|并且|以及/).map((item) => item.trim()).filter((item) => [...item].length >= 2 && [...item].length <= 28));
  }
  const relationTerms = source.match(/增多|上升|下降|提高|降低|高关注高满意|高关注低满意/g) ?? [];
  return uniqueTerms([...quoted, ...aliases, ...compact, ...relationTerms]).slice(0, 12);
}

const NON_ANALYSIS_TOOLS = new Set(["write_file", "lark_doc", "final_output_prepare"]);

function toolInventory(overview = {}) {
  return new Set((overview.executionNames ?? overview.toolNames ?? []).map((item) => typeof item === "string" ? item : item?.name).filter(Boolean));
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
    .map((item, index) => ({
      id: `required-fact-${index + 1}`,
      sourceExcerpt: item.source.excerpt,
      atoms: deriveAtomicSearchTerms(item.source.excerpt),
    }))
    .filter((item) => item.atoms.length);
  // requiredButNotPresent is model-authored explanatory prose. It is useful
  // context for investigation, but it is not source-grounded enough to become
  // an exact deterministic search contract. Only validated GT excerpts may
  // create mandatory all-Trace searches.
  const groundedQuotes = (target.answerState?.relevantExcerpts ?? []).map((item) => item?.quote).filter(Boolean);
  const summarizedPresentText = (target.difference?.presentAndRelevant ?? []).filter(Boolean);

  const allTraceSearches = [...new Set(requiredExcerpts.flatMap((item) => item.atoms))].filter((item) => item.length <= 160);
  const factEvidenceGroups = (groundedQuotes.length ? groundedQuotes : summarizedPresentText)
    .map((quote, index) => buildFactEvidenceGroup(quote, index))
    .filter((group) => group.anchors.length);
  // Kept as a compact human-readable compatibility field. Coverage uses the
  // structured groups whenever present.
  const factChainTerms = factEvidenceGroups.map((group) => group.anchors.join(" + "));
  if (!allTraceSearches.length) throw new Error("Unable to derive missing-fact Trace searches from the validated scoring gap");

  const tools = toolInventory(overview);
  const schemaToolNames = ["aeolus_data_set_insight"].filter((name) => tools.has(name));
  const executionToolNames = ["aeolus_sql_query"].filter((name) => tools.has(name));
  const executionToolCandidates = [...tools].filter((name) => !NON_ANALYSIS_TOOLS.has(name) && !schemaToolNames.includes(name));

  return {
    allTraceSearches,
    requiredFactSearchGroups: requiredExcerpts,
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
    allowNoActualAnswerFacts: factEvidenceGroups.length === 0,
    derived: true,
  };
}
