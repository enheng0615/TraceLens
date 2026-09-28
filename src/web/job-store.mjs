import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebAuditLogger } from "./audit-logger.mjs";
import { buildJobDiagnosis, renderWebFailureSummary } from "./job-diagnostics.mjs";
import { isFullScore, readRcaCsv } from "../workflows/trace-rca/index.mjs";
import { TERMINAL_JOB_STATUSES, WEB_FAILURE_JSON, WEB_FAILURE_MD, WEB_JOB_LOG } from "./job-model.mjs";
import { calculateWorkflowProgress } from "./job-progress.mjs";
import { buildReportTree, artifactLabel, criterionIdFromPath, sessionIdFromPath } from "./report-tree.mjs";
import { effectiveAttemptItems, retryItemKey, selectableSessionCandidates, summarizeEffectiveItems } from "./retry-state.mjs";

// Backward-compatible exports for callers that imported these projections here.
export { calculateWorkflowProgress, buildReportTree };

const JOB_FILE = "job.json";

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
      if (!TERMINAL_JOB_STATUSES.has(job.status)) {
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
    if (!TERMINAL_JOB_STATUSES.has(parent.status)) throw new Error("运行中的任务不能复跑，请先等待结束或停止任务");
    const scope = payload.scope || "failed_only";
    if (!new Set(["failed_only", "selected_sessions", "full"]).has(scope)) {
      throw new Error("复跑范围必须是failed_only、selected_sessions或full");
    }
    if (scope === "selected_sessions" && parent.type !== "csv") {
      throw new Error("指定Session复跑只适用于CSV批次");
    }
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

    const sessionCandidates = selectableSessionCandidates(manifest);
    const sessionCandidateByKey = new Map(sessionCandidates.map((item) => [item.retryKey, item]));
    const selectedSessionKeys = scope === "selected_sessions" && Array.isArray(payload.selectedSessionKeys)
      ? new Set(payload.selectedSessionKeys.map(String))
      : null;
    if (scope === "selected_sessions" && !selectedSessionKeys?.size) throw new Error("请至少选择一个Session");
    const selectedSessions = scope === "selected_sessions"
      ? [...selectedSessionKeys].map((key) => sessionCandidateByKey.get(key)).filter(Boolean)
      : [];
    if (scope === "selected_sessions" && selectedSessions.length !== selectedSessionKeys.size) {
      throw new Error("Session复跑选择包含无效或过期项，请刷新批次后重新选择");
    }

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
    const retrySelection = scope === "failed_only"
      ? failures
      : scope === "selected_sessions"
        ? selectedSessions.flatMap((session) => session.rowNumbers.length
          ? session.rowNumbers.map((rowNumber) => ({
              rowNumber,
              sessionId: session.sessionId,
              selectionSource: "selected_session",
              previousJobId: parent.id,
              previousAttempt: Number(parent.lineage?.attempt) || 1,
            }))
          : [{
              sessionId: session.sessionId,
              selectionSource: "selected_session",
              previousJobId: parent.id,
              previousAttempt: Number(parent.lineage?.attempt) || 1,
            }])
        : undefined;
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
        retrySessionCount: scope === "selected_sessions" ? selectedSessions.length : null,
      },
      progress: {
        percent: 2,
        stage: "queued",
        label: scope === "failed_only"
          ? `等待复跑${failures.length}个失败项`
          : scope === "selected_sessions" ? `等待复跑${selectedSessions.length}个Session` : "等待完整重跑",
      },
      stdout: [],
      stderr: [],
      commandArgs: args,
    };
    await this.persist(job);
    await this.audit.job(job, "retry_created", {
      type: job.type,
      lineage,
      input: job.inputSummary,
      selectedFailureCount: scope === "failed_only" ? retrySelection?.length ?? null : null,
      selectedSessionCount: scope === "selected_sessions" ? selectedSessions.length : null,
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
        percent: TERMINAL_JOB_STATUSES.has(job.status) ? 100 : job.progress.percent,
        stage: job.status,
        label: job.status === "completed" ? "归因报告已生成" : job.status === "completed_with_evidence_gaps" ? "归因完成，Trace局部不完整" : job.status === "cancelled" ? "任务已取消" : job.status,
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
        canRetryFull: TERMINAL_JOB_STATUSES.has(job.status),
        canRetryFailed: TERMINAL_JOB_STATUSES.has(job.status) && failedItems.length > 0 && !(job.type === "csv" && job.inputSummary?.failFast) && !baselineIncomplete,
        canRetrySelectedSessions: TERMINAL_JOB_STATUSES.has(job.status) && job.type === "csv" && selectableSessionCandidates(manifest).length > 0,
        selectableSessions: selectableSessionCandidates(manifest),
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
    if (TERMINAL_JOB_STATUSES.has(job.status)) return publicJob(job);
    job.status = "cancelled";
    job.progress = { ...job.progress, stage: "cancelled", label: "正在停止任务" };
    const child = this.processes.get(id);
    if (child) child.kill("SIGTERM");
    await this.audit.job(job, "cancel_requested", { pid: job.pid ?? null }, "warn");
    await this.persist(job);
    return publicJob(job);
  }
}
