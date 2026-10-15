import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assessEmbeddedResultTruncation } from "./truncation-assessment.mjs";

const STRUCTURAL_WARNING_PATTERNS = [
  /pagination is incomplete/i,
  /count does not match/i,
  /IDs differ/i,
  /references a Trace absent/i,
  /Payload mismatch/i,
];
const LOCAL_TOOL_GAP_WARNING_PATTERNS = [
  /Unrecovered server-side truncation markers were detected/i,
];

function collectTreeIds(value, result = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectTreeIds(item, result));
  else if (value && typeof value === "object") {
    if (value.id) result.add(String(value.id));
    Object.values(value).forEach((item) => collectTreeIds(item, result));
  }
  return result;
}

async function assessTreeIndexDifference(traceRoot) {
  if (!traceRoot) return { safe: false, reason: "trace root unavailable" };
  try {
    const index = await readFile(path.join(traceRoot, "index", "spans.tsv"), "utf8");
    const listIds = new Set(index.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")[0]));
    const treeIds = new Set();
    const treeDir = path.join(traceRoot, "traces", "trees");
    for (const name of (await readdir(treeDir)).filter((item) => item.endsWith(".json"))) {
      collectTreeIds(JSON.parse(await readFile(path.join(treeDir, name), "utf8")), treeIds);
    }
    const missingFromTree = [...listIds].filter((id) => !treeIds.has(id));
    const extraInTree = [...treeIds].filter((id) => !listIds.has(id));
    const missing = [];
    for (const spanId of missingFromTree) {
      const span = await readSpan(traceRoot, spanId);
      missing.push({
        spanId, spanType: span?.spanType ?? null, toolName: span?.name ?? null,
        inputChars: String(span?.input ?? "").length,
        outputChars: String(span?.output ?? "").length,
        detailAvailable: Boolean(span),
      });
    }
    // Tree omission is analyzable only when every omitted node remains fully
    // available through Span Detail and none is an AGENT/GENERATION/TOOL node.
    const safe = missing.length > 0 && extraInTree.length === 0 && missing.every(
      (item) => item.detailAvailable && item.spanType === "SPAN",
    );
    return { safe, missing, extraInTree };
  } catch (error) {
    return { safe: false, reason: error.message };
  }
}

async function readSpan(traceRoot, spanId) {
  if (!traceRoot || !spanId) return null;
  try {
    const wrapper = JSON.parse(await readFile(path.join(traceRoot, "spans", "details", `${spanId}.json`), "utf8"));
    return wrapper?.data ?? wrapper;
  } catch {
    return null;
  }
}

function fieldFromPath(value) {
  const match = String(value ?? "").match(/\.(input|output)$/);
  return match?.[1] ?? "output";
}

function safeAttempt(attempt = {}) {
  return {
    status: attempt.status ?? "unknown",
    code: attempt.code ?? null,
    message: attempt.message ?? null,
  };
}

function hasLocalTruncationEvidence(span, attempt, signal) {
  const assessments = assessEmbeddedResultTruncation(span?.output, "$.data.output");
  if (assessments.length) {
    // Recheck the immutable Span Detail even when an older integrity report
    // recorded a failed download for a shortened display copy.
    return assessments.some((item) => item.classification === "source_payload_missing");
  }
  if (attempt) return true;
  // New integrity reports provide a signal excerpt. Older/minimal reports and
  // tests without one are treated conservatively as a real localized gap.
  if (signal?.signal === undefined) return true;
  if (span?.spanType !== "TOOL") return false;
  const output = String(span?.output ?? "");
  const terminalMarker = /(?:\[truncated\]|<truncated>|\.\.\.truncated(?: due to length limit)?)\s*$/i;
  try {
    const parsed = JSON.parse(output);
    return terminalMarker.test(String(parsed?.output ?? ""));
  } catch {
    return terminalMarker.test(output);
  }
}

/**
 * Convert a collector integrity report into an explicit RCA evidence boundary.
 * Any localized payload gap with otherwise complete structure is analyzable
 * under an explicit evidence boundary. Pagination, identity, count, and
 * cross-source mismatches remain critical because the execution graph itself
 * is then unknown.
 */
export async function buildTraceEvidenceBoundary({ traceRoot, integrity } = {}) {
  const report = integrity ?? {};
  const warnings = [...(report.warnings ?? [])];
  const treeDifference = warnings.some((warning) => /Span IDs differ between span list and trace trees/i.test(String(warning)))
    ? await assessTreeIndexDifference(traceRoot)
    : null;
  const structuralWarnings = warnings.filter((warning) =>
    STRUCTURAL_WARNING_PATTERNS.some((pattern) => pattern.test(String(warning))),
  ).filter((warning) => !(
    /Span IDs differ between span list and trace trees/i.test(String(warning)) && treeDifference?.safe
  ));
  const attempts = new Map(
    (report.expandedToolResults?.attempts ?? []).map((attempt) => [String(attempt.spanId), attempt]),
  );
  const signalBySpan = new Map();
  for (const signal of report.possibleTruncationSignals ?? []) {
    const spanId = String(signal?.spanId ?? "");
    if (!spanId || signalBySpan.has(spanId)) continue;
    signalBySpan.set(spanId, signal);
  }
  const unresolved = [...new Set((report.expandedToolResults?.unresolvedSpanIds ?? []).map(String))];
  const missingSegments = [];
  if (treeDifference?.safe) {
    for (const item of treeDifference.missing) {
      missingSegments.push({
        kind: "tree_topology_omission",
        spanId: item.spanId,
        spanType: item.spanType,
        toolName: item.toolName,
        field: "tree_membership",
        observedChars: item.inputChars + item.outputChars,
        recovery: { status: "available_in_span_detail", code: "TREE_NODE_DETAIL_AVAILABLE" },
        impact: "该辅助SPAN未进入Trace Tree，但Span Detail完整可读（input " + item.inputChars + "字符，output " + item.outputChars + "字符）",
      });
    }
  }
  for (const spanId of unresolved) {
    const span = await readSpan(traceRoot, spanId);
    const attempt = attempts.get(spanId);
    // Compatibility with integrity reports produced before marker detection
    // was restricted to the local Tool payload. Historical Generation inputs
    // often quote words such as "truncated" without losing this Span.
    const signal = signalBySpan.get(spanId);
    if (!hasLocalTruncationEvidence(span, attempt, signal)) continue;
    const field = fieldFromPath(signal?.path);
    const content = String(span?.[field] ?? "");
    const recovery = safeAttempt(attempt);
    missingSegments.push({
      kind: "truncated_tool_result",
      spanId,
      traceId: span?.traceId ?? null,
      spanType: span?.spanType ?? null,
      toolName: span?.name ?? null,
      field,
      observedChars: content.length,
      spanStatus: span?.status ?? null,
      recovery,
      impact: `完整${span?.name || span?.spanType || "Span"} ${field}不可见；当前仅能使用Sophon已保存的${content.length}字符截断内容`,
    });
  }

  const collectorResult = report.completeness ?? report.result ?? "unknown";
  const collectorClaimsComplete = report.complete === true || [
    "complete",
    "complete_no_observed_truncation",
    "complete_with_recovered_truncation",
  ].includes(collectorResult);
  const onlyLegacyLocalWarning = warnings.length > 0 &&
    warnings.every((warning) => LOCAL_TOOL_GAP_WARNING_PATTERNS.some((pattern) => pattern.test(String(warning)))) &&
    missingSegments.length === 0;
  const complete = (collectorClaimsComplete && warnings.length === 0 && missingSegments.length === 0) ||
    (structuralWarnings.length === 0 && onlyLegacyLocalWarning);
  const nonCriticalWarning = (warning) =>
    LOCAL_TOOL_GAP_WARNING_PATTERNS.some((pattern) => pattern.test(String(warning))) ||
    (treeDifference?.safe && /Span IDs differ between span list and trace trees/i.test(String(warning)));
  const onlyLocalRecoverableGaps = !complete &&
    structuralWarnings.length === 0 &&
    warnings.every(nonCriticalWarning) &&
    missingSegments.length > 0 &&
    missingSegments.every((segment) => segment.spanId && segment.field);
  const classification = complete
    ? "complete"
    : onlyLocalRecoverableGaps ? "partial_analyzable" : "partial_critical";

  return {
    schemaVersion: "trace-evidence-boundary-v1",
    classification,
    analysisAllowed: classification !== "partial_critical",
    negativeEvidenceEligible: classification === "complete",
    collectorResult,
    warnings,
    structuralWarnings,
    missingSegments,
    summary: classification === "complete"
      ? "Trace主体与可观察载荷通过完整性审计。"
      : classification === "partial_analyzable"
        ? `Trace主体可分析，但有${missingSegments.length}个已定位局部缺口（Tool输出截断或辅助Tree节点缺失）；允许带证据边界继续分析。`
        : "Trace存在结构性或不可定位的关键缺口，当前不可安全归因。",
  };
}
