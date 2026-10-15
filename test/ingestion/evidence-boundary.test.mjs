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

test("a localized Generation payload gap is analyzable but disables global absence claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-boundary-generation-"));
  await mkdir(path.join(root, "spans", "details"), { recursive: true });
  await writeFile(path.join(root, "spans", "details", "generation-cut.json"), JSON.stringify({ data: {
    id: "generation-cut", traceId: "trace-1", spanType: "GENERATION", name: "model", status: "SUCCESS", output: "visible",
  } }));
  try {
    const boundary = await buildTraceEvidenceBoundary({ traceRoot: root, integrity: {
      completeness: "partial_unrecoverable",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "generation-cut", path: "$.data.output" }],
      expandedToolResults: { unresolvedSpanIds: ["generation-cut"], attempts: [] },
    } });
    assert.equal(boundary.classification, "partial_analyzable");
    assert.equal(boundary.analysisAllowed, true);
    assert.equal(boundary.negativeEvidenceEligible, false);
    assert.equal(boundary.missingSegments[0].spanType, "GENERATION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores legacy truncation false positives copied into non-Tool spans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-boundary-legacy-false-positive-"));
  await mkdir(path.join(root, "spans", "details"), { recursive: true });
  await writeFile(path.join(root, "spans", "details", "generation.json"), JSON.stringify({ data: {
    id: "generation", traceId: "trace-1", spanType: "GENERATION", name: "model", status: "SUCCESS",
    output: '{"metadata":{"truncatedFieldName":"ordinary history text"}}',
  } }));
  try {
    const boundary = await buildTraceEvidenceBoundary({ traceRoot: root, integrity: {
      complete: false, completeness: "partial_unrecoverable",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "generation", path: "$.data.output", signal: "ordinary metadata with a truncation-like key" }],
      expandedToolResults: { unresolvedSpanIds: ["generation"], attempts: [] },
    } });
    assert.equal(boundary.classification, "complete");
    assert.equal(boundary.analysisAllowed, true);
    assert.equal(boundary.missingSegments.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclassifies an old failed download when the complete Tool payload is already in a sibling field", async () => {
  await withTraceSpan(async (traceRoot) => {
    const full = "complete payload ".repeat(900);
    await writeFile(path.join(traceRoot, "spans", "details", "span-cut.json"), JSON.stringify({ data: {
      id: "span-cut", traceId: "trace-1", spanType: "TOOL", name: "bash", status: "SUCCESS",
      output: JSON.stringify({
        output: full,
        resources: [{ result: `${full.slice(0, 9_985)}...[truncated]`, isResultTruncated: true,
          originalResultChars: full.length + 12 }],
      }),
    } }));
    const boundary = await buildTraceEvidenceBoundary({ traceRoot, integrity: {
      completeness: "partial_recoverable",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "span-cut", path: "$.data.output", signal: "...[truncated]" }],
      expandedToolResults: { unresolvedSpanIds: ["span-cut"], attempts: [
        { spanId: "span-cut", status: "failed", code: "EXPANDED_RESULT_HTTP_ERROR", message: "HTTP 401" },
      ] },
    } });
    assert.equal(boundary.classification, "complete");
    assert.deepEqual(boundary.missingSegments, []);
  });
});

test("quoted file-preview markers do not mean the saved Tool Span is incomplete", async () => {
  await withTraceSpan(async (traceRoot) => {
    await writeFile(path.join(traceRoot, "spans", "details", "span-cut.json"), JSON.stringify({ data: {
      id: "span-cut", traceId: "trace-1", spanType: "TOOL", name: "read_file", status: "SUCCESS",
      output: JSON.stringify({ output: "row 1 ...Truncated due to length limit, row 2 remains visible",
        resources: [{ artifact: { parts: [{ data: "saved artifact" }] } }] }),
    } }));
    const boundary = await buildTraceEvidenceBoundary({ traceRoot, integrity: {
      completeness: "partial_unrecoverable",
      warnings: ["Unrecovered server-side truncation markers were detected"],
      possibleTruncationSignals: [{ spanId: "span-cut", path: "$.data.output", signal: "...Truncated" }],
      expandedToolResults: { unresolvedSpanIds: ["span-cut"], attempts: [] },
    } });
    assert.equal(boundary.classification, "complete");
    assert.deepEqual(boundary.missingSegments, []);
  });
});
