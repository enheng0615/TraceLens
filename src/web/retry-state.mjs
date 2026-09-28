import { createHash } from "node:crypto";

export function retryItemKey(item) {
  return JSON.stringify([item?.rowNumber ?? null, String(item?.sessionId ?? ""), item?.criterionId ?? null, item?.caseId ?? null]);
}

export function sessionRetryKey(sessionId, rowNumbers = []) {
  const rows = [...new Set(rowNumbers.map(Number).filter(Number.isFinite))].sort((left, right) => left - right);
  return `SR-${createHash("sha256").update(JSON.stringify([String(sessionId ?? ""), rows])).digest("hex").slice(0, 20)}`;
}

export function selectableSessionCandidates(manifest) {
  const groups = new Map();
  const records = [
    ...(manifest?.executionPlan?.records ?? []),
    ...(manifest?.items ?? []).filter((item) => item.reason !== "full_score" && item.stage !== "score_filter"),
  ];
  for (const record of records) {
    const sessionId = String(record?.sessionId ?? "").trim();
    if (!sessionId || record?.status === "source_run_failed" || record?.initialStatus === "source_run_failed") continue;
    if (!groups.has(sessionId)) groups.set(sessionId, new Set());
    const rowNumber = Number(record?.rowNumber);
    if (Number.isFinite(rowNumber)) groups.get(sessionId).add(rowNumber);
  }
  return [...groups.entries()].map(([sessionId, rows]) => {
    const rowNumbers = [...rows].sort((left, right) => left - right);
    return { retryKey: sessionRetryKey(sessionId, rowNumbers), sessionId, rowNumbers };
  });
}

function logicalItemKey(item) {
  return JSON.stringify([item?.rowNumber ?? null, String(item?.sessionId ?? ""), item?.criterionId ?? null]);
}

/** Resolve the latest effective result for each logical row/criterion across attempts. */
export function effectiveAttemptItems(attempts) {
  const effective = new Map();
  for (const attempt of [...attempts].sort((a, b) => a.attempt - b.attempt)) {
    if (attempt.scope === "full") effective.clear();
    for (const item of attempt.manifest?.items ?? []) {
      const sameRow = (candidate) => Number(candidate?.rowNumber ?? -1) === Number(item?.rowNumber ?? -1) && String(candidate?.sessionId ?? "") === String(item?.sessionId ?? "");
      if (item.criterionId) {
        for (const [key, previous] of effective) if (sameRow(previous) && !previous.criterionId) effective.delete(key);
      } else {
        for (const [key, previous] of effective) if (sameRow(previous)) effective.delete(key);
      }
      effective.set(logicalItemKey(item), { ...item, attempt: attempt.attempt, jobId: attempt.id });
    }
  }
  return [...effective.values()];
}

export function summarizeEffectiveItems(attempts) {
  const items = effectiveAttemptItems(attempts);
  return {
    total: items.length,
    completed: items.filter((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)).length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    sourceRunFailed: items.filter((item) => item.status === "source_run_failed").length,
    running: items.filter((item) => item.status === "running").length,
  };
}
