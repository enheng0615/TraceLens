import { createHash } from "node:crypto";

const FORBIDDEN_KEYS = new Set([
  "gapType", "rootCause", "rootCauseType", "skillIssue",
  "toolIssue", "classification", "hypothesis",
]);

// “因” and “导致” may be literal IDA/grader language or merely describe an
// official scoring outcome. Before Trace inspection reject only explicit
// execution-root-cause hypotheses; source identity is verified separately.
const PRE_TRACE_ROOT_CAUSE_TERMS = [
  "根因", "因为工具", "skill问题", "tool问题", "工具调用错误",
  "模型遗忘", "上下文截断", "规划错误",
];

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visitor, [...path, index]));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, child]) => {
      // These are validator-produced provenance records. Their content may
      // legitimately quote causal words from the grader or IDA, so a resumed
      // normalized target must not reclassify those quotes as model-authored.
      if (path.length === 0 && ["sourceRegistry", "sourceAttribution"].includes(childKey)) return;
      walk(child, visitor, [...path, childKey]);
    });
  }
}

function isGroundedSourcePath(path) {
  if (path[0] === "criterion") return true;
  if (path[0] === "requiredState" && path[1] === "elements" && path[3] === "source") return true;
  return path[0] === "answerState" && path[1] === "relevantExcerpts" && path[3] === "quote";
}

const IGNORABLE_DISPLAY_CHARS = new Set(["*", "_", "~", "`", " ", "\t", "\r", "\n"]);

function normalizeDisplayText(value) {
  const normalized = [];
  const originalOffsets = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (IGNORABLE_DISPLAY_CHARS.has(char)) continue;
    normalized.push(char);
    originalOffsets.push(index);
  }
  return { text: normalized.join(""), originalOffsets };
}

/** Resolve a candidate quote to one exact raw-answer substring. */
export function locateAnswerQuote(text, quote) {
  const exactIndex = text.indexOf(quote);
  if (exactIndex !== -1) {
    return { quote, startOffset: exactIndex, endOffset: exactIndex + quote.length, alignment: "exact", modelQuote: quote };
  }
  const normalizedText = normalizeDisplayText(text);
  const normalizedQuote = normalizeDisplayText(quote).text;
  if (!normalizedQuote) return null;
  const matches = [];
  let cursor = 0;
  while (cursor <= normalizedText.text.length) {
    const matchIndex = normalizedText.text.indexOf(normalizedQuote, cursor);
    if (matchIndex === -1) break;
    matches.push(matchIndex);
    cursor = matchIndex + 1;
  }
  if (matches.length !== 1) return null;
  const normalizedStart = matches[0];
  const normalizedEnd = normalizedStart + normalizedQuote.length - 1;
  const startOffset = normalizedText.originalOffsets[normalizedStart];
  const endOffset = normalizedText.originalOffsets[normalizedEnd] + 1;
  return { quote: text.slice(startOffset, endOffset), startOffset, endOffset, alignment: "display_normalized_unique", modelQuote: quote };
}

function sourceRecord({ id, sourceType, document, text, startOffset, endOffset, jsonPath }) {
  return {
    id, sourceType, document, text,
    ...(Number.isInteger(startOffset) ? { startOffset, endOffset } : {}),
    ...(jsonPath ? { jsonPath } : {}),
    sha256: sha256(text),
  };
}

function locateSourceExcerpt(sourceText, excerpt) {
  const startOffset = String(sourceText ?? "").indexOf(String(excerpt ?? ""));
  return startOffset === -1 ? null : { startOffset, endOffset: startOffset + String(excerpt).length };
}

/**
 * Validate model-selected quotes, then replace model-authored pre-Trace prose
 * with a deterministic neutral contract. Every retained statement receives a
 * source identity. Causal interpretation remains forbidden until EV evidence
 * exists, while causal words copied from IDA/grader text remain valid quotes.
 */
export function validateScoringGapTarget(target, caseData) {
  const errors = [];
  const criterion = caseData.officialMissedCriteria[0];
  if (target?.criterion?.text !== criterion.text) errors.push("criterion.text must exactly equal the official missed criterion");
  if (target?.criterion?.officialVerdict !== criterion.officialVerdict) errors.push("official verdict changed");
  walk(target, (value, path) => {
    const key = path.at(-1);
    if (FORBIDDEN_KEYS.has(key)) errors.push(`forbidden pre-Trace causal field: ${path.join(".")}`);
    if (
      !isGroundedSourcePath(path) && typeof value === "string" &&
      PRE_TRACE_ROOT_CAUSE_TERMS.some((term) => value.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
    ) errors.push(`pre-Trace generated text contains root-cause hypothesis: ${path.join(".")}`);
  });

  const sourceRegistry = [];
  const normalizedElements = [];
  for (const [index, element] of (target?.requiredState?.elements ?? []).entries()) {
    const excerpt = element?.source?.excerpt;
    const sourceType = element?.source?.type;
    const sourceText = sourceType === "query" ? caseData.query : criterion.text;
    const located = excerpt ? locateSourceExcerpt(sourceText, excerpt) : null;
    if (!located || !["query", "ground_truth"].includes(sourceType)) {
      errors.push(`requiredState excerpt is not grounded: ${excerpt}`);
      continue;
    }
    const sourceId = `SRC-${sourceType === "query" ? "QUERY" : "GT"}-${String(index + 1).padStart(3, "0")}`;
    sourceRegistry.push(sourceRecord({
      id: sourceId,
      sourceType: sourceType === "query" ? "query_quote" : "ground_truth_quote",
      document: sourceType === "query" ? "query" : "official_missed_criterion",
      text: excerpt, ...located,
    }));
    normalizedElements.push({ description: `要求呈现：${excerpt}`, source: { ...element.source, sourceId } });
  }

  const resolvedExcerpts = [];
  const quoteAlignments = [];
  for (const [index, item] of (target?.answerState?.relevantExcerpts ?? []).entries()) {
    const located = locateAnswerQuote(caseData.idaAnswer, item.quote);
    if (!located) {
      errors.push(`IDA answer quote cannot be uniquely aligned to raw answer: ${item.quote}`);
      continue;
    }
    const sourceId = `SRC-IDA-${String(index + 1).padStart(3, "0")}`;
    resolvedExcerpts.push({ quote: located.quote, startOffset: located.startOffset, endOffset: located.endOffset, sourceId });
    sourceRegistry.push(sourceRecord({ id: sourceId, sourceType: "ida_answer_quote", document: "ida_answer", text: located.quote, startOffset: located.startOffset, endOffset: located.endOffset }));
    quoteAlignments.push({ modelQuote: located.modelQuote, exactRawQuote: located.quote, startOffset: located.startOffset, endOffset: located.endOffset, method: located.alignment, sourceId });
  }
  if (!target?.phenomenonToExplain) errors.push("phenomenonToExplain is required");

  const graderText = String(caseData.machineGrading ?? target?.criterion?.officialGraderReason ?? "");
  if (graderText) sourceRegistry.push(sourceRecord({ id: "SRC-GRADER-001", sourceType: "grader_claim", document: "machine_grading", text: graderText, jsonPath: caseData.inputProvenance?.machineGrading ?? "machineGrading" }));
  const requiredRefs = normalizedElements.map((element) => element.source.sourceId);
  const answerRefs = resolvedExcerpts.map((item) => item.sourceId);
  const requiredText = normalizedElements.map((item) => item.source.excerpt).filter(Boolean);
  const answerText = resolvedExcerpts.map((item) => item.quote);
  const normalizedTarget = {
    ...target,
    criterion: { id: String(criterion.id ?? target?.criterion?.id ?? "GT-1"), text: criterion.text, officialVerdict: criterion.officialVerdict, officialGraderReason: graderText, sourceRefs: graderText ? ["SRC-GRADER-001"] : [] },
    requiredState: { summary: `官方未命中项要求呈现：${criterion.text}`, elements: normalizedElements, sourceRefs: requiredRefs },
    answerState: { summary: answerText.length ? `IDA最终答案中与该评分项相关的原文共${answerText.length}处。` : "IDA最终答案中未定位到与该评分项直接相关的原文。", relevantExcerpts: resolvedExcerpts, sourceRefs: answerRefs },
    difference: { summary: "官方未命中项要求与IDA最终答案中已定位的相关原文存在差距。", requiredButNotPresent: requiredText.length ? requiredText : [criterion.text], presentAndRelevant: answerText, sourceRefs: [...requiredRefs, ...answerRefs], sourceType: "system_derived_gap" },
    phenomenonToExplain: `调查官方未命中项“${criterion.text}”在IDA运行轨迹中的信息生命周期，并重建最终答案已出现事实的生成链。`,
    sourceRegistry,
    sourceAttribution: {
      criterion: graderText ? ["SRC-GRADER-001"] : [], requiredState: requiredRefs, answerState: answerRefs,
      difference: { sourceType: "system_derived_gap", sourceRefs: [...requiredRefs, ...answerRefs] },
      phenomenonToExplain: { sourceType: "system_generated_investigation_contract", sourceRefs: [...requiredRefs, ...answerRefs] },
    },
  };
  return { valid: errors.length === 0, errors, quoteAlignments, target: errors.length ? target : normalizedTarget };
}

export function scoringGapPrompt(caseData) {
  return `请从以下官方评分输入中只定位来源，不做归因。评分结论是权威输入，不得重新评分，不得质疑GT或评分器。此阶段没有Trace证据，因此不得写根因、假设、问题分类、Tool/Skill/模型判断。模型只负责选择精确原文；程序会生成最终中立差距并登记来源身份。\n\nQUERY:\n${caseData.query}\n\n官方未命中项:\n${JSON.stringify(caseData.officialMissedCriteria, null, 2)}\n\n官方机评说明:\n${caseData.machineGrading}\n\nIDA最终答案:\n${caseData.idaAnswer}\n\n只返回JSON，结构：\n{\n  "targetId":"target-gt-1",\n  "criterion":{"id":"GT-1","text":"必须逐字复制官方未命中项text","officialVerdict":"未命中","officialGraderReason":"机评原文"},\n  "requiredState":{"summary":"占位说明","elements":[{"description":"要求要素","source":{"type":"query或ground_truth","excerpt":"来源中的精确子串"}}]},\n  "answerState":{"summary":"占位说明","relevantExcerpts":[{"quote":"IDA答案中的精确连续子串"}]},\n  "difference":{"summary":"只写表面差异","requiredButNotPresent":[],"presentAndRelevant":[]},\n  "phenomenonToExplain":"只写需要调查的最终事实差异"\n}`;
}
