import { createHash } from "node:crypto";

function safePart(value) {
  return String(value ?? "item")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

function scoreValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

export function buildRcaCases({
  sessionId,
  query,
  idaAnswer,
  score,
  criteria,
  source,
  rowNumber,
  traceExchange,
  traceEvidenceBoundary,
}) {
  if (!Array.isArray(criteria) || !criteria.length) throw new Error("At least one missed criterion is required");
  return criteria.map((criterion, index) => {
    const identity = `${sessionId}\0${rowNumber ?? "single"}\0${criterion.id}\0${criterion.text}`;
    const caseId = [
      "session",
      safePart(sessionId),
      rowNumber ? `row-${rowNumber}` : "single",
      safePart(criterion.id || `gt-${index + 1}`),
      shortHash(identity),
    ].join("-");
    return {
      schemaVersion: "rca-case-v1",
      caseId,
      sessionId: String(sessionId),
      query: String(query),
      score: scoreValue(score),
      scoreNote: score === null || score === undefined || score === "" ? "上游未提供总分。" : "来自上游评测结果。",
      officialMissedCriteria: [{
        id: String(criterion.id || `GT-${index + 1}`),
        text: String(criterion.text),
        officialVerdict: String(criterion.officialVerdict || "未命中"),
      }],
      machineGrading: String(criterion.reason || "官方机评判定该GT未命中。"),
      idaAnswer: String(idaAnswer),
      inputProvenance: {
        source,
        ...(rowNumber ? { csvRow: rowNumber } : {}),
        query: source === "csv" ? "CSV query column" : "Sophon Trace AGENT input",
        groundTruth: criterion.source || "machine grading",
        machineGrading: criterion.source || "machine grading",
        idaAnswer: traceExchange?.answerResolution === "published_artifact_from_trace"
          ? "Published artifact body deterministically resolved from Sophon Trace write_file to lark_doc chain"
          : traceExchange?.answerResolution === "trace_answer_exact_prefix_with_delivered_artifacts"
            ? "CSV answer contains the exact Sophon Trace AGENT answer followed by delivered attachment bodies; both sections are preserved"
          : traceExchange?.answerResolution === "trace_answer_markdown_exact_with_delivered_artifacts"
            ? "CSV answer body is rendered-Markdown identical to the Sophon Trace AGENT answer and is followed by delivered attachment bodies; both sections are preserved"
          : traceExchange?.answerResolution === "explicitly_truncated_input_replaced_with_trace_output"
            ? "Input carried an explicit truncation marker; complete Sophon Trace AGENT output used after exact Query match"
            : source === "csv" ? "CSV answer column; checked against Sophon Trace" : "single-session input; checked against Sophon Trace",
        traceAgentSpanId: traceExchange?.spanId ?? null,
        answerResolution: traceExchange?.answerResolution ?? "exact_agent_output",
        ...(traceExchange?.answerProvenance ?? {}),
      },
      ...(traceEvidenceBoundary ? { traceEvidenceBoundary } : {}),
    };
  });
}
