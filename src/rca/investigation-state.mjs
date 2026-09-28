import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function actionSubjectKey(action) {
  const args = action?.arguments ?? {};
  if (action?.tool === "get_tool_exchange") return `${action.tool}:${args.spanId ?? "unknown"}`;
  if (action?.tool === "get_span_content") return `${action.tool}:${args.spanId ?? "unknown"}:${args.field ?? "output"}`;
  if (action?.tool === "search_trace") return `${action.tool}:${String(args.query ?? "").toLocaleLowerCase()}:${args.scope ?? "primary"}`;
  return `${action?.tool}:${JSON.stringify(args)}`;
}

export function coverageSignature(coverage) {
  return hash((coverage?.checks ?? []).map((item) => [item.description, item.ok]));
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
    instruction: stallCount >= 2
      ? "已连续无进展。不得继续同类读取；请用现有证据关闭问题或标记unobservable。"
      : "只处理仍开放的问题，不重复已解决路径。",
  };
}

export function updateStallCount({ previousEvidenceCount, evidenceCount, previousCoverageSignature, coverage, stallCount = 0 }) {
  // New EV rows alone are not progress: an agent can otherwise keep issuing
  // novel but irrelevant searches forever. Progress means the deterministic
  // coverage state changed. Evidence counts remain in the signature for audit
  // compatibility but deliberately do not reset the stall counter.
  void previousEvidenceCount;
  void evidenceCount;
  const progressed = coverageSignature(coverage) !== previousCoverageSignature;
  return { progressed, stallCount: progressed ? 0 : stallCount + 1 };
}
