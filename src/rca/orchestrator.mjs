import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { recoverCheckpoint, writeCheckpoint } from "./checkpoint.mjs";
import { validateRcaCase } from "./case-schema.mjs";
import { buildInvestigationPolicy } from "./investigation-policy.mjs";
import { EvidenceLedger } from "./evidence-ledger.mjs";
import { evaluateInvestigationCoverage } from "./coverage-validator.mjs";
import { PiJsonAgent } from "./pi-json-agent.mjs";
import { OfflineSimulationAgent } from "./offline-simulation-agent.mjs";
import { RCA_SYSTEM_PROMPT, finalReportPrompt, investigationPrompt } from "./prompts.mjs";
import { RunLogger } from "./run-logger.mjs";
import { scoringGapPrompt, validateScoringGapTarget } from "./scoring-gap.mjs";
import { TraceRepository, traceText } from "./trace-repository.mjs";
import { executeTraceTool, normalizeAction } from "./trace-tools.mjs";
import { renderReportMarkdown } from "./report-renderer.mjs";
import { validateReportEvidenceConsistency } from "./report-consistency-validator.mjs";
import { renderRunSummary } from "./run-summary.mjs";
import { renderFailureSummary } from "./failure-summary.mjs";
import { buildWithinPromptBudget } from "./context-budget.mjs";
import {
  actionSubjectKey,
  coverageSignature,
  updateStallCount,
  workingState,
} from "./investigation-state.mjs";

function actionKey(action) {
  return JSON.stringify([action.tool, action.arguments]);
}

function validateDecision(decision) {
  if (!decision || typeof decision !== "object") throw new Error("decision must be an object");
  if (!Array.isArray(decision.actions)) throw new Error("decision.actions must be an array");
  if (decision.actions.length > 3) throw new Error("at most 3 actions are allowed per round");
  return decision;
}

async function validateRawRefs(ledger, repository) {
  const errors = [];
  let checked = 0;
  let checkedSearches = 0;
  for (const entry of ledger.entries) {
    for (const ref of entry.rawRefs ?? []) {
      const span = repository.byId.get(ref.spanId);
      if (!span) {
        errors.push(`${entry.evidenceId}: unknown span ${ref.spanId}`);
        continue;
      }
      const actual = traceText.sha256(span[ref.field]);
      checked += 1;
      if (actual !== ref.contentSha256) {
        errors.push(`${entry.evidenceId}: SHA mismatch ${ref.spanId}.${ref.field}`);
      }
    }
  }
  for (const entry of ledger.entries.filter((item) => item.tool === "search_trace")) {
    const rerun = repository.search(entry.arguments);
    checkedSearches += 1;
    if (
      rerun.totalMatches !== entry.result.totalMatches ||
      rerun.coverage.corpusSha256 !== entry.result.coverage?.corpusSha256 ||
      rerun.coverage.complete !== true
    ) {
      errors.push(`${entry.evidenceId}: deterministic search verification failed`);
    }
  }
  return {
    valid: errors.length === 0 && checked > 0 && checkedSearches > 0,
    checkedRawRefs: checked,
    checkedDeterministicSearches: checkedSearches,
    errors,
  };
}

function checkpointState({
  runId,
  mode,
  casePath,
  traceRoot,
  target,
  overview,
  executionSteps,
  ledger,
  decisions,
  executed,
  actionAttempts,
  stallCount,
  nextRound,
}) {
  return {
    runId,
    mode,
    casePath: path.resolve(casePath),
    traceRoot: path.resolve(traceRoot),
    target,
    overview,
    executionSteps,
    ledgerEntries: ledger.entries,
    decisions,
    executedActions: [...executed],
    actionAttempts: actionAttempts ?? {},
    stallCount: stallCount ?? 0,
    nextRound,
  };
}

async function saveCheckpoint(outputDir, state) {
  await writeCheckpoint(outputDir, checkpointState(state));
}

async function initializeFreshRun({ caseData, casePath, traceRoot, outputRoot, outputDir: requestedOutputDir, mode, env }) {
  const runId = `${caseData.caseId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = requestedOutputDir ? path.resolve(requestedOutputDir) : path.resolve(outputRoot, runId);
  const logger = new RunLogger(outputDir);
  const state = {
    runId,
    outputDir,
    mode,
    casePath,
    traceRoot,
    logger,
    decisions: [],
    executed: new Set(),
    actionAttempts: {},
    stallCount: 0,
    nextRound: 1,
  };

  try {
    await mkdir(outputDir, { recursive: true });
    await logger.initialize({ runId, sessionId: caseData.sessionId, startedAt: new Date().toISOString() });
    const agent = mode === "offline" ? new OfflineSimulationAgent({ logger }) : new PiJsonAgent({ env, logger });
    state.agent = agent;
    const repository = await TraceRepository.open(traceRoot);
    state.repository = repository;
    const ledger = new EvidenceLedger();
    state.ledger = ledger;

    await logger.event({
      phase: "bootstrap",
      actor: "orchestrator",
      type: "run_started",
      summary: "载入案例输入和不可变Sophon Trace",
      data: {
        caseId: caseData.caseId,
        sessionId: caseData.sessionId,
        traceRoot: path.resolve(traceRoot),
        mode,
        model: agent.modelInfo(),
      },
    });

    let gapValidation;
    let gapFeedback = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const gapCandidate = await agent.invoke({
        phase: "scoring_gap",
        systemPrompt: "你负责在Trace调查前定义中立评分差距。不得做任何原因判断。",
        prompt: `${scoringGapPrompt(caseData)}${gapFeedback}`,
        retryInstruction: "必须保持官方criterion原文，所有引用必须是来源精确子串，禁止因果语言",
      });
      gapValidation = validateScoringGapTarget(gapCandidate, caseData);
      await logger.event({
        phase: "scoring_gap",
        actor: "validator",
        type: gapValidation.valid ? "validation_passed" : "validation_failed",
        summary: gapValidation.valid
          ? "Scoring Gap Target通过来源与中立性校验"
          : `Scoring Gap Target第${attempt}次业务校验失败`,
        data: { errors: gapValidation.errors, quoteAlignments: gapValidation.quoteAlignments },
      });
      if (gapValidation.valid) break;
      gapFeedback = `\n\n上一次候选未通过确定性业务校验。请重新生成完整JSON并修复以下错误：\n- ${gapValidation.errors.join("\n- ")}\nanswerState.relevantExcerpts.quote必须直接逐字复制IDA最终答案原文，包括其中的Markdown标记和空白。`;
    }
    if (!gapValidation?.valid) {
      throw new Error(`Scoring Gap validation failed after retry: ${gapValidation?.errors?.join("; ")}`);
    }
    state.gapValidation = gapValidation;
    const target = gapValidation.target;
    state.target = target;
    await writeFile(path.join(outputDir, "scoring-gap-target.json"), `${JSON.stringify(target, null, 2)}\n`, "utf8");

    const overview = repository.getOverview();
    const executionSteps = repository.listExecutionSteps({ maxSummaryChars: 260 });
    state.overview = overview;
    state.executionSteps = executionSteps;
    ledger.add({
      source: "program",
      tool: "get_trace_overview",
      arguments: {},
      purpose: "建立无偏Trace全局地图",
      result: overview,
    });
    ledger.add({
      source: "program",
      tool: "list_execution_steps",
      arguments: { maxSummaryChars: 260 },
      purpose: "建立客观主执行链",
      result: executionSteps,
    });
    await logger.event({
      phase: "trace_map",
      actor: "trace_tool",
      type: "initial_context_loaded",
      summary: "向Agent提供Trace总览和主执行链，不提供根因标签或疑似Span",
      data: { overview, executionSteps },
    });

    await saveCheckpoint(outputDir, state);
    state.checkpointAvailable = true;
    return state;
  } catch (error) {
    await tryPersistFailureArtifacts({ state, error });
    throw error;
  }
}

async function archiveResumeSnapshot(outputDir) {
  const archiveDir = path.join(outputDir, "resume-history", new Date().toISOString().replace(/[:.]/g, "-"));
  const candidates = ["failure-summary.md", "validation.partial.json", "evidence-ledger.partial.json", "checkpoint.json"];
  let copied = 0;
  for (const name of candidates) {
    try {
      await mkdir(archiveDir, { recursive: true });
      await copyFile(path.join(outputDir, name), path.join(archiveDir, name));
      copied += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return copied ? archiveDir : null;
}

async function initializeResumedRun({ caseData, casePath, traceRoot, resumeDir, mode, env }) {
  const outputDir = path.resolve(resumeDir);
  const logger = new RunLogger(outputDir);
  const state = { outputDir, mode, casePath, traceRoot, logger, decisions: [] };

  try {
    const checkpoint = await recoverCheckpoint(outputDir);
    const resumeArchiveDir = await archiveResumeSnapshot(outputDir);
    state.runId = checkpoint.runId;
    if (checkpoint.mode !== mode) {
      throw new Error(`Resume mode mismatch: checkpoint=${checkpoint.mode}, requested=${mode}`);
    }
    if (checkpoint.casePath && path.resolve(casePath) !== checkpoint.casePath) {
      throw new Error(`Resume case mismatch: ${path.resolve(casePath)} != ${checkpoint.casePath}`);
    }
    if (checkpoint.traceRoot && path.resolve(traceRoot) !== checkpoint.traceRoot) {
      throw new Error(`Resume trace root mismatch: ${path.resolve(traceRoot)} != ${checkpoint.traceRoot}`);
    }

    await logger.resume();
    const agent = mode === "offline" ? new OfflineSimulationAgent({ logger }) : new PiJsonAgent({ env, logger });
    state.agent = agent;
    const repository = await TraceRepository.open(traceRoot);
    state.repository = repository;
    const ledger = new EvidenceLedger();
    ledger.entries = checkpoint.ledgerEntries;
    state.ledger = ledger;
    const gapValidation = validateScoringGapTarget(checkpoint.target, caseData);
    if (!gapValidation.valid) {
      throw new Error(`Resume target validation failed: ${gapValidation.errors.join("; ")}`);
    }

    Object.assign(state, {
      target: gapValidation.target,
      overview: checkpoint.overview,
      executionSteps: checkpoint.executionSteps,
      decisions: checkpoint.decisions ?? [],
      executed: new Set(checkpoint.executedActions ?? []),
      actionAttempts: checkpoint.actionAttempts ?? {},
      stallCount: checkpoint.stallCount ?? 0,
      nextRound: checkpoint.nextRound ?? 1,
      gapValidation,
    });
    await logger.event({
      phase: "resume",
      actor: "orchestrator",
      type: "run_resumed",
      summary: `从第${state.nextRound}轮恢复live调查，复用${ledger.entries.length}条已验证证据`,
      data: {
        runId: state.runId,
        mode,
        nextRound: state.nextRound,
        evidenceEntries: ledger.entries.length,
        recoveredFromEventLog: checkpoint.recoveredFromEventLog === true,
        resumeArchiveDir,
        model: agent.modelInfo(),
      },
    });
    await saveCheckpoint(outputDir, state);
    state.checkpointAvailable = true;
    return state;
  } catch (error) {
    await tryPersistFailureArtifacts({ state, error });
    throw error;
  }
}

async function persistFailureArtifacts({ state, error, coverage, investigationPolicy }) {
  if (!state?.outputDir) return;
  const { outputDir, runId, mode, agent, target, decisions = [], ledger, casePath, traceRoot, logger } = state;
  error.rcaOutputDir = outputDir;
  const snapshot = {
    status: "failed",
    failedAt: new Date().toISOString(),
    error: { name: error?.name ?? "Error", code: error?.code, message: traceText.redact(error?.message ?? String(error)) },
    coverage: coverage ?? null,
    investigationPolicy: investigationPolicy ?? null,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "evidence-ledger.partial.json"),
    `${JSON.stringify(ledger?.entries ?? [], null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "validation.partial.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  const failureSummaryPath = path.join(outputDir, "failure-summary.md");
  await writeFile(failureSummaryPath, renderFailureSummary({
    runId, mode, modelInfo: agent?.modelInfo?.(), target, decisions, ledger,
    coverage, error: snapshot.error, casePath: path.resolve(casePath), traceRoot: path.resolve(traceRoot), outputDir,
    resumable: state.checkpointAvailable === true,
  }), "utf8");
  error.failureSummaryPath = failureSummaryPath;
  try {
    await logger?.event({
      phase: "failed",
      actor: "orchestrator",
      type: "run_failed",
      summary: snapshot.error.message,
      data: { outputDir, failureSummary: failureSummaryPath, coverage },
    });
  } catch {
    // The durable failure summary is authoritative; audit-log append is best effort.
  }
}

/** Failure diagnostics must never replace the original RCA error. */
async function tryPersistFailureArtifacts(args) {
  const { error, state } = args;
  if (state?.outputDir) error.rcaOutputDir = state.outputDir;
  try {
    await persistFailureArtifacts(args);
  } catch (artifactError) {
    error.failureArtifactError = traceText.redact(artifactError?.message ?? String(artifactError));
    try {
      await state?.logger?.event({
        phase: "failed",
        actor: "orchestrator",
        type: "failure_artifact_write_failed",
        summary: error.failureArtifactError,
        data: { originalError: traceText.redact(error?.message ?? String(error)) },
      });
    } catch {
      // Preserve the original business/runtime error even if diagnostics are unavailable.
    }
  }
}

export async function runRcaCase({
  casePath,
  traceRoot,
  outputRoot,
  outputDir: requestedOutputDir,
  maxRounds = 8,
  env = process.env,
  mode = "live",
  resumeDir,
}) {
  const resolvedCasePath = path.resolve(casePath);
  const resolvedTraceRoot = path.resolve(traceRoot);
  const caseData = validateRcaCase(JSON.parse(await readFile(resolvedCasePath, "utf8")));
  const state = resumeDir
    ? await initializeResumedRun({
        caseData,
        casePath: resolvedCasePath,
        traceRoot: resolvedTraceRoot,
        resumeDir,
        mode,
        env,
      })
    : await initializeFreshRun({
        caseData,
        casePath: resolvedCasePath,
        traceRoot: resolvedTraceRoot,
        outputRoot,
        outputDir: requestedOutputDir,
        mode,
        env,
      });

  const {
    runId,
    outputDir,
    logger,
    agent,
    repository,
    ledger,
    target,
    overview,
    executionSteps,
    decisions,
    executed,
    actionAttempts,
    gapValidation,
  } = state;

  let investigationPolicy;
  let coverage;
  try {
  investigationPolicy = buildInvestigationPolicy(caseData, target, { overview, executionSteps });
  const coverageOptions = { policy: investigationPolicy, executionSteps };
  coverage = evaluateInvestigationCoverage(ledger, coverageOptions);
  let stallCount = state.stallCount ?? 0;
  const maxPromptChars = Number.isFinite(agent.maxPromptChars)
    ? agent.maxPromptChars
    : Number.parseInt(env.RCA_MAX_MODEL_PROMPT_CHARS || "65000", 10);
  let coverageFeedback = coverage.complete
    ? "必要覆盖已完成。请检查上下游因果、替代解释和证据边界；充分时可结束。"
    : `以下检查尚未完成，必须通过工具补齐后才能结束：\n- ${coverage.missing.join("\n- ")}`;
  let nextRound = state.nextRound;

  let agentReadyForConclusion = false;
  let conclusionReason = null;
  for (let round = nextRound; round <= maxRounds; round += 1) {
    const context = buildWithinPromptBudget({
      stage: `investigation_round_${round}`,
      maxPromptChars,
      builder: ({ evidenceBudget, executionBudget }) => investigationPrompt({
        caseData,
        target,
        overview,
        executionSteps,
        ledger,
        round,
        coverageFeedback,
        traceEvidenceBoundary: caseData.traceEvidenceBoundary,
        workingState: workingState({ decisions, coverage, stallCount, actionAttempts }),
        evidenceBudget,
        executionBudget,
      }),
    });
    const { prompt } = context;
    await logger.event({
      phase: `investigation_round_${round}`,
      actor: "orchestrator",
      type: "model_context_prepared",
      summary: `已生成受预算约束的调查上下文：${prompt.length}字符`,
      data: {
        promptChars: prompt.length,
        evidenceEntries: ledger.entries.length,
        budgetPlan: context.plan,
        compacted: context.compacted,
      },
    });
    const decision = validateDecision(
      await agent.invoke({
        phase: `investigation_round_${round}`,
        systemPrompt: RCA_SYSTEM_PROMPT,
        prompt,
        retryInstruction: "actions必须为数组且每轮不超过3个，只使用允许的Trace工具",
      }),
    );
    await logger.event({
      phase: `investigation_round_${round}`,
      actor: "rca_agent",
      type: "explicit_investigation_decision",
      summary: decision.analysisSummary ?? "Agent提交下一步调查动作",
      data: decision,
    });

    const previousEvidenceCount = ledger.entries.length;
    const previousCoverageSignature = coverageSignature(coverage);
    for (const rawAction of decision.actions) {
      const action = normalizeAction(rawAction);
      const key = actionKey(action);
      const subjectKey = actionSubjectKey(action);
      const priorAttempts = actionAttempts[subjectKey] ?? 0;
      if (priorAttempts >= 2) {
        await logger.event({
          phase: `investigation_round_${round}`,
          actor: "orchestrator",
          type: "action_attempt_budget_exhausted",
          summary: `同一调查主题已尝试${priorAttempts}次，不再重复读取：${subjectKey}`,
          data: { action, subjectKey, attempts: priorAttempts, limit: 2 },
        });
        continue;
      }
      actionAttempts[subjectKey] = priorAttempts + 1;
      if (executed.has(key)) {
        const refreshed = ledger.refreshExisting({
          tool: action.tool,
          arguments: action.arguments,
          purpose: `上下文刷新：${action.purpose || action.tool}`,
          round,
        });
        await logger.event({
          phase: `investigation_round_${round}`,
          actor: "orchestrator",
          type: refreshed ? "existing_evidence_reused" : "duplicate_action_rejected",
          summary: refreshed
            ? `未重复访问Trace；继续引用既有证据${refreshed.evidenceId}`
            : `拒绝无法关联既有证据的重复调用 ${action.tool}`,
          data: refreshed ?? action,
        });
        continue;
      }
      executed.add(key);
      await logger.event({
        phase: `investigation_round_${round}`,
        actor: "rca_agent",
        type: "trace_tool_requested",
        summary: action.purpose || `请求执行${action.tool}`,
        data: action,
      });
      try {
        const result = await executeTraceTool(repository, action);
        const evidence = ledger.add({
          source: "agent",
          tool: action.tool,
          arguments: action.arguments,
          purpose: action.purpose,
          result,
        });
        await logger.event({
          phase: `investigation_round_${round}`,
          actor: "trace_tool",
          type: "trace_tool_result",
          summary: `${action.tool}执行完成，登记为${evidence.evidenceId}`,
          data: evidence,
        });
        await saveCheckpoint(outputDir, {
          ...state,
          decisions,
          executed,
          actionAttempts,
          stallCount,
          nextRound: round,
        });
      } catch (error) {
        await logger.event({
          phase: `investigation_round_${round}`,
          actor: "trace_tool",
          type: "trace_tool_error",
          summary: error.message,
          data: action,
        });
      }
    }

    coverage = evaluateInvestigationCoverage(ledger, coverageOptions);
    const progress = updateStallCount({
      previousEvidenceCount,
      evidenceCount: ledger.entries.length,
      previousCoverageSignature,
      coverage,
      stallCount,
    });
    stallCount = progress.stallCount;
    decisions.push({ round, decision, coverage, progress });
    nextRound = round + 1;
    await logger.event({
      phase: `investigation_round_${round}`,
      actor: "validator",
      type: coverage.complete ? "coverage_complete" : "coverage_incomplete",
      summary: coverage.complete ? "固定调查目标已覆盖" : `仍缺少${coverage.missing.length}项必要调查`,
      data: { ...coverage, progress, actionAttempts },
    });
    await saveCheckpoint(outputDir, {
      ...state,
      decisions,
      executed,
      actionAttempts,
      stallCount,
      nextRound,
    });
    if (coverage.complete && decision.readyForConclusion) {
      agentReadyForConclusion = true;
      conclusionReason = "agent_ready_after_coverage";
      break;
    }
    if (coverage.complete && stallCount >= 3) {
      agentReadyForConclusion = true;
      conclusionReason = "orchestrator_converged_after_three_no_progress_rounds";
      await logger.event({
        phase: `investigation_round_${round}`,
        actor: "orchestrator",
        type: "investigation_auto_converged",
        summary: "固定覆盖已完成且连续三轮无新增证据，停止重复调查；剩余问题必须在报告中标记为unobservable",
        data: { stallCount, coverageComplete: true },
      });
      break;
    }
    if (!coverage.complete && stallCount >= 3) {
      const error = new Error(`Investigation stalled before required coverage completed: ${coverage.missing.join("; ")}`);
      error.code = "RCA_INVESTIGATION_STALLED";
      error.remediation = "检查未覆盖项与动作预算；修正后仅从当前Checkpoint恢复，不要重跑已完成的Trace读取。";
      throw error;
    }
    coverageFeedback = coverage.complete
      ? `${stallCount ? `已连续${stallCount}轮无新增证据。` : ""}必要覆盖已完成。请关闭已解决问题；Trace不能回答的剩余问题标记为unobservable，不得重复读取。`
      : `${stallCount ? `已连续${stallCount}轮无新增证据；不得重复同类读取。\n` : ""}以下检查尚未完成，必须通过不同且有效的工具动作补齐：\n- ${coverage.missing.join("\n- ")}`;
    // Let the post-loop guards report the precise state. A no-op final round
    // may mean either incomplete coverage or complete coverage without an
    // explicit conclusion; those are operationally different failures.
  }
  if (!coverage.complete) {
    throw new Error(`Investigation coverage incomplete: ${coverage.missing.join("; ")}`);
  }
  if (!agentReadyForConclusion) {
    // maxRounds is a safety budget, not a requirement that the model emit one
    // magic boolean. Once deterministic coverage is complete, the
    // orchestrator may close the investigation and force uncertain residuals
    // into the report's unobservable boundary.
    agentReadyForConclusion = true;
    conclusionReason = "orchestrator_converged_at_round_budget";
    await logger.event({
      phase: "investigation_stop",
      actor: "orchestrator",
      type: "round_budget_converged",
      summary: `已达到maxRounds=${maxRounds}；固定覆盖已完成，基于现有证据收束并要求将剩余问题标记为unobservable`,
      data: { maxRounds, nextRound, coverageComplete: coverage.complete },
    });
  }

  let report;
  let citationValidation;
  let evidenceConsistencyValidation;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const correction = attempt === 1
      ? ""
      : `\n\n上次报告校验失败。证据编号：${JSON.stringify(citationValidation)}；语义一致性：${JSON.stringify(evidenceConsistencyValidation)}。请只修正不一致项。`;
    const context = buildWithinPromptBudget({
      stage: "final_rca",
      maxPromptChars,
      builder: ({ evidenceBudget }) => `${finalReportPrompt({ caseData, target, overview, ledger, evidenceBudget })}${correction}`,
    });
    const { prompt } = context;
    await logger.event({
      phase: "final_rca",
      actor: "orchestrator",
      type: "model_context_prepared",
      summary: `已生成受预算约束的最终报告上下文：${prompt.length}字符`,
      data: { promptChars: prompt.length, evidenceEntries: ledger.entries.length, budgetPlan: context.plan, compacted: context.compacted },
    });
    report = await agent.invoke({
      phase: "final_rca",
      systemPrompt: RCA_SYSTEM_PROMPT,
      prompt,
      retryInstruction: "必须返回规定JSON，并且evidenceIds只能引用证据账本中存在的EV编号",
    });
    citationValidation = ledger.validateCitations(report);
    evidenceConsistencyValidation = validateReportEvidenceConsistency(report, ledger);
    await logger.event({
      phase: "final_rca",
      actor: "validator",
      type:
        citationValidation.valid && evidenceConsistencyValidation.valid
          ? "report_validation_passed"
          : "report_validation_failed",
      summary:
        citationValidation.valid && evidenceConsistencyValidation.valid
          ? "最终RCA证据编号与确定性语义一致性校验通过"
          : "最终RCA未通过证据编号或确定性语义一致性校验",
      data: { citationValidation, evidenceConsistencyValidation },
    });
    if (citationValidation.valid && evidenceConsistencyValidation.valid) break;
  }
  if (!citationValidation.valid) throw new Error("Final RCA evidence citation validation failed");
  if (!evidenceConsistencyValidation.valid) {
    throw new Error(`Final RCA evidence consistency validation failed: ${evidenceConsistencyValidation.errors.join("; ")}`);
  }

  const rawEvidenceValidation = await validateRawRefs(ledger, repository);
  await logger.event({
    phase: "final_rca",
    actor: "validator",
    type: rawEvidenceValidation.valid ? "raw_evidence_validation_passed" : "raw_evidence_validation_failed",
    summary: rawEvidenceValidation.valid
      ? "原始Span引用、SHA-256与全量检索重放校验通过"
      : "原始证据校验失败",
    data: rawEvidenceValidation,
  });
  if (!rawEvidenceValidation.valid) throw new Error("Raw evidence validation failed");

  await writeFile(path.join(outputDir, "evidence-ledger.json"), `${JSON.stringify(ledger.entries, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "rca-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(outputDir, "rca-report.md"),
    renderReportMarkdown(
      report,
      citationValidation,
      rawEvidenceValidation,
      evidenceConsistencyValidation,
      caseData.traceEvidenceBoundary,
    ),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "agent-run-summary.md"),
    renderRunSummary({
      runId,
      mode,
      modelInfo: agent.modelInfo(),
      target,
      decisions,
      ledger,
      coverage,
      report,
      investigationPolicy,
    }),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "validation.json"),
    `${JSON.stringify({ gapValidation, coverage, citationValidation, evidenceConsistencyValidation, rawEvidenceValidation, evidenceBoundary: caseData.traceEvidenceBoundary ?? null, conclusionReason }, null, 2)}\n`,
    "utf8",
  );
  await logger.event({
    phase: "complete",
    actor: "orchestrator",
    type: "run_completed",
    summary: "Trace RCA正式模块运行完成",
    data: { outputDir, evidenceEntries: ledger.entries.length },
  });
  await saveCheckpoint(outputDir, {
    ...state,
    decisions,
    executed,
    actionAttempts,
    stallCount,
    nextRound,
  });
  return {
    outputDir, target, report, coverage, citationValidation, evidenceConsistencyValidation, rawEvidenceValidation,
    evidenceBoundary: caseData.traceEvidenceBoundary ?? null,
    conclusionReason,
  };
  } catch (error) {
    await tryPersistFailureArtifacts({ state, error, coverage, investigationPolicy });
    throw error;
  }
}
