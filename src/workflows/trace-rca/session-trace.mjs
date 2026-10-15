import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTraceEvidenceBoundary,
  SophonCliClient,
  SophonSessionCollector,
} from "../../ingestion/sophon-trace/index.mjs";

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

export async function inspectCachedTrace(traceOutputRoot, sessionId) {
  const traceRoot = path.join(path.resolve(traceOutputRoot), String(sessionId));
  const manifest = await readJson(path.join(traceRoot, "manifest.json"));
  const integrity = (await readJson(path.join(traceRoot, "integrity-report.json"))) ??
    (await readJson(path.join(traceRoot, "integrity-audit.json")));
  const details = path.join(traceRoot, "spans", "details");
  let hasDetails = false;
  try { await access(details); hasDetails = true; } catch {}
  const complete = Boolean(
    hasDetails &&
    String(manifest?.sessionId) === String(sessionId) &&
    ["completed", "complete_no_observed_truncation"].includes(String(manifest?.status ?? manifest?.result)) &&
    (integrity?.complete === true || integrity?.result === "complete_no_observed_truncation"),
  );
  const evidenceBoundary = await buildTraceEvidenceBoundary({ traceRoot, integrity });
  return { traceRoot, complete, analyzable: evidenceBoundary.analysisAllowed, manifest, integrity, evidenceBoundary };
}

export function createSessionCollector({ traceOutputRoot, ingestion = {}, logger = console } = {}) {
  const client = new SophonCliClient({
    tenant: ingestion.tenant || "data",
    region: ingestion.region,
    userEmail: ingestion.userEmail,
    timeoutMs: ingestion.timeoutMs ?? 120_000,
    retries: ingestion.retries ?? 2,
    logger,
  });
  return new SophonSessionCollector({ client, outputRoot: traceOutputRoot, logger });
}

export async function ensureSessionTrace({
  sessionId,
  agentId,
  traceOutputRoot,
  collector,
  ingestion = {},
  force = false,
}) {
  const cached = await inspectCachedTrace(traceOutputRoot, sessionId);
  if (cached.analyzable && !force) {
    return {
      traceRoot: cached.traceRoot,
      source: "cache",
      integrity: cached.integrity,
      evidenceBoundary: cached.evidenceBoundary,
    };
  }
  if (!collector) throw new Error("A SophonSessionCollector is required when Trace is not already complete");
  const result = await collector.collect({
    sessionId: String(sessionId),
    agentIdHint: agentId || ingestion.agentId,
    agentType: ingestion.agentType || "ida",
    pageSize: ingestion.pageSize ?? 200,
    paddingMs: ingestion.paddingMs ?? 300_000,
    force,
  });
  const evidenceBoundary = await buildTraceEvidenceBoundary({
    traceRoot: result.outputDirectory,
    integrity: result.integrity,
  });
  if (!evidenceBoundary.analysisAllowed) {
    const error = new Error(`Trace collection did not pass completeness audit for session ${sessionId}: ${result.integrity?.completeness || result.integrity?.result || "incomplete"}`);
    error.code = result.integrity?.completeness === "partial_recoverable"
      ? "TRACE_PARTIAL_RECOVERABLE"
      : "TRACE_PARTIAL_UNRECOVERABLE";
    error.details = {
      sessionId: String(sessionId),
      completeness: result.integrity?.completeness ?? null,
      warnings: result.integrity?.warnings ?? [],
      unresolvedSpanIds: result.integrity?.expandedToolResults?.unresolvedSpanIds ?? [],
      recoveryAttempts: result.integrity?.expandedToolResults?.attempts ?? [],
      evidenceBoundary,
    };
    error.remediation = error.code === "TRACE_PARTIAL_RECOVERABLE"
      ? "截断Tool Result带有完整结果地址但本次补拉失败；检查内网后仅重跑该Session。"
      : "Trace仍有无法补回的截断或结构缺口；需要补齐上游Trace后再归因。";
    throw error;
  }
  return {
    traceRoot: result.outputDirectory,
    source: "collected",
    integrity: result.integrity,
    evidenceBoundary,
  };
}
