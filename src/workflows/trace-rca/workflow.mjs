import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRcaCase } from "../../rca/index.mjs";
import { traceText } from "../../rca/trace-repository.mjs";
import { buildRcaCases } from "./case-builder.mjs";
import { extractMissedCriteria } from "./grading-parser.mjs";
import { createSessionCollector, ensureSessionTrace } from "./session-trace.mjs";
import { extractSessionExchange } from "./trace-case-source.mjs";
import { resolveEvaluatedAnswer } from "./answer-resolver.mjs";
import { compareEvaluatedQuery } from "./content-alignment.mjs";
import { renderWorkflowSummary } from "./workflow-summary.mjs";
import { isFullScore } from "./full-score-filter.mjs";

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safePathPart(value, fallback = "unknown") {
  const text = String(value ?? "").trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return text || fallback;
}

function sessionDirectoryName(value, rowNumber) {
  const id = String(value ?? "").trim();
  return id ? `session-${safePathPart(id)}` : `unresolved-row-${rowNumber ?? "unknown"}`;
}

function gtDirectoryName(caseData) {
  const criterionId = caseData.officialMissedCriteria?.[0]?.id;
  return `${safePathPart(criterionId, "gt")}-${hash(caseData.caseId).slice(0, 10)}`;
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function comparable(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function comparison(expected, actual) {
  return {
    matches: comparable(expected) === comparable(actual),
    expectedChars: String(expected ?? "").length,
    traceChars: String(actual ?? "").length,
    expectedSha256: hash(comparable(expected)),
    traceSha256: hash(comparable(actual)),
  };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function errorRecord(error) {
  return {
    name: error?.name || "Error",
    code: error?.code,
    message: traceText.redact(error?.message || String(error)),
    ...(error?.field ? { field: error.field } : {}),
    ...(error?.rowNumber ? { rowNumber: error.rowNumber } : {}),
    ...(error?.remediation ? { remediation: traceText.redact(error.remediation) } : {}),
    ...(error?.causeCode ? { causeCode: error.causeCode } : {}),
  };
}

function selectionForRecord(record, retrySelection) {
  if (!Array.isArray(retrySelection) || !retrySelection.length) return null;
  const matches = retrySelection.filter((item) => {
    if (item.rowNumber !== undefined && item.rowNumber !== null) {
      return Number(item.rowNumber) === Number(record.rowNumber);
    }
    return String(item.sessionId ?? "") === String(record.sessionId ?? "");
  });
  return matches.length ? matches : false;
}

function criteriaForRecord(record, criteria, retrySelection) {
  const selection = selectionForRecord(record, retrySelection);
  if (selection === null) return criteria;
  if (selection === false) return [];
  if (selection.some((item) => !item.criterionId)) return criteria;
  const criterionIds = new Set(selection.map((item) => String(item.criterionId)));
  return criteria.filter((criterion) => criterionIds.has(String(criterion.id)));
}

function counts(items, rowCount, plannedCriteria = items.length, totalWorkUnits = plannedCriteria) {
  return {
    inputRows: rowCount,
    criteria: items.length,
    plannedCriteria,
    totalWorkUnits,
    fullScoreSkipped: items.filter((item) => item.reason === "full_score").length,
    sourceRunFailed: items.filter((item) => item.status === "source_run_failed").length,
    running: items.filter((item) => item.status === "running").length,
    completed: items.filter((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)).length,
    completedWithEvidenceGaps: items.filter((item) => item.status === "completed_with_evidence_gaps").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
}

async function runWorkflow({
  source,
  records,
  workflowOutputRoot = "outputs/trace-rca-workflows",
  traceOutputRoot = "data/raw/sophon-sessions",
  mode = "live",
  maxRounds = 8,
  env = process.env,
  ingestion = {},
  forceIngestion = false,
  continueOnError = true,
  allowContentMismatch = false,
  retrySelection,
  lineage,
  concurrency = 1,
  skipFullScore = false,
  logger = console,
  dependencies = {},
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("concurrency must be an integer between 1 and 16");
  }
  if (!continueOnError && concurrency > 1) {
    throw new Error("fail-fast requires concurrency=1 because already-running parallel tasks cannot be stopped safely");
  }
  const workflowId = `batch-${timestampId()}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(path.resolve(workflowOutputRoot), workflowId);
  const sessionsRoot = path.join(outputDir, "sessions");
  await mkdir(sessionsRoot, { recursive: true });

  const manifestPath = path.join(outputDir, "workflow-manifest.json");
  const startedAt = new Date().toISOString();
  const items = [];
  const itemOrder = new WeakMap();
  const traceCache = new Map();
  const selectedRecords = records.filter((record) => selectionForRecord(record, retrySelection) !== false);
  if (Array.isArray(retrySelection) && retrySelection.length && !selectedRecords.length) {
    throw new Error("Retry selection does not match any input record");
  }
  const sourceRunFailedRecords = selectedRecords.filter((record) => record.sourceRunStatus?.status === "source_run_failed");
  const fullScoreRecords = skipFullScore ? selectedRecords.filter((record) => !record.sourceRunStatus && isFullScore(record.score)) : [];
  const recordsToRun = selectedRecords.filter((record) => !record.sourceRunStatus && (!skipFullScore || !isFullScore(record.score)));
  const executionPlan = source?.type === "csv" ? {
    schemaVersion: "trace-rca-execution-plan-v1",
    unit: "csv_row",
    inputRows: selectedRecords.length,
    fullScoreRows: fullScoreRecords.length,
    nonFullScoreRows: sourceRunFailedRecords.length + recordsToRun.length,
    records: selectedRecords
      .filter((record) => !fullScoreRecords.includes(record))
      .map((record) => ({
        rowNumber: record.rowNumber,
        sessionId: String(record.sessionId ?? ""),
        initialStatus: record.sourceRunStatus ? "source_run_failed" : "queued",
      })),
  } : null;
  // The UI needs the denominator before RCA cases are instantiated.
  // Invalid grading is counted as one pending unit; normal execution will still
  // record the precise parsing failure in the manifest.
  const plannedCriteria = recordsToRun.reduce((total, record) => {
    try {
      const criteria = extractMissedCriteria({
        machineGrading: record.machineGrading,
        groundTruth: record.groundTruth,
        explicitGt: record.explicitGt,
      });
      return total + criteriaForRecord(record, criteria, retrySelection).length;
    } catch {
      return total + 1;
    }
  }, 0);
  const totalWorkUnits = plannedCriteria + fullScoreRecords.length + sourceRunFailedRecords.length;
  const collector = dependencies.collector ?? createSessionCollector({ traceOutputRoot, ingestion, logger });
  const ensureTrace = dependencies.ensureTrace ?? ensureSessionTrace;
  const runRca = dependencies.runRca ?? runRcaCase;
  const extractExchange = dependencies.extractExchange ?? extractSessionExchange;
  const resolveAnswer = dependencies.resolveAnswer ?? resolveEvaluatedAnswer;

  const recordOrder = new Map(selectedRecords.map((record, index) => [record, index]));
  const nextItemOrder = new Map();
  const addItem = (record, item) => {
    const index = recordOrder.get(record) ?? recordsToRun.length;
    const local = nextItemOrder.get(record) ?? 0;
    nextItemOrder.set(record, local + 1);
    itemOrder.set(item, index * 100_000 + local);
    items.push(item);
    return item;
  };
  const orderedItems = () => [...items].sort((left, right) => (itemOrder.get(left) ?? 0) - (itemOrder.get(right) ?? 0));
  let persistence = Promise.resolve();

  const persist = (status) => {
    persistence = persistence.then(async () => {
      const manifestItems = orderedItems();
    const manifest = {
      schemaVersion: "trace-rca-workflow-v1",
      workflowId,
      status,
      startedAt,
      updatedAt: new Date().toISOString(),
      source,
      storageLayout: {
        version: 2,
        hierarchy: "batch/session/gt",
        batchDirectory: outputDir,
        sessionsDirectory: sessionsRoot,
      },
      ...(lineage ? { lineage } : {}),
      ...(Array.isArray(retrySelection) && retrySelection.length ? { retrySelection } : {}),
      ...(executionPlan ? { executionPlan } : {}),
      configuration: {
        mode,
        maxRounds,
        traceOutputRoot: path.resolve(traceOutputRoot),
        allowContentMismatch,
        forceIngestion,
        concurrency,
        skipFullScore,
        fullScoreRule: skipFullScore ? "strict_numeric_score_equals_1" : null,
        schedulingUnit: "session",
        sequential: concurrency === 1,
      },
      counts: counts(manifestItems, selectedRecords.length, plannedCriteria, totalWorkUnits),
      items: manifestItems,
    };
    await writeJsonAtomic(manifestPath, manifest);
    const sessionGroups = new Map();
    for (const item of manifestItems) {
      const directory = item.sessionDirectory || sessionDirectoryName(item.sessionId, item.rowNumber);
      if (!sessionGroups.has(directory)) sessionGroups.set(directory, []);
      sessionGroups.get(directory).push(item);
    }
    for (const [directory, sessionItems] of sessionGroups) {
      await writeJsonAtomic(path.join(sessionsRoot, directory, "session-summary.json"), {
        schemaVersion: "trace-rca-session-summary-v1",
        batchId: workflowId,
        sessionId: sessionItems.find((item) => item.sessionId)?.sessionId || null,
        status: sessionItems.some((item) => item.status === "failed")
          ? sessionItems.some((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)) ? "completed_with_failures" : "failed"
          : sessionItems.some((item) => item.status === "completed_with_evidence_gaps") ? "completed_with_evidence_gaps"
            : sessionItems.some((item) => item.status === "completed") ? "completed"
            : sessionItems.every((item) => item.status === "source_run_failed") ? "source_run_failed" : "skipped",
        updatedAt: manifest.updatedAt,
        items: sessionItems,
      });
    }
    await writeFile(path.join(outputDir, "workflow-summary.md"), renderWorkflowSummary(manifest), "utf8");
    });
    return persistence;
  };
  for (const record of sourceRunFailedRecords) {
    addItem(record, {
      rowNumber: record.rowNumber,
      sessionId: "",
      status: "source_run_failed",
      stage: "source_run",
      reason: "source_run_failed",
      code: record.sourceRunStatus.code,
      label: record.sourceRunStatus.label,
      detail: record.sourceRunStatus.detail,
      conditions: record.sourceRunStatus.conditions,
    });
  }
  for (const record of fullScoreRecords) {
    addItem(record, {
      rowNumber: record.rowNumber,
      sessionId: String(record.sessionId),
      score: record.score,
      status: "skipped",
      stage: "score_filter",
      reason: "full_score",
      detail: "Score is exactly 1; Trace collection and RCA were not executed",
    });
  }
  await persist("running");

  const processRecord = async (record) => {
    let trace;
    try {
      if (record.inputError || !String(record.sessionId ?? "").trim()) {
        const details = record.inputError ?? {
          code: "SESSION_ID_MISSING",
          field: "session_id/ida_url",
          rowNumber: record.rowNumber,
          message: `CSV第${record.rowNumber}行缺少Session ID，无法进行Trace归因`,
          remediation: `请补充CSV第${record.rowNumber}行的Session ID或包含sessionId参数的URL后复跑该行`,
        };
        const error = new Error(details.message);
        Object.assign(error, details);
        throw error;
      }
      const traceCacheKey = String(record.sessionId);
      if (!traceCache.has(traceCacheKey)) {
        traceCache.set(traceCacheKey, ensureTrace({
          sessionId: record.sessionId,
          traceOutputRoot,
          collector,
          ingestion,
          force: forceIngestion,
        }).catch((error) => {
          traceCache.delete(traceCacheKey);
          throw error;
        }));
      }
      trace = await traceCache.get(traceCacheKey);
      const exchange = await extractExchange(trace.traceRoot, {
        sessionId: record.sessionId,
        expectedQuery: record.query,
        expectedAnswer: record.idaAnswer,
      });
      const query = record.query || exchange.query;
      const queryCheck = compareEvaluatedQuery(query, exchange.query);
      const suppliedAnswerCheck = comparison(record.idaAnswer, exchange.idaAnswer);
      const resolvedAnswer = await resolveAnswer({
        traceRoot: trace.traceRoot,
        suppliedAnswer: record.idaAnswer,
        traceExchange: exchange,
      });
      const idaAnswer = resolvedAnswer.content;
      const answerCheck = {
        ...suppliedAnswerCheck,
        resolution: resolvedAnswer.resolution,
        accepted: resolvedAnswer.accepted,
        selectedChars: String(idaAnswer ?? "").length,
        selectedSha256: hash(comparable(idaAnswer)),
        provenance: resolvedAnswer.provenance,
      };
      if (!allowContentMismatch && (!queryCheck.matches || !resolvedAnswer.accepted)) {
        const error = new Error(
          `Case/Trace content mismatch for session ${record.sessionId}; queryMatches=${queryCheck.matches}, answerResolution=${resolvedAnswer.resolution}`,
        );
        error.code = "CASE_TRACE_MISMATCH";
        throw error;
      }

      const parsedCriteria = extractMissedCriteria({
        machineGrading: record.machineGrading,
        groundTruth: record.groundTruth,
        explicitGt: record.explicitGt,
      });
      const criteria = criteriaForRecord(record, parsedCriteria, retrySelection);
      if (Array.isArray(retrySelection) && retrySelection.length && parsedCriteria.length && !criteria.length) {
        const error = new Error(`Retry selection does not match any missed criterion for session ${record.sessionId}`);
        error.code = "RETRY_SELECTION_MISMATCH";
        throw error;
      }
      if (!criteria.length) {
        addItem(record, {
          rowNumber: record.rowNumber,
          sessionId: String(record.sessionId),
          traceRoot: trace.traceRoot,
          traceSource: trace.source,
          status: "skipped",
          reason: "machine grading contains no missed GT",
        });
        await persist("running");
        return;
      }
      const cases = buildRcaCases({
        sessionId: record.sessionId,
        query,
        idaAnswer,
        score: record.score,
        criteria,
        source: source.type,
        rowNumber: record.rowNumber,
        traceExchange: {
          ...exchange,
          answerResolution: answerCheck.resolution,
          answerProvenance: resolvedAnswer.provenance,
        },
        traceEvidenceBoundary: trace.evidenceBoundary,
      });

      for (const caseData of cases) {
        const sessionDirectory = sessionDirectoryName(record.sessionId, record.rowNumber);
        const gtDirectory = gtDirectoryName(caseData);
        const gtOutputDir = path.join(sessionsRoot, sessionDirectory, "gt", gtDirectory);
        const casePath = path.join(gtOutputDir, "case.json");
        const item = {
          rowNumber: record.rowNumber,
          sessionId: String(record.sessionId),
          criterionId: caseData.officialMissedCriteria[0].id,
          caseId: caseData.caseId,
          casePath,
          sessionDirectory,
          gtDirectory,
          traceRoot: trace.traceRoot,
          traceSource: trace.source,
          preparationValidation: { query: queryCheck, idaAnswer: answerCheck },
          ...(trace.evidenceBoundary ? { evidenceBoundary: trace.evidenceBoundary } : {}),
          status: "running",
        };
        addItem(record, item);
        await writeJsonAtomic(casePath, caseData);
        await persist("running");
        try {
          const result = await runRca({
            casePath,
            traceRoot: trace.traceRoot,
            outputRoot: gtOutputDir,
            outputDir: gtOutputDir,
            maxRounds,
            mode,
            env,
          });
          item.status = result.evidenceBoundary?.classification === "partial_analyzable"
            ? "completed_with_evidence_gaps"
            : "completed";
          item.rcaOutputDir = result.outputDir;
          if (result.evidenceBoundary) item.evidenceBoundary = result.evidenceBoundary;
          await persist("running");
        } catch (error) {
          item.status = "failed";
          item.error = errorRecord(error);
          if (error.rcaOutputDir) item.rcaOutputDir = error.rcaOutputDir;
          if (error.failureSummaryPath) item.failureSummaryPath = error.failureSummaryPath;
          await persist("running_with_failures");
          if (!continueOnError) {
            error.workflowItemRecorded = true;
            await persist("failed");
            throw error;
          }
        }
      }
    } catch (error) {
      if (!error.workflowItemRecorded) {
        const selected = selectionForRecord(record, retrySelection);
        const targets = Array.isArray(selected) && selected.length ? selected : [null];
        for (const target of targets) {
          const item = {
            rowNumber: record.rowNumber,
            sessionId: String(record.sessionId),
            ...(target?.criterionId ? { criterionId: target.criterionId } : {}),
            ...(target?.caseId ? { caseId: target.caseId } : {}),
            status: "failed",
            stage: /^SESSION_ID_/.test(String(error?.code)) ? "input_validation" : trace ? "preparation" : "ingestion",
            ...(trace ? { traceRoot: trace.traceRoot, traceSource: trace.source } : {}),
            error: errorRecord(error),
          };
          addItem(record, item);
        }
      }
      await persist(continueOnError ? "running_with_failures" : "failed");
      if (!continueOnError) {
        error.workflowOutputDir = outputDir;
        throw error;
      }
    }
  };

  // A Session is the scheduling and cache-isolation unit. Rows that reference
  // the same Session stay sequential, while different Sessions use a bounded
  // worker pool. This prevents duplicate Trace collection and preserves a
  // deterministic per-Session evidence trail.
  const sessionGroups = concurrency === 1 ? recordsToRun.map((record) => [record]) : [];
  if (concurrency > 1) {
    const groupsBySession = new Map();
    for (const record of recordsToRun) {
      const key = String(record.sessionId);
      let group = groupsBySession.get(key);
      if (!group) {
        group = [];
        groupsBySession.set(key, group);
        sessionGroups.push(group);
      }
      group.push(record);
    }
  }
  let groupIndex = 0;
  const worker = async () => {
    while (true) {
      const index = groupIndex;
      groupIndex += 1;
      if (index >= sessionGroups.length) return;
      for (const record of sessionGroups[index]) await processRecord(record);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, sessionGroups.length)) }, worker));

  const finalStatus = items.some((item) => item.status === "failed")
    ? items.some((item) => ["completed", "completed_with_evidence_gaps"].includes(item.status)) ? "completed_with_failures" : "failed"
    : items.some((item) => item.status === "completed_with_evidence_gaps") ? "completed_with_evidence_gaps"
      : items.some((item) => item.status === "completed") ? "completed" : "completed_no_action";
  await persist(finalStatus);
  const finalItems = orderedItems();
  return { workflowId, outputDir, manifestPath, status: finalStatus, items: finalItems, counts: counts(finalItems, selectedRecords.length, plannedCriteria, totalWorkUnits) };
}

export async function runCsvTraceRcaWorkflow({ csvPath, csvReader, columns, ...options }) {
  if (!csvPath) throw new Error("csvPath is required");
  const { readRcaCsv } = await import("./csv-input.mjs");
  const parsed = csvReader ? await csvReader(csvPath, { columns }) : await readRcaCsv(csvPath, { columns });
  return runWorkflow({
    ...options,
    concurrency: options.concurrency ?? 3,
    skipFullScore: options.skipFullScore ?? true,
    source: { type: "csv", fileName: path.basename(csvPath), rowCount: parsed.records.length },
    records: parsed.records,
  });
}

export async function runSingleSessionTraceRcaWorkflow({
  sessionId,
  machineGrading,
  idaAnswer,
  query,
  gt,
  score,
  ...options
}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (machineGrading === undefined || machineGrading === null || machineGrading === "") {
    throw new Error("machineGrading is required");
  }
  if (!idaAnswer) throw new Error("idaAnswer is required");
  return runWorkflow({
    ...options,
    // A session may contain multiple missed GT criteria. Continue after one GT
    // fails so the manifest contains a complete retry set instead of hiding
    // later, unattempted criteria.
    continueOnError: options.continueOnError ?? true,
    source: { type: "single-session", sessionId: String(sessionId) },
    records: [{
      sessionId: String(sessionId),
      machineGrading,
      idaAnswer,
      query,
      explicitGt: gt,
      score,
    }],
  });
}
