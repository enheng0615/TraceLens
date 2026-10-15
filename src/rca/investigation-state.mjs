import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function actionSubjectKey(action) {
  const args = action?.arguments ?? {};
  if (action?.tool === "get_tool_exchange") return `${action.tool}:${args.spanId ?? "unknown"}:${args.outputStart ?? 0}`;
  if (action?.tool === "get_json_field") return `${action.tool}:${args.spanId}:${args.field ?? "input"}:${args.pointer ?? ""}:${args.start ?? 0}`;
  if (action?.tool === "get_span_content") return `${action.tool}:${args.spanId ?? "unknown"}:${args.field ?? "output"}:${Number(args.start) || 0}`;
  if (action?.tool === "search_trace") return `${action.tool}:${String(args.query ?? "").toLocaleLowerCase()}:${args.scope ?? "primary"}`;
  return `${action?.tool}:${JSON.stringify(args)}`;
}

export function coverageSignature(coverage) {
  return hash((coverage?.checks ?? []).map((item) => [
    item.description, item.ok, item.disposition ?? item.details?.disposition ?? null,
    item.details?.matchedAnchors ?? null, item.details?.evidenceIds ?? null,
  ]));
}

export function workingState({ decisions = [], coverage, stallCount = 0, actionAttempts = {} } = {}) {
  const latest = decisions.at(-1)?.decision;
  const priorOpen = new Set(decisions.slice(0, -1).flatMap((item) => item.decision?.openQuestions ?? []));
  return {
    confirmedCoverage: (coverage?.checks ?? []).filter((item) => item.ok).map((item) => item.description),
    unresolvedCoverage: coverage?.missing ?? [],
    openQuestions: latest?.openQuestions ?? [],
    recurringOpenQuestions: (latest?.openQuestions ?? []).filter((question) => priorOpen.has(question)),
    evidenceBoundary: latest?.proposedEvidenceBoundary ?? null,
    consecutiveNoProgressRounds: stallCount,
    actionAttempts,
    hypotheses: decisions.at(-1)?.hypotheses ?? [],
    instruction: stallCount >= 2
      ? "已连续无进展。不得继续同类读取；请用现有证据关闭问题或标记unobservable。"
      : "只处理仍开放的问题，不重复已解决路径。",
  };
}

function hasContent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

export function isSubstantiveTraceEvidence(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.tool === "search_trace") return Number(entry.result?.totalMatches) > 0;
  if (entry.tool === "get_tool_exchange") {
    return hasContent(entry.result?.request) || hasContent(entry.result?.response);
  }
  if (entry.tool === "get_span_content") return hasContent(entry.result?.content);
  if (entry.tool === "list_tool_queries" || entry.tool === "list_execution_steps") {
    return (Array.isArray(entry.result) && entry.result.length > 0) || (Array.isArray(entry.result?.steps) && entry.result.steps.length > 0);
  }
  // Other repository tools count only when they returned immutable raw Trace
  // references. Model-authored explanations and empty/failed reads do not.
  return Array.isArray(entry.rawRefs) && entry.rawRefs.length > 0;
}

export function updateStallCount({
  previousEvidenceCount,
  evidenceCount,
  previousCoverageSignature,
  coverage,
  stallCount = 0,
  newEvidenceEntries = [],
}) {
  // Progress has two independent forms: a required check/binding changed, or
  // the agent obtained new non-empty raw Trace evidence. Mere EV count growth,
  // empty searches and repeated/context-only entries do not keep a run alive.
  void previousEvidenceCount;
  void evidenceCount;
  const coverageProgressed = coverageSignature(coverage) !== previousCoverageSignature;
  const substantiveEvidenceAdded = newEvidenceEntries.some(isSubstantiveTraceEvidence);
  const progressed = coverageProgressed || substantiveEvidenceAdded;
  return { progressed, stallCount: progressed ? 0 : stallCount + 1 };
}

export function closeCoverageAsUnobservable(coverage, reason) {
  if (coverage?.complete) return coverage;
  const originalMissing = [...(coverage?.missing ?? [])];
  return {
    ...coverage,
    complete: true,
    completeForReporting: true,
    forcedEvidenceBoundary: true,
    originalMissing,
    missing: [],
    closure: { disposition: "unobservable", reason, unresolvedChecks: originalMissing },
    checks: (coverage?.checks ?? []).map((check) => check.ok ? check : ({
      ...check, ok: true, disposition: "unobservable", closureReason: reason,
    })),
  };
}
