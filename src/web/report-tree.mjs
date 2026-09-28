import path from "node:path";
import { TERMINAL_JOB_STATUSES, WEB_FAILURE_JSON, WEB_FAILURE_MD, WEB_JOB_LOG } from "./job-model.mjs";
import { sessionRetryKey } from "./retry-state.mjs";

export function criterionIdFromPath(file) {
  return String(file ?? "").match(/(?:^|[-/])(报告GT\d+|缺失GT\d+|GT-\d+)(?:[-/]|$)/)?.[1] ?? null;
}

export function sessionIdFromPath(file) {
  const matches = [...String(file ?? "").matchAll(/(?:^|[-/])session-(\d+)(?=[-/]|$)/g)];
  return matches.at(-1)?.[1] ?? null;
}

export function artifactLabel(name, criterionId) {
  const friendly = {
    "rca-report.md": "RCA报告",
    "failure-summary.md": "失败摘要",
    "agent-run-summary.md": "执行摘要",
    "agent-run.md": "Agent日志",
    "validation.json": "校验结果",
    "workflow-summary.md": "工作流摘要",
    [WEB_JOB_LOG]: "Web运行日志",
    [WEB_FAILURE_JSON]: "Web失败诊断数据",
    [WEB_FAILURE_MD]: "Web失败诊断",
  }[name] ?? name;
  return criterionId ? `${criterionId} · ${friendly}` : friendly;
}

function aggregateStatus(items) {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "failed")) {
    return items.some((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)) ? "completed_with_failures" : "failed";
  }
  if (items.some((item) => item.status === "completed_with_evidence_gaps")) return "completed_with_evidence_gaps";
  if (items.some((item) => item.status === "completed")) return "completed";
  if (items.some((item) => item.status === "queued")) return "queued";
  if (items.length && items.every((item) => item.status === "source_run_failed")) return "source_run_failed";
  return items.length ? "skipped" : "completed_no_action";
}

function artifactBelongsToItem(artifact, item, jobDir) {
  if (item.rcaOutputDir) {
    const relative = path.relative(jobDir, path.resolve(item.rcaOutputDir));
    if (relative && !relative.startsWith("..") && (artifact.path === relative || artifact.path.startsWith(`${relative}${path.sep}`))) return true;
  }
  if (item.casePath) {
    const relativeCase = path.relative(jobDir, path.resolve(item.casePath));
    if (artifact.path === relativeCase) return true;
  }
  return Boolean(
    item.criterionId && artifact.criterionId === item.criterionId &&
    item.sessionId && artifact.sessionId === String(item.sessionId),
  );
}

export function buildReportTree({ job, manifest, artifacts }) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const sessions = new Map();
  const ensureSession = (sessionId, rowNumber) => {
    const normalizedId = String(sessionId ?? "").trim();
    const sessionKey = normalizedId || `row-${rowNumber ?? "unknown"}`;
    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        key: sessionKey,
        sessionId: normalizedId || null,
        rowNumbers: new Set(),
        items: [],
        criteria: [],
      });
    }
    const session = sessions.get(sessionKey);
    if (rowNumber !== undefined && rowNumber !== null) session.rowNumbers.add(Number(rowNumber));
    return session;
  };
  const preferredArtifact = (itemArtifacts) => itemArtifacts.find((artifact) => artifact.name === "rca-report.md")
    ?? itemArtifacts.find((artifact) => artifact.name === "failure-summary.md")
    ?? itemArtifacts.find((artifact) => artifact.name === "agent-run-summary.md")
    ?? itemArtifacts.find((artifact) => artifact.name === "agent-run.md")
    ?? itemArtifacts[0]
    ?? null;

  const plannedRecords = manifest?.executionPlan?.records ?? [];
  for (const planned of plannedRecords) {
    const session = ensureSession(planned.sessionId, planned.rowNumber);
    session.items.push({
      rowNumber: planned.rowNumber,
      sessionId: planned.sessionId,
      status: planned.initialStatus === "source_run_failed" ? "source_run_failed" : "queued",
      stage: "planned",
      reason: planned.initialStatus === "source_run_failed" ? "source_run_failed" : "awaiting_execution",
      planned: true,
    });
  }

  for (const item of items) {
    // Full-score rows are intentionally not RCA work and must not appear as
    // Sessions in the batch report workspace. Keep them only in batch counts.
    if (item.reason === "full_score" || item.stage === "score_filter") continue;
    const session = ensureSession(item.sessionId, item.rowNumber);
    session.items = session.items.filter((planned) => !(planned.planned && Number(planned.rowNumber) === Number(item.rowNumber)));
    session.items.push(item);
    if (!item.criterionId) continue;
    const itemArtifacts = artifacts.filter((artifact) => artifactBelongsToItem(artifact, item, job.jobDir));
    session.criteria.push({
      key: `${item.rowNumber ?? "single"}:${item.criterionId}:${item.caseId ?? "case"}`,
      criterionId: item.criterionId,
      caseId: item.caseId ?? null,
      rowNumber: item.rowNumber ?? null,
      status: item.status,
      stage: item.stage ?? null,
      error: item.error?.message ?? null,
      errorCode: item.error?.code ?? null,
      remediation: item.error?.remediation ?? null,
      artifacts: itemArtifacts,
      preferredArtifact: preferredArtifact(itemArtifacts),
    });
  }

  // Compatibility projection for v1 runs: older workflows stored Session/GT only
  // in the RCA directory name and sometimes had no workflow Manifest at all.
  // Reconstruct missing nodes from artifact metadata without mutating old runs.
  const legacyGroups = new Map();
  for (const artifact of artifacts) {
    if (!artifact.sessionId || !artifact.criterionId) continue;
    const key = `${artifact.sessionId}\u0000${artifact.criterionId}`;
    if (!legacyGroups.has(key)) legacyGroups.set(key, { sessionId: artifact.sessionId, criterionId: artifact.criterionId, artifacts: [] });
    legacyGroups.get(key).artifacts.push(artifact);
  }
  for (const group of legacyGroups.values()) {
    const session = ensureSession(group.sessionId, null);
    const existing = session.criteria.find((criterion) => criterion.criterionId === group.criterionId);
    if (existing) {
      const known = new Set(existing.artifacts.map((artifact) => artifact.path));
      existing.artifacts.push(...group.artifacts.filter((artifact) => !known.has(artifact.path)));
      existing.preferredArtifact = preferredArtifact(existing.artifacts);
      continue;
    }
    const hasReport = group.artifacts.some((artifact) => artifact.name === "rca-report.md");
    const hasFailure = group.artifacts.some((artifact) => artifact.name === "failure-summary.md");
    session.criteria.push({
      key: `legacy:${group.sessionId}:${group.criterionId}`,
      criterionId: group.criterionId,
      caseId: null,
      rowNumber: null,
      status: hasFailure ? "failed" : hasReport ? "completed" : TERMINAL_JOB_STATUSES.has(job.status) ? "completed" : "running",
      stage: "legacy_artifact_projection",
      error: null,
      artifacts: group.artifacts,
      preferredArtifact: preferredArtifact(group.artifacts),
    });
  }

  const sessionList = [...sessions.values()].map((session) => {
    const plannedItems = session.items.filter((item) => item.planned);
    const nonCriterionItems = session.items.filter((item) => !item.planned && !item.criterionId);
    const statusItems = [...session.criteria, ...plannedItems, ...nonCriterionItems];
    const sourceIssue = session.items.find((item) => item.status === "source_run_failed");
    const sessionFailure = nonCriterionItems.find((item) => item.status === "failed");
    const issue = sourceIssue ? {
      kind: "source_run_failed",
      status: sourceIssue.status,
      stage: sourceIssue.stage ?? "source_run",
      code: sourceIssue.code ?? "SOURCE_RUN_FAILED",
      label: sourceIssue.label ?? "上游评测无有效产物",
      detail: sourceIssue.detail ?? "上游任务没有产生可用于Trace归因的结果。",
      remediation: sourceIssue.remediation ?? "请先重新运行上游IDA评测，补齐Session ID、score、IDA答案和机评结果。",
      rowNumber: sourceIssue.rowNumber ?? null,
    } : sessionFailure ? {
      kind: "failure",
      status: sessionFailure.status,
      stage: sessionFailure.stage ?? "unknown",
      code: sessionFailure.error?.code ?? null,
      label: "Session处理失败",
      detail: sessionFailure.error?.message ?? "该Session未能完成Trace归因。",
      remediation: sessionFailure.error?.remediation ?? "查看失败阶段和错误信息，修复后仅重跑该Session。",
      rowNumber: sessionFailure.rowNumber ?? null,
    } : null;
    return {
      key: session.key,
      sessionId: session.sessionId,
      ...(session.sessionId ? { retryKey: sessionRetryKey(session.sessionId, [...session.rowNumbers]) } : {}),
      rowNumbers: [...session.rowNumbers].sort((left, right) => left - right),
      status: aggregateStatus(statusItems),
      counts: {
        total: session.criteria.length || session.items.length,
        criteria: session.criteria.length,
        completed: statusItems.filter((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)).length,
        completedWithEvidenceGaps: statusItems.filter((item) => item.status === "completed_with_evidence_gaps").length,
        failed: statusItems.filter((item) => item.status === "failed").length,
        skipped: statusItems.filter((item) => item.status === "skipped").length,
        sourceRunFailed: statusItems.filter((item) => item.status === "source_run_failed").length,
        queued: statusItems.filter((item) => item.status === "queued").length,
      },
      issue,
      criteria: session.criteria.sort((left, right) => String(left.criterionId).localeCompare(String(right.criterionId), "zh-CN", { numeric: true })),
    };
  }).sort((left, right) => String(left.sessionId ?? left.key).localeCompare(String(right.sessionId ?? right.key), "zh-CN", { numeric: true }));
  const assignedPaths = new Set(sessionList.flatMap((session) => session.criteria.flatMap((criterion) => criterion.artifacts.map((artifact) => artifact.path))));
  const globalArtifacts = artifacts.filter((artifact) => !assignedPaths.has(artifact.path) && [
    "workflow-summary.md", WEB_FAILURE_MD, WEB_FAILURE_JSON, WEB_JOB_LOG,
  ].includes(artifact.name));
  const actualRows = new Set(items
    .filter((item) => item.reason !== "full_score" && item.stage !== "score_filter")
    .map((item) => Number(item.rowNumber))
    .filter(Number.isFinite));
  return {
    schemaVersion: "trace-rca-report-tree-v1",
    batch: {
      id: manifest?.workflowId ?? job.id,
      jobId: job.id,
      createdAt: manifest?.startedAt ?? job.createdAt,
      status: manifest?.status ?? job.status,
      source: manifest?.source ?? null,
      attempt: Number(job.lineage?.attempt) || 1,
      storageLayout: manifest?.storageLayout ?? { version: 1, hierarchy: "legacy" },
    },
    counts: {
      sessions: sessionList.length,
      criteria: sessionList.reduce((total, session) => total + session.criteria.length, 0),
      completed: sessionList.reduce((total, session) => total + session.counts.completed, 0),
      failed: sessionList.reduce((total, session) => total + session.counts.failed, 0),
      skipped: sessionList.reduce((total, session) => total + session.counts.skipped, 0),
      sourceRunFailed: sessionList.reduce((total, session) => total + session.counts.sourceRunFailed, 0),
      queued: sessionList.reduce((total, session) => total + session.counts.queued, 0),
      nonFullScoreRows: Number(manifest?.executionPlan?.nonFullScoreRows) || sessionList.length,
      startedRows: actualRows.size,
    },
    sessions: sessionList,
    globalArtifacts,
  };
}
