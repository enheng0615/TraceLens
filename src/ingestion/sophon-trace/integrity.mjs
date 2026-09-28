import path from "node:path";
import { readJson, sha256 } from "./file-store.mjs";

function walkTree(node) {
  if (!node || typeof node !== "object") return [];
  const descendants = (node.childs ?? []).flatMap(walkTree);
  return [node, ...descendants];
}

function safeSignal(value) {
  return String(value ?? "")
    .replace(/([?&](?:token|access_token|jwt)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/https:\/\/ida\.bytedance\.net\/dataAgent\/llm\/api\/v2\/deepresearch\/images\?[^\s"']+/gi, "<redacted-internal-download-url>")
    .slice(-120);
}

function payloadLength(value) {
  if (value === undefined || value === null) return 0;
  return typeof value === "string" ? value.length : JSON.stringify(value).length;
}

function findTruncationSignals(value, currentPath = "$") {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      findings.push(...findTruncationSignals(child, `${currentPath}[${index}]`));
    });
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${currentPath}.${key}`;
      if (/(truncat|omit|overflow)/i.test(key) && Boolean(child)) {
        findings.push({ path: childPath, signal: safeSignal(child) });
      }
      findings.push(...findTruncationSignals(child, childPath));
    }
    return findings;
  }
  if (
    typeof value === "string" &&
    /(\[truncated\]|<truncated>|\.\.\.truncated)/i.test(value)
  ) {
    findings.push({ path: currentPath, signal: safeSignal(value) });
  }
  return findings;
}

function comparePayloads(left, right, field) {
  const ids = [...new Set([...left.keys()].filter((id) => right.has(id)))];
  const mismatchedIds = ids.filter(
    (id) => sha256(left.get(id)?.[field]) !== sha256(right.get(id)?.[field]),
  );
  return {
    compared: ids.length,
    exactSha256Matches: ids.length - mismatchedIds.length,
    mismatches: mismatchedIds.length,
    mismatchedIds,
  };
}

export async function auditCollection({
  outputDirectory,
  sessionSummary,
  turns,
  turnPages,
  spans,
  spanPages,
  traceTreeFiles,
  spanDetailFiles,
  expandedToolResults = { recovered: new Map(), attempts: [] },
}) {
  const listById = new Map(
    spans.filter((span) => span?.id).map((span) => [String(span.id), span]),
  );

  const treeById = new Map();
  const treeTraceIds = new Set();
  const truncationSignals = [];
  for (const [traceId, filePath] of traceTreeFiles) {
    const payload = await readJson(filePath);
    for (const node of walkTree(payload?.data)) {
      if (node?.id) {
        treeById.set(String(node.id), node);
        for (const field of ["input", "output"]) {
          truncationSignals.push(
            ...findTruncationSignals(node?.[field], `$.data.${field}`).map((finding) => ({
              spanId: String(node.id),
              source: path.relative(outputDirectory, filePath),
              ...finding,
            })),
          );
        }
      }
      if (node?.traceId) treeTraceIds.add(String(node.traceId));
    }
    if (payload?.data) treeTraceIds.add(String(traceId));
  }

  const detailById = new Map();
  for (const [spanId, filePath] of spanDetailFiles) {
    const payload = await readJson(filePath);
    truncationSignals.push(
      ...findTruncationSignals(payload?.data?.input, "$.data.input").map((finding) => ({
        spanId: String(spanId), source: path.relative(outputDirectory, filePath), ...finding,
      })),
      ...findTruncationSignals(payload?.data?.output, "$.data.output").map((finding) => ({
        spanId: String(spanId), source: path.relative(outputDirectory, filePath), ...finding,
      })),
    );
    const detail = payload?.data;
    if (detail?.id) detailById.set(String(detail.id), detail);
    else detailById.set(String(spanId), detail ?? {});
  }

  const spanIds = new Set(listById.keys());
  const treeSpanIds = new Set(treeById.keys());
  const detailSpanIds = new Set(detailById.keys());
  const traceIds = new Set(
    spans.filter((span) => span?.traceId).map((span) => String(span.traceId)),
  );
  const turnTraceIds = new Set(
    turns
      .filter((turn) => turn?.businessTraceId)
      .map((turn) => String(turn.businessTraceId)),
  );

  const comparisons = {
    "input:spanList:traceTree": comparePayloads(listById, treeById, "input"),
    "input:spanList:spanDetail": comparePayloads(listById, detailById, "input"),
    "input:traceTree:spanDetail": comparePayloads(treeById, detailById, "input"),
    "output:spanList:traceTree": comparePayloads(listById, treeById, "output"),
    "output:spanList:spanDetail": comparePayloads(listById, detailById, "output"),
    "output:traceTree:spanDetail": comparePayloads(treeById, detailById, "output"),
  };

  const warnings = [];
  if (!turnPages.length || turnPages.at(-1).hasMore) {
    warnings.push("Session detail pagination is incomplete");
  }
  if (!spanPages.length || spanPages.at(-1).hasMore) {
    warnings.push("Span list pagination is incomplete");
  }
  if (spanIds.size !== detailSpanIds.size) {
    warnings.push("Span detail count does not match the span list");
  }
  if (
    spanIds.size !== treeSpanIds.size ||
    [...spanIds].some((id) => !treeSpanIds.has(id))
  ) {
    warnings.push("Span IDs differ between span list and trace trees");
  }
  if (
    traceIds.size !== treeTraceIds.size ||
    [...traceIds].some((id) => !treeTraceIds.has(id))
  ) {
    warnings.push("Trace IDs differ between span list and trace trees");
  }
  if (
    turnTraceIds.size > 0 &&
    [...turnTraceIds].some((id) => !traceIds.has(id))
  ) {
    warnings.push("A Session turn references a Trace absent from the span list");
  }
  if (
    sessionSummary.traceCount !== undefined &&
    Number.isFinite(Number(sessionSummary.traceCount)) &&
    traceIds.size !== Number(sessionSummary.traceCount)
  ) {
    warnings.push("Session traceCount does not match unique Trace IDs");
  }
  const recoveredSpanIds = new Set(expandedToolResults?.recovered?.keys?.() ?? []);
  const unresolvedTruncationSignals = truncationSignals.filter((finding) => !recoveredSpanIds.has(String(finding.spanId)));
  if (unresolvedTruncationSignals.length) {
    warnings.push("Unrecovered server-side truncation markers were detected");
  }
  for (const [name, comparison] of Object.entries(comparisons)) {
    if (comparison.mismatches) warnings.push(`Payload mismatch: ${name}`);
  }

  const detailValues = [...detailById.values()];
  const failedRecoverySpanIds = new Set((expandedToolResults?.attempts ?? []).filter((item) => item.status === "failed").map((item) => String(item.spanId)));
  const unresolvedSpanIds = [...new Set(unresolvedTruncationSignals.map((item) => String(item.spanId)))].sort();
  const recoverable = unresolvedSpanIds.length > 0 && unresolvedSpanIds.every((spanId) => failedRecoverySpanIds.has(spanId));
  const completeness = warnings.length === 0
    ? truncationSignals.length ? "complete_with_recovered_truncation" : "complete"
    : recoverable ? "partial_recoverable" : "partial_unrecoverable";
  return {
    schemaVersion: "1.0",
    result: warnings.length
      ? completeness
      : truncationSignals.length ? "complete_with_recovered_truncation" : "complete_no_observed_truncation",
    completeness,
    complete: warnings.length === 0,
    counts: {
      turns: turns.length,
      traces: traceIds.size,
      spans: spans.length,
      uniqueSpanIds: spanIds.size,
      treeSpanIds: treeSpanIds.size,
      spanDetails: detailSpanIds.size,
    },
    pagination: {
      sessionDetailComplete: Boolean(turnPages.length && !turnPages.at(-1).hasMore),
      spanListComplete: Boolean(spanPages.length && !spanPages.at(-1).hasMore),
      sessionDetailPages: turnPages.map(({ filePath, ...page }) => page),
      spanListPages: spanPages.map(({ filePath, ...page }) => page),
    },
    payloads: {
      spanInputsPresent: detailValues.filter((span) => span.input !== null && span.input !== undefined).length,
      spanOutputsPresent: detailValues.filter((span) => span.output !== null && span.output !== undefined).length,
      maxInputChars: Math.max(0, ...detailValues.map((span) => payloadLength(span.input))),
      maxOutputChars: Math.max(0, ...detailValues.map((span) => payloadLength(span.output))),
      explicitTruncationMarkersFound: truncationSignals.length,
      recoveredTruncationMarkers: truncationSignals.length - unresolvedTruncationSignals.length,
      unresolvedTruncationMarkers: unresolvedTruncationSignals.length,
    },
    crossSourceComparisons: comparisons,
    warnings,
    possibleTruncationSignals: truncationSignals.slice(0, 100),
    expandedToolResults: {
      recoveredSpanIds: [...recoveredSpanIds].sort(),
      attempts: expandedToolResults?.attempts ?? [],
      unresolvedSpanIds,
    },
    scopeNote:
      "This verifies Sophon pagination and cross-endpoint consistency. It cannot recover or independently prove the absence of truncation before data reached Sophon.",
  };
}
