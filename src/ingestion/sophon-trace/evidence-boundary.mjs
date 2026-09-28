import { readFile } from "node:fs/promises";
import path from "node:path";

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

/**
 * Convert a collector integrity report into an explicit RCA evidence boundary.
 * Only a locally truncated Tool payload with otherwise complete structure is
 * analyzable. Pagination, identity, count, and cross-source mismatches remain
 * critical because they make the observable execution graph unknown.
 */
export async function buildTraceEvidenceBoundary({ traceRoot, integrity } = {}) {
  const report = integrity ?? {};
  const warnings = [...(report.warnings ?? [])];
  const structuralWarnings = warnings.filter((warning) =>
    STRUCTURAL_WARNING_PATTERNS.some((pattern) => pattern.test(String(warning))),
  );
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
  for (const spanId of unresolved) {
    const span = await readSpan(traceRoot, spanId);
    const signal = signalBySpan.get(spanId);
    const field = fieldFromPath(signal?.path);
    const content = String(span?.[field] ?? "");
    const recovery = safeAttempt(attempts.get(spanId));
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
      impact: `完整${span?.name || "Tool"} ${field}不可见；当前仅能使用Sophon已保存的${content.length}字符截断内容`,
    });
  }

  const collectorResult = report.completeness ?? report.result ?? "unknown";
  const collectorClaimsComplete = report.complete === true || [
    "complete",
    "complete_no_observed_truncation",
    "complete_with_recovered_truncation",
  ].includes(collectorResult);
  const complete = collectorClaimsComplete && warnings.length === 0 && missingSegments.length === 0;
  const onlyLocalRecoverableGaps = !complete &&
    structuralWarnings.length === 0 &&
    warnings.every((warning) => LOCAL_TOOL_GAP_WARNING_PATTERNS.some((pattern) => pattern.test(String(warning)))) &&
    missingSegments.length > 0 &&
    missingSegments.every((segment) => segment.spanType === "TOOL");
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
        ? `Trace主体结构完整，但有${missingSegments.length}段Tool输出不完整；允许带证据边界继续分析。`
        : "Trace存在结构性或不可定位的关键缺口，当前不可安全归因。",
  };
}
