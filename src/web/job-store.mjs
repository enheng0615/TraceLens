import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebAuditLogger } from "./audit-logger.mjs";
import { buildJobDiagnosis, renderWebFailureSummary } from "./job-diagnostics.mjs";
import { readRcaCsv } from "../workflows/trace-rca/csv-input.mjs";
import { isFullScore } from "../workflows/trace-rca/score-utils.mjs";

const TERMINAL = new Set(["completed", "completed_with_evidence_gaps", "completed_with_failures", "completed_no_action", "failed", "cancelled"]);
const JOB_FILE = "job.json";
const MAX_CAPTURED_LINES = 300;
const RCA_PROGRESS_START = 30;
const RCA_PROGRESS_END = 95;
const WEB_JOB_LOG = "web-job.jsonl";
const WEB_FAILURE_JSON = "web-failure-diagnosis.json";
const WEB_FAILURE_MD = "web-failure-summary.md";

function retryItemKey(item) {
  return JSON.stringify([item?.rowNumber ?? null, String(item?.sessionId ?? ""), item?.criterionId ?? null, item?.caseId ?? null]);
}

function criterionIdFromPath(file) {
  return String(file ?? "").match(/(?:^|[-/])(报告GT\d+|缺失GT\d+|GT-\d+)(?:[-/]|$)/)?.[1] ?? null;
}

function sessionIdFromPath(file) {
  const matches = [...String(file ?? "").matchAll(/(?:^|[-/])session-(\d+)(?=[-/]|$)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function eventPhaseProgress(event, maxRounds = 20) {
  const phase = String(event?.phase ?? "");
  if (phase === "scoring_gap") return 0.06;
  if (phase === "trace_map") return 0.14;
  const round = Number.parseInt(phase.match(/investigation_round_(\d+)/)?.[1] ?? "0", 10);
  if (round > 0) return Math.min(0.92, 0.16 + (round / Math.max(1, maxRounds)) * 0.74);
  if (phase === "final_rca") return 0.97;
  if (/complete/.test(phase)) return 1;
  return 0;
}

/**
 * Calculate progress across the complete workflow, not just the current RCA round.
 * Trace collection owns 0-30%; all missed-GT RCA cases share 30-95%; terminal
 * completion owns 100%. `previous` keeps polling updates monotonic.
 */
export function calculateWorkflowProgress({ job, manifest, events = [], previous = 0 } = {}) {
  if (TERMINAL.has(job?.status)) {
    return {
      percent: 100,
      stage: job.status,
      label: job.status === "completed" ? "归因报告已生成" : job.status === "completed_with_evidence_gaps" ? "归因完成，Trace局部不完整" : job.status === "completed_with_failures" ? "归因完成，部分GT失败" : job.status === "completed_no_action" ? "没有需要归因的GT" : job.status === "cancelled" ? "任务已取消" : "任务失败",
    };
  }
  if (job?.status !== "running" || !manifest) return job?.progress;

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const terminalItems = items.filter((item) => ["completed", "completed_with_evidence_gaps", "failed", "skipped", "source_run_failed"].includes(item.status)).length;
  const discovered = Number(manifest.counts?.criteria) || items.length;
  const planned = Number(manifest.counts?.totalWorkUnits) || Number(manifest.counts?.plannedCriteria) || discovered;
  const total = Math.max(1, planned, discovered, terminalItems);
  const activeItems = items.filter((item) => item.status === "running");
  const maxRounds = job.inputSummary?.maxRounds || manifest.configuration?.maxRounds || 20;
  const activeFractions = activeItems.map((item) => {
    const relevant = events.filter((event) =>
      (!event.criterionId || event.criterionId === item.criterionId) &&
      (!event.sessionId || event.sessionId === String(item.sessionId)),
    );
    const latest = relevant.at(-1);
    return { item, latest, fraction: eventPhaseProgress(latest, maxRounds) };
  });
  const fraction = activeFractions.reduce((sum, entry) => sum + entry.fraction, 0);
  const calculated = Math.round(RCA_PROGRESS_START + ((terminalItems + fraction) / total) * (RCA_PROGRESS_END - RCA_PROGRESS_START));
  const percent = Math.min(RCA_PROGRESS_END, Math.max(RCA_PROGRESS_START, Number(previous) || 0, calculated));
  const representative = activeFractions.reduce((best, entry) => !best || entry.fraction > best.fraction ? entry : best, null);
  const activeItem = representative?.item;
  const latest = representative?.latest;
  const activeCriterion = activeItem?.criterionId ?? null;
  const round = Number.parseInt(String(latest?.phase ?? "").match(/investigation_round_(\d+)/)?.[1] ?? "0", 10);
  const criterionLabel = activeCriterion ? `${activeCriterion} · ` : "";
  const parallelLabel = activeItems.length > 1 ? `${activeItems.length}个GT并行 · ` : criterionLabel;
  let stage = "preparation";
  let label = planned > 0 ? `准备归因 · ${terminalItems}/${total}项完成` : "准备归因";
  if (latest?.phase === "scoring_gap") { stage = "gap"; label = `${parallelLabel}定义评分差距`; }
  else if (latest?.phase === "trace_map") { stage = "trace_map"; label = `${parallelLabel}构建执行地图`; }
  else if (round > 0) { stage = "investigation"; label = `${parallelLabel}Trace证据调查 · ${terminalItems}/${total}项完成`; }
  else if (latest?.phase === "final_rca") { stage = "report"; label = `${parallelLabel}生成并校验报告`; }
  return { percent, stage, label };
}

function artifactLabel(name, criterionId) {
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
      status: hasFailure ? "failed" : hasReport ? "completed" : TERMINAL.has(job.status) ? "completed" : "running",
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

function logicalItemKey(item) {
  return JSON.stringify([item?.rowNumber ?? null, String(item?.sessionId ?? ""), item?.criterionId ?? null]);
}

function effectiveAttemptItems(attempts) {
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

function summarizeEffectiveItems(attempts) {
  const items = effectiveAttemptItems(attempts);
  return {
    total: items.length,
    completed: items.filter((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)).length,
    completedWithEvidenceGaps: items.filter((item) => item.status === "completed_with_evidence_gaps").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    sourceRunFailed: items.filter((item) => item.status === "source_run_failed").length,
    running: items.filter((item) => item.status === "running").length,
  };
}

function now() {
  return new Date().toISOString();
}

function compactLine(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 2000);
}

function safeFileName(value, fallback) {
  const cleaned = path.basename(String(value || fallback)).replace(/[^\p{L}\p{N}._-]+/gu, "-");
  return cleaned || fallback;
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function walk(directory, result = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, result);
    else result.push(target);
  }
  return result;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function runtimeSnapshot(projectRoot, env) {
  const digest = createHash("sha256");
  const files = (await walk(path.join(projectRoot, "src")))
    .filter((file) => file.endsWith(".mjs") || file.endsWith(".js"))
    .sort();
  for (const file of files) {
    digest.update(path.relative(projectRoot, file));
    digest.update(await readFile(file));
  }
  const packageJson = await readJson(path.join(projectRoot, "package.json"));
  return {
    capturedAt: now(),
    codeSha256: digest.digest("hex"),
    packageVersion: packageJson?.version ?? null,
    nodeVersion: process.version,
    provider: "sophon",
    modelId: env.SOPHON_MODEL_ID || null,
  };
}

function publicJob(job) {
  const { commandArgs: _commandArgs, ...safe } = job;
  return safe;
}

export class WebJobStore {
  constructor({ projectRoot, outputRoot, traceOutputRoot, env = process.env } = {}) {
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.outputRoot = path.resolve(outputRoot || path.join(this.projectRoot, "outputs", "web-console"));
    this.traceOutputRoot = path.resolve(traceOutputRoot || path.join(this.projectRoot, "data", "raw", "sophon-sessions"));
    this.env = env;
    this.jobs = new Map();
    this.processes = new Map();
    this.writeQueues = new Map();
    this.attemptCounters = new Map();
    this.audit = new WebAuditLogger(this.outputRoot);
  }

  async initialize() {
    await mkdir(path.join(this.outputRoot, "jobs"), { recursive: true });
    const entries = await readdir(path.join(this.outputRoot, "jobs"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await readJson(path.join(this.outputRoot, "jobs", entry.name, JOB_FILE));
      if (!job) continue;
      if (!TERMINAL.has(job.status)) {
        job.status = "failed";
        job.error = "Web进程已重启，原任务进程状态不可恢复；RCA Checkpoint如存在仍可通过CLI恢复。";
        job.failureContext = {
          stage: "web_runtime",
          code: "WEB_PROCESS_RESTARTED",
          message: job.error,
          impact: "Web服务重启时该任务仍处于运行态，因此无法确认原子进程是否完成；已有输入快照、RCA产物和日志均予以保留。",
          remediation: "先检查该Attempt已有产物；如任务未完成，可创建新的重跑Attempt，或按已有RCA Checkpoint从CLI恢复。",
        };
        job.updatedAt = now();
        await writeJsonAtomic(path.join(this.outputRoot, "jobs", entry.name, JOB_FILE), job);
      }
      this.jobs.set(job.id, job);
      const rootJobId = job.lineage?.rootJobId || job.id;
      this.attemptCounters.set(rootJobId, Math.max(this.attemptCounters.get(rootJobId) || 1, Number(job.lineage?.attempt) || 1));
      if (["failed", "completed_with_failures"].includes(job.status)) {
        await this.ensureFailureDiagnostics(job);
        await writeJsonAtomic(path.join(this.outputRoot, "jobs", entry.name, JOB_FILE), job);
      }
    }
    await this.audit.service("job_store_initialized", { jobCount: this.jobs.size, outputRoot: this.outputRoot });
    return this;
  }

  jobDirectory(id) {
    return path.join(this.outputRoot, "jobs", id);
  }

  async persist(job) {
    job.updatedAt = now();
    this.jobs.set(job.id, job);
    const snapshot = JSON.parse(JSON.stringify(job));
    const previous = this.writeQueues.get(job.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => writeJsonAtomic(path.join(this.jobDirectory(job.id), JOB_FILE), snapshot));
    this.writeQueues.set(job.id, next);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(job.id) === next) this.writeQueues.delete(job.id);
    }
  }

  async ensureFailureDiagnostics(job, manifest = null, { force = false } = {}) {
    const diagnosisPath = path.join(job.jobDir, WEB_FAILURE_JSON);
    if (!force) {
      const existing = await readJson(diagnosisPath);
      if (existing) {
        job.failureDiagnosis = existing;
        job.error = existing.message;
        return existing;
      }
    }
    const resolvedManifest = manifest ?? (job.manifestPath ? await readJson(job.manifestPath) : null);
    const diagnosis = await buildJobDiagnosis(job, resolvedManifest);
    await writeJsonAtomic(diagnosisPath, diagnosis);
    await writeFile(path.join(job.jobDir, WEB_FAILURE_MD), renderWebFailureSummary(diagnosis), "utf8");
    job.failureDiagnosis = diagnosis;
    job.error = diagnosis.message;
    await this.audit.job(job, "failure_diagnosed", {
      stage: diagnosis.stage,
      code: diagnosis.code,
      message: diagnosis.message,
      exitCode: diagnosis.exitCode,
      manifestAvailable: diagnosis.manifestAvailable,
      inputIssueCount: diagnosis.inputInspection?.issueCount ?? 0,
    }, "error");
    return diagnosis;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicJob);
  }

  /** Refresh running cards from the authoritative Workflow Manifest. */
  async listWithProgress() {
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const job of jobs.filter((item) => item.status === "running")) {
      await this.refreshWorkflowReference(job);
      const manifest = job.manifestPath ? await readJson(job.manifestPath) : null;
      if (manifest) job.progress = calculateWorkflowProgress({ job, manifest, events: [], previous: job.progress?.percent });
    }
    return jobs.map(publicJob);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  validateCommon(payload) {
    const maxRounds = Number.parseInt(payload.maxRounds ?? "20", 10);
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 200) {
      throw new Error("maxRounds必须是1到200之间的整数");
    }
    const mode = payload.mode || "live";
    if (!new Set(["live", "offline"]).has(mode)) throw new Error("mode必须是live或offline");
    return { maxRounds, mode };
  }

  validateConcurrency(value, fallback = 3) {
    const concurrency = Number.parseInt(value ?? String(fallback), 10);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("并发数必须是1到16之间的整数");
    }
    return concurrency;
  }

  async createSession(payload) {
    const { maxRounds, mode } = this.validateCommon(payload);
    const sessionId = String(payload.sessionId ?? "").trim();
    if (!/^\d+$/.test(sessionId)) throw new Error("Session ID必须是纯数字");
    if (!String(payload.machineGrading ?? "").trim()) throw new Error("请填写机评结果");
    if (!String(payload.idaAnswer ?? "").trim()) throw new Error("请填写IDA答案");

    const id = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobDir = this.jobDirectory(id);
    const inputPath = path.join(jobDir, "input", `${sessionId}.json`);
    const workflowRoot = path.join(jobDir, "workflows");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeJsonAtomic(inputPath, {
      sessionId,
      query: String(payload.query ?? ""),
      gt: payload.gt ?? "",
      score: String(payload.score ?? ""),
      machineGrading: payload.machineGrading,
      idaAnswer: String(payload.idaAnswer),
    });
    const args = [
      "--env-file=.env",
      "scripts/run-trace-rca-session.mjs",
      "--input", inputPath,
      "--workflow-output-root", workflowRoot,
      "--trace-output-root", this.traceOutputRoot,
      "--max-rounds", String(maxRounds),
      "--mode", mode,
    ];
    if (payload.forceIngestion) args.push("--force-ingestion");
    const runtime = await runtimeSnapshot(this.projectRoot, this.env);
    const job = {
      id,
      type: "session",
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      jobDir,
      workflowRoot,
      inputPath,
      lineage: { rootJobId: id, parentJobId: null, attempt: 1, scope: "initial" },
      runtime,
      inputSummary: { sessionId, maxRounds, mode, forceIngestion: Boolean(payload.forceIngestion) },
      progress: { percent: 2, stage: "queued", label: "等待启动" },
      stdout: [],
      stderr: [],
      commandArgs: args,
    };
    await this.persist(job);
    await this.audit.job(job, "job_created", {
      type: job.type,
      attempt: job.lineage.attempt,
      input: { sessionId, maxRounds, mode, forceIngestion: Boolean(payload.forceIngestion) },
      inputSnapshot: path.relative(job.jobDir, inputPath),
    });
    this.start(job);
    return publicJob(job);
  }

  async createCsv(payload) {
    const { maxRounds, mode } = this.validateCommon(payload);
    const concurrency = this.validateConcurrency(payload.concurrency, payload.failFast ? 1 : 3);
    if (payload.failFast && concurrency > 1) throw new Error("首错停止模式要求并发数为1");
    const csvText = String(payload.csvText ?? "");
    if (!csvText.trim()) throw new Error("请选择或粘贴CSV文件");
    if (Buffer.byteLength(csvText, "utf8") > 20 * 1024 * 1024) throw new Error("CSV不能超过20MB");
    const id = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobDir = this.jobDirectory(id);
    const inputName = safeFileName(payload.fileName, "input.csv");
    const inputPath = path.join(jobDir, "input", inputName.endsWith(".csv") ? inputName : `${inputName}.csv`);
    const workflowRoot = path.join(jobDir, "workflows");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, csvText, "utf8");
    const args = [
      "--env-file=.env",
      "scripts/run-trace-rca-csv.mjs",
      "--csv", inputPath,
      "--workflow-output-root", workflowRoot,
      "--trace-output-root", this.traceOutputRoot,
      "--max-rounds", String(maxRounds),
      "--concurrency", String(concurrency),
      "--mode", mode,
    ];
    if (payload.forceIngestion) args.push("--force-ingestion");
    if (payload.failFast) args.push("--fail-fast");
    const runtime = await runtimeSnapshot(this.projectRoot, this.env);
    const job = {
      id,
      type: "csv",
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      jobDir,
      workflowRoot,
      inputPath,
      lineage: { rootJobId: id, parentJobId: null, attempt: 1, scope: "initial" },
      runtime,
      inputSummary: { fileName: inputName, bytes: Buffer.byteLength(csvText, "utf8"), maxRounds, concurrency, mode, forceIngestion: Boolean(payload.forceIngestion), failFast: Boolean(payload.failFast) },
      progress: { percent: 2, stage: "queued", label: "等待启动" },
      stdout: [],
      stderr: [],
      commandArgs: args,
    };
    await this.persist(job);
    await this.audit.job(job, "job_created", {
      type: job.type,
      attempt: job.lineage.attempt,
      input: job.inputSummary,
      inputSnapshot: path.relative(job.jobDir, inputPath),
    });
    this.start(job);
    return publicJob(job);
  }

  async resolveInputPath(job) {
    if (job.inputPath) return job.inputPath;
    const inputDirectory = path.join(job.jobDir, "input");
    const entries = await readdir(inputDirectory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length !== 1) throw new Error("原任务输入快照不存在或不唯一，无法安全复跑");
    return path.join(inputDirectory, files[0].name);
  }

  reserveRetryAttempt(rootJobId) {
    const current = this.attemptCounters.get(rootJobId) ?? Math.max(1, ...[...this.jobs.values()]
      .filter((item) => (item.lineage?.rootJobId || item.id) === rootJobId)
      .map((item) => Number(item.lineage?.attempt) || 1));
    const next = current + 1;
    this.attemptCounters.set(rootJobId, next);
    return next;
  }

  async loadAttemptFamily(job) {
    const rootJobId = job.lineage?.rootJobId || job.id;
    const family = [...this.jobs.values()]
      .filter((item) => (item.lineage?.rootJobId || item.id) === rootJobId)
      .sort((a, b) => (Number(a.lineage?.attempt) || 1) - (Number(b.lineage?.attempt) || 1));
    const attempts = [];
    for (const item of family) {
      await this.refreshWorkflowReference(item);
      attempts.push({
        id: item.id,
        status: item.status,
        attempt: Number(item.lineage?.attempt) || 1,
        scope: item.lineage?.scope || "initial",
        createdAt: item.createdAt,
        manifestPath: item.manifestPath,
        manifest: item.manifestPath ? await readJson(item.manifestPath) : null,
      });
    }
    return attempts;
  }

  async createRetry(parentId, payload = {}) {
    const parent = this.jobs.get(parentId);
    if (!parent) return null;
    if (!TERMINAL.has(parent.status)) throw new Error("运行中的任务不能复跑，请先等待结束或停止任务");
    const scope = payload.scope || "failed_only";
    if (!new Set(["failed_only", "full"]).has(scope)) throw new Error("复跑范围必须是failed_only或full");
    const { maxRounds, mode } = this.validateCommon({
      maxRounds: payload.maxRounds ?? parent.inputSummary?.maxRounds ?? 20,
      mode: payload.mode ?? parent.inputSummary?.mode ?? "live",
    });
    const concurrency = parent.type === "csv"
      ? this.validateConcurrency(payload.concurrency, parent.inputSummary?.concurrency ?? 1)
      : 1;
    if (parent.type === "csv" && parent.inputSummary?.failFast && concurrency > 1) {
      throw new Error("首错停止模式要求并发数为1");
    }
    if (scope === "failed_only" && parent.type === "csv" && parent.inputSummary?.failFast) {
      throw new Error("首错停止的批次可能包含未执行行，请使用完整重跑，避免遗漏任务");
    }
    await this.refreshWorkflowReference(parent);
    const manifest = parent.manifestPath ? await readJson(parent.manifestPath) : null;
    const family = await this.loadAttemptFamily(parent);
    const baseline = [...family].reverse().find((item) => item.scope === "full") ?? family.find((item) => item.scope === "initial") ?? family[0];
    const plannedCriteria = Number(baseline?.manifest?.counts?.plannedCriteria) || 0;
    const recordedCriteria = (baseline?.manifest?.items ?? []).filter((item) => item.criterionId).length;
    if (scope === "failed_only" && plannedCriteria > recordedCriteria) {
      throw new Error(`原任务有${plannedCriteria - recordedCriteria}个未执行GT，请使用完整重跑，避免遗漏任务`);
    }
    const allFailures = effectiveAttemptItems(family).filter((item) => item.status === "failed").map((item) => ({
      retryKey: retryItemKey(item),
      rowNumber: item.rowNumber,
      sessionId: item.sessionId,
      criterionId: item.criterionId,
      caseId: item.caseId,
      failureStage: item.stage,
      error: item.error,
      previousJobId: item.jobId,
      previousAttempt: item.attempt,
      previousRcaOutputDir: item.rcaOutputDir,
    }));
    const selectedKeys = Array.isArray(payload.selectedFailureKeys) ? new Set(payload.selectedFailureKeys.map(String)) : null;
    const failures = selectedKeys ? allFailures.filter((item) => selectedKeys.has(item.retryKey)) : allFailures;
    if (scope === "failed_only" && !allFailures.length) {
      throw new Error("原任务没有可识别的失败项；请选择完整重跑");
    }
    if (scope === "failed_only" && !failures.length) throw new Error("请至少选择一个失败项");
    if (scope === "failed_only" && selectedKeys && failures.length !== selectedKeys.size) throw new Error("复跑选择包含无效或过期的失败项");

    const rootJobId = parent.lineage?.rootJobId || parent.id;
    const attempt = this.reserveRetryAttempt(rootJobId);
    const id = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobDir = this.jobDirectory(id);
    const workflowRoot = path.join(jobDir, "workflows");
    const originalInput = await this.resolveInputPath(parent);
    const inputPath = path.join(jobDir, "input", path.basename(originalInput));
    const planPath = path.join(jobDir, "retry-plan.json");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await copyFile(originalInput, inputPath);
    const lineage = {
      rootJobId,
      parentJobId: parent.id,
      attempt,
      scope,
      reason: compactLine(payload.reason || ""),
      createdAt: now(),
      sourceManifestPath: parent.manifestPath,
      sourceStatus: parent.status,
    };
    const retrySelection = scope === "failed_only" ? failures : undefined;
    const runtime = await runtimeSnapshot(this.projectRoot, this.env);
    await writeJsonAtomic(planPath, {
      schemaVersion: "trace-rca-retry-plan-v1",
      lineage,
      runtime,
      parentRuntime: parent.runtime ?? null,
      execution: { mode, maxRounds, concurrency },
      ...(retrySelection ? { retrySelection } : {}),
      policy: {
        preserveParentArtifacts: true,
        reuseCompleteTrace: true,
        forceIngestion: false,
        freshRcaRun: true,
      },
    });

    const script = parent.type === "csv" ? "scripts/run-trace-rca-csv.mjs" : "scripts/run-trace-rca-session.mjs";
    const inputFlag = parent.type === "csv" ? "--csv" : "--input";
    const args = [
      "--env-file=.env", script,
      inputFlag, inputPath,
      "--retry-plan", planPath,
      "--workflow-output-root", workflowRoot,
      "--trace-output-root", this.traceOutputRoot,
      "--max-rounds", String(maxRounds),
      "--mode", mode,
    ];
    if (parent.type === "csv") args.push("--concurrency", String(concurrency));
    if (parent.type === "csv" && parent.inputSummary?.failFast) args.push("--fail-fast");
    const job = {
      id,
      type: parent.type,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      jobDir,
      workflowRoot,
      inputPath,
      retryPlanPath: planPath,
      lineage,
      runtime,
      inputSummary: {
        ...parent.inputSummary,
        maxRounds,
        ...(parent.type === "csv" ? { concurrency } : {}),
        mode,
        forceIngestion: false,
        retryScope: scope,
        retryItemCount: retrySelection?.length ?? null,
      },
      progress: { percent: 2, stage: "queued", label: scope === "failed_only" ? `等待复跑${failures.length}个失败项` : "等待完整重跑" },
      stdout: [],
      stderr: [],
      commandArgs: args,
    };
    await this.persist(job);
    await this.audit.job(job, "retry_created", {
      type: job.type,
      lineage,
      input: job.inputSummary,
      selectedFailureCount: retrySelection?.length ?? null,
      retryPlan: path.relative(job.jobDir, planPath),
    });
    this.start(job);
    return publicJob(job);
  }

  updateProgress(job, line) {
    const collection = line.match(/\[(\d+)\/(\d+)\]\s*(.+)/);
    if (collection) {
      const current = Number(collection[1]);
      const total = Number(collection[2]);
      job.progress = { percent: Math.round(8 + (current / total) * 22), stage: "trace", label: collection[3] };
      return;
    }
    // RCA progress is calculated from the workflow manifest and Agent events in
    // details(), so multi-GT jobs do not jump backwards when the next GT starts.
    if (/Scoring Gap|scoring_gap/i.test(line)) job.progress = { percent: Math.max(job.progress.percent, 31), stage: "gap", label: "定义评分差距" };
    else if (/investigation_round|调查轮/i.test(line)) job.progress = { percent: Math.max(job.progress.percent, 32), stage: "investigation", label: "Trace证据调查" };
    else if (/final_rca|最终RCA/i.test(line)) job.progress = { percent: Math.max(job.progress.percent, 33), stage: "report", label: "生成并校验报告" };
    else if (/Workflow status:\s*(.+)/.test(line)) job.progress = { percent: 100, stage: "done", label: line.split(":").slice(1).join(":").trim() };
  }

  start(job) {
    const child = spawn(process.execPath, job.commandArgs, {
      cwd: this.projectRoot,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(job.id, child);
    job.status = "running";
    job.pid = child.pid;
    job.startedAt = now();
    job.progress = { percent: 5, stage: "starting", label: "启动全链路任务" };
    void this.audit.job(job, "process_started", {
      pid: child.pid,
      script: job.type === "csv" ? "run-trace-rca-csv.mjs" : "run-trace-rca-session.mjs",
      mode: job.inputSummary?.mode,
      maxRounds: job.inputSummary?.maxRounds,
      concurrency: job.inputSummary?.concurrency ?? 1,
    });
    void this.persist(job);

    const capture = (stream, target) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const raw of lines) {
          const line = compactLine(raw);
          if (!line) continue;
          job[target].push(line);
          if (job[target].length > MAX_CAPTURED_LINES) job[target].shift();
          this.updateProgress(job, line);
          void this.audit.job(job, target === "stderr" ? "process_stderr" : "process_stdout", { line }, target === "stderr" ? "error" : "info");
        }
        void this.persist(job);
      });
      stream.on("end", () => {
        const line = compactLine(pending);
        if (line) job[target].push(line);
      });
    };
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");

    child.on("error", async (error) => {
      job.status = "failed";
      job.error = compactLine(error.message);
      job.progress = { ...job.progress, stage: "failed", label: "任务进程启动失败" };
      await this.audit.job(job, "process_start_failed", { message: error.message }, "error");
      await this.ensureFailureDiagnostics(job, null, { force: true });
      await this.persist(job);
    });
    child.on("close", async (code, signal) => {
      this.processes.delete(job.id);
      job.exitCode = code;
      job.signal = signal;
      job.finishedAt = now();
      await this.refreshWorkflowReference(job);
      const manifest = job.manifestPath ? await readJson(job.manifestPath) : null;
      if (job.status !== "cancelled") {
        job.status = manifest?.status || (code === 0 ? "completed" : "failed");
      }
      if (["failed", "completed_with_failures"].includes(job.status)) {
        await this.ensureFailureDiagnostics(job, manifest, { force: true });
      }
      job.progress = {
        percent: TERMINAL.has(job.status) ? 100 : job.progress.percent,
        stage: job.status,
        label: job.status === "completed" ? "归因报告已生成" : job.status === "cancelled" ? "任务已取消" : job.status,
      };
      await this.audit.job(job, "process_exited", {
        exitCode: code,
        signal,
        status: job.status,
        manifestPath: job.manifestPath ? path.relative(job.jobDir, job.manifestPath) : null,
        error: job.error,
      }, ["failed", "completed_with_failures"].includes(job.status) ? "error" : "info");
      await this.persist(job);
    });
  }

  async refreshWorkflowReference(job) {
    if (job.workflowOutputDir) return;
    let entries;
    try { entries = await readdir(job.workflowRoot, { withFileTypes: true }); } catch { return; }
    const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    if (!directories.length) return;
    job.workflowOutputDir = path.join(job.workflowRoot, directories[0].name);
    job.manifestPath = path.join(job.workflowOutputDir, "workflow-manifest.json");
  }

  async details(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    await this.refreshWorkflowReference(job);
    let manifest = job.manifestPath ? await readJson(job.manifestPath) : null;
    if (job.type === "csv" && manifest && !manifest.executionPlan && job.inputPath) {
      try {
        const parsed = await readRcaCsv(job.inputPath);
        const records = parsed.records.filter((record) => !isFullScore(record.score));
        manifest = {
          ...manifest,
          executionPlan: {
            schemaVersion: "trace-rca-execution-plan-v1", unit: "csv_row", inputRows: parsed.records.length,
            fullScoreRows: parsed.records.length - records.length, nonFullScoreRows: records.length,
            records: records.map((record) => ({ rowNumber: record.rowNumber, sessionId: String(record.sessionId ?? ""), initialStatus: record.sourceRunStatus ? "source_run_failed" : "queued" })),
            source: "web_input_fallback",
          },
        };
      } catch {}
    }
    const files = await walk(job.jobDir);
    const artifacts = [];
    for (const file of files) {
      if (!/\.(?:md|json|jsonl)$/.test(file) || file.endsWith(JOB_FILE)) continue;
      const relativePath = path.relative(job.jobDir, file);
      const name = path.basename(file);
      const criterionId = criterionIdFromPath(relativePath);
      const info = await stat(file);
      artifacts.push({
        path: relativePath,
        name,
        label: artifactLabel(name, criterionId),
        criterionId,
        sessionId: sessionIdFromPath(relativePath),
        bytes: info.size,
        kind: file.endsWith("rca-report.md") ? "report" : /failure-(?:summary|diagnosis)|web-failure-summary/.test(file) ? "failure" : /(?:agent-run|web-job)\.(?:md|jsonl)$/.test(file) ? "log" : "data",
      });
    }
    const eventFiles = files.filter((file) => file.endsWith("agent-run.jsonl"));
    const events = [];
    for (const file of eventFiles) {
      const text = await readFile(file, "utf8");
      const relativePath = path.relative(job.jobDir, file);
      const criterionId = criterionIdFromPath(relativePath);
      const sessionId = sessionIdFromPath(relativePath);
      for (const line of text.split("\n").filter(Boolean)) {
        try { events.push({ ...JSON.parse(line), criterionId, sessionId }); } catch {}
      }
    }
    events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const webEvents = [];
    const webLogPath = path.join(job.jobDir, WEB_JOB_LOG);
    try {
      const text = await readFile(webLogPath, "utf8");
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          webEvents.push({
            timestamp: entry.timestamp,
            phase: "web",
            type: entry.event,
            summary: entry.data?.message || entry.data?.line || entry.data?.status || entry.event,
            level: entry.level,
          });
        } catch {}
      }
    } catch {}
    job.progress = calculateWorkflowProgress({ job, manifest, events, previous: job.progress?.percent });
    const attemptsWithManifests = await this.loadAttemptFamily(job);
    const relatedJobs = attemptsWithManifests.filter((item) => item.id !== job.id).map(({ manifest: _manifest, manifestPath: _manifestPath, ...item }) => item);
    const chainSummary = summarizeEffectiveItems(attemptsWithManifests);
    const retryBaseline = [...attemptsWithManifests].reverse().find((item) => item.scope === "full") ?? attemptsWithManifests.find((item) => item.scope === "initial");
    const baselineIncomplete = (Number(retryBaseline?.manifest?.counts?.plannedCriteria) || 0) > (retryBaseline?.manifest?.items ?? []).filter((entry) => entry.criterionId).length;
    const failedItems = effectiveAttemptItems(attemptsWithManifests).filter((item) => item.status === "failed").map((item) => ({
      retryKey: retryItemKey(item),
      rowNumber: item.rowNumber,
      sessionId: item.sessionId,
      criterionId: item.criterionId,
      caseId: item.caseId,
      stage: item.stage,
      error: item.error?.message,
      previousJobId: item.jobId,
      previousAttempt: item.attempt,
    }));
    const reportTree = buildReportTree({ job, manifest, artifacts });
    return {
      ...publicJob(job), manifest, artifacts, reportTree, events: events.slice(-160), webEvents: webEvents.slice(-80), relatedJobs, chainSummary,
      retry: {
        canRetryFull: TERMINAL.has(job.status),
        canRetryFailed: TERMINAL.has(job.status) && failedItems.length > 0 && !(job.type === "csv" && job.inputSummary?.failFast) && !baselineIncomplete,
        failedItems,
      },
    };
  }

  async artifact(id, relativePath) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const resolved = path.resolve(job.jobDir, String(relativePath || ""));
    if (resolved !== job.jobDir && !resolved.startsWith(`${job.jobDir}${path.sep}`)) throw new Error("非法产物路径");
    if (!/\.(?:md|json|jsonl)$/.test(resolved)) throw new Error("不支持读取该文件类型");
    return { path: resolved, content: await readFile(resolved, "utf8") };
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return publicJob(job);
    job.status = "cancelled";
    job.progress = { ...job.progress, stage: "cancelled", label: "正在停止任务" };
    const child = this.processes.get(id);
    if (child) child.kill("SIGTERM");
    await this.audit.job(job, "cancel_requested", { pid: job.pid ?? null }, "warn");
    await this.persist(job);
    return publicJob(job);
  }
}
