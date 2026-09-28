import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildTraceEvidenceBoundary } from "../../src/ingestion/sophon-trace/evidence-boundary.mjs";

async function withTraceSpan(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-boundary-"));
  await mkdir(path.join(root, "spans", "details"), { recursive: true });
  await writeFile(path.join(root, "spans", "details", "span-cut.json"), JSON.stringify({ data: {
    id: "span-cut", traceId: "trace-1", spanType: "TOOL", name: "bash", status: "SUCCESS", output: "visible output",
  } }));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a local truncated Tool result remains analyzable with an explicit gap", async () => {
  await withTraceSpan(async (traceRoot) => {
    const boundary = await buildTraceEvidenceBoundary({ traceRoot, integrity: {
      completeness: "partial_recoverable",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "span-cut", path: "$.data.output" }],
      expandedToolResults: {
        unresolvedSpanIds: ["span-cut"],
        attempts: [{ spanId: "span-cut", status: "failed", code: "EXPANDED_RESULT_HTTP_ERROR", message: "HTTP 401" }],
      },
    } });
    assert.equal(boundary.classification, "partial_analyzable");
    assert.equal(boundary.analysisAllowed, true);
    assert.equal(boundary.negativeEvidenceEligible, false);
    assert.deepEqual(boundary.missingSegments[0], {
      kind: "truncated_tool_result", spanId: "span-cut", traceId: "trace-1", spanType: "TOOL", toolName: "bash", field: "output",
      observedChars: 14, spanStatus: "SUCCESS", recovery: { status: "failed", code: "EXPANDED_RESULT_HTTP_ERROR", message: "HTTP 401" },
      impact: "完整bash output不可见；当前仅能使用Sophon已保存的14字符截断内容",
    });
  });
});

test("pagination or count integrity gaps remain critical", async () => {
  await withTraceSpan(async (traceRoot) => {
    const boundary = await buildTraceEvidenceBoundary({ traceRoot, integrity: {
      completeness: "partial_unrecoverable",
      warnings: ["Span pagination is incomplete"],
      expandedToolResults: { unresolvedSpanIds: [] },
    } });
    assert.equal(boundary.classification, "partial_critical");
    assert.equal(boundary.analysisAllowed, false);
  });
});

test("an unresolved Tool gap overrides a contradictory complete flag", async () => {
  await withTraceSpan(async (traceRoot) => {
    const boundary = await buildTraceEvidenceBoundary({ traceRoot, integrity: {
      complete: true,
      completeness: "complete",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "span-cut", path: "$.data.output" }],
      expandedToolResults: { unresolvedSpanIds: ["span-cut"], attempts: [] },
    } });
    assert.equal(boundary.classification, "partial_analyzable");
    assert.equal(boundary.negativeEvidenceEligible, false);
  });
});
