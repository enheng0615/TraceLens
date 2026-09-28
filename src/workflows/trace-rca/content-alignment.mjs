import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function normalizePlainText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

// Evaluation exports sometimes preserve the Markdown label while replacing an
// internal URL with the label itself. Compare the rendered document identity,
// not the transport-specific link target. No prose or label is removed.
export function normalizeMarkdownLinkTargets(value) {
  return normalizePlainText(value)
    .replace(/(!?\[[^\]\n]*\])\([^\n)]*\)/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

const EVALUATION_QUERY_SUFFIXES = [
  /(?:[，,。；;]?\s*)请回答北京时间[。！!]?$/u,
  /(?:[，,。；;]?\s*)请直接给出答案[。！!]?$/u,
  /(?:[，,。；;]?\s*)不要向(?:我|用户)提问[。！!]?$/u,
  /(?:[，,。；;]?\s*)注意不要让用户二次回复来明确相关定义[，,]?\s*需要自行判定或按默认处理[。！!]?$/u,
];

export function stripControlledEvaluationQuerySuffixes(value) {
  let text = normalizePlainText(value);
  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of EVALUATION_QUERY_SUFFIXES) {
      const match = text.match(pattern);
      if (!match) continue;
      removed.unshift(match[0].replace(/^[，,。；;\s]+/u, "").trim());
      text = text.slice(0, match.index).replace(/[，,。；;\s]+$/u, "").trim();
      changed = true;
      break;
    }
  }
  return { text, removed };
}

export function compareEvaluatedQuery(expected, actual) {
  const source = normalizePlainText(expected);
  const trace = normalizePlainText(actual);
  if (source === trace) {
    return {
      matches: true, resolution: "exact_query", expectedChars: String(expected ?? "").length,
      traceChars: String(actual ?? "").length, expectedSha256: sha256(source), traceSha256: sha256(trace),
      provenance: { method: "exact", removedEvaluationInstructions: [] },
    };
  }
  const strippedSource = stripControlledEvaluationQuerySuffixes(source);
  const strippedTrace = stripControlledEvaluationQuerySuffixes(trace);
  const matches = Boolean(strippedSource.text) && strippedSource.text === strippedTrace.text
    && (strippedSource.removed.length > 0 || strippedTrace.removed.length > 0);
  return {
    matches,
    resolution: matches ? "controlled_evaluation_instruction_removed" : "query_mismatch",
    expectedChars: String(expected ?? "").length, traceChars: String(actual ?? "").length,
    expectedSha256: sha256(source), traceSha256: sha256(trace),
    provenance: {
      method: matches ? "controlled_suffix_exact" : "none",
      removedEvaluationInstructions: { expected: strippedSource.removed, trace: strippedTrace.removed },
      normalizedExpectedSha256: sha256(strippedSource.text), normalizedTraceSha256: sha256(strippedTrace.text),
    },
  };
}

export function markdownDisplayExact(left, right) {
  const a = normalizeMarkdownLinkTargets(left);
  const b = normalizeMarkdownLinkTargets(right);
  return Boolean(a) && a === b;
}
