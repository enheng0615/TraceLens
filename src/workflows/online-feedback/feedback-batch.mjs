import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { parseCsv } from "./csv.mjs";
import { runFeedbackWorkflow } from "./workflow.mjs";
import { writeJsonAtomic, writeTextAtomic } from "../../ingestion/sophon-trace/file-store.mjs";

const NEGATIVE_LABELS = new Set(["negative", "负向", "负面"]);

/** Accept filtered candidates or a source export with a label column. */
export function parseFeedbackBatchCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("反馈 CSV 为空");
  const headers = rows[0].map((value) => String(value ?? "").trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("反馈 CSV 存在重复表头");
  const sessionIndex = headers.indexOf("session_id");
  const queryIndex = headers.indexOf("request_query");
  if (sessionIndex < 0 || queryIndex < 0) throw new Error("反馈 CSV 需要 session_id 和 request_query 两列");
  const labelIndex = headers.indexOf("label");
  const requestIndex = headers.indexOf("request_id_list");
  const taskIndex = headers.indexOf("task_id");
  const seen = new Set();
  const candidates = [];
  let inputRows = 0;
  let excludedRows = 0;
  let duplicateRows = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every((value) => !String(value ?? "").trim())) continue;
    inputRows += 1;
    const rowNumber = index + 1;
    if (row.length !== headers.length) throw new Error(`反馈 CSV 第 ${rowNumber} 行列数不一致`);
    const label = labelIndex < 0 ? "negative" : String(row[labelIndex] ?? "").trim().toLowerCase();
    if (!NEGATIVE_LABELS.has(label)) { excludedRows += 1; continue; }
    const sessionId = String(row[sessionIndex] ?? "").trim();
    const requestQuery = String(row[queryIndex] ?? "");
    const requestIdList = requestIndex < 0 ? "" : String(row[requestIndex] ?? "").trim();
    const taskId = taskIndex < 0 ? "" : String(row[taskIndex] ?? "").trim();
    if (!/^\d+$/.test(sessionId)) throw new Error(`反馈 CSV 第 ${rowNumber} 行的 session_id 必须为数字`);
    if (!requestQuery.trim()) throw new Error(`反馈 CSV 第 ${rowNumber} 行缺少 request_query`);
    if (requestQuery.length > 50000) throw new Error(`反馈 CSV 第 ${rowNumber} 行反馈原文超过 50000 字符`);
    const key = JSON.stringify([sessionId, requestQuery, taskId, requestIdList]);
    if (seen.has(key)) { duplicateRows += 1; continue; }
    seen.add(key);
    candidates.push({ rowNumber, sessionId, requestQuery, taskId, requestIdList });
  }
  if (!candidates.length) throw new Error("CSV 中没有可处理的负向反馈");
  return { candidates, inputRows, excludedRows, duplicateRows };
}

export function selectFeedbackBatchSessions(parsed, { sessionStart = 1, sessionCount = 10 } = {}) {
  if (!Number.isInteger(sessionStart) || sessionStart < 1) throw new Error("起始 Session 序号必须是正整数");
  if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 150) throw new Error("每批 Session 数必须是1到150之间的整数");
  const sessionIds = [...new Set(parsed.candidates.map((candidate) => candidate.sessionId))];
  if (sessionStart > sessionIds.length) throw new Error(`起始 Session 序号超过候选总数 ${sessionIds.length}`);
  const selectedIds = new Set(sessionIds.slice(sessionStart - 1, sessionStart - 1 + sessionCount));
  const candidates = parsed.candidates.filter((candidate) => selectedIds.has(candidate.sessionId));
  if (candidates.length > 500) throw new Error("所选 Session 包含超过500条反馈，请缩小每批 Session 数");
  return { ...parsed, candidates, totalSessions: sessionIds.length, selectedSessions: selectedIds.size,
    sessionStart, sessionCount, nextSessionStart: sessionStart + selectedIds.size <= sessionIds.length ? sessionStart + selectedIds.size : null };
}

export async function runFeedbackBatchWorkflow({ csvText, fileName = "feedback.csv", workflowOutputRoot, traceOutputRoot,
  projectRoot = process.cwd(), maxRounds = 12, maxTurns = 24, sessionStart = 1, sessionCount = 10,
  concurrency = 3, ingestion = {}, runOne = runFeedbackWorkflow, logger = console }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("并行线程数必须是1到16之间的整数");
  const parsed = selectFeedbackBatchSessions(parseFeedbackBatchCsv(csvText), { sessionStart, sessionCount });
  const workflowId = `feedback-batch-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(workflowOutputRoot, workflowId);
  const manifestPath = path.join(outputDir, "workflow-manifest.json");
  const manifest = {
    schemaVersion: "online-feedback-batch-workflow-v1", workflowId, scenario: "online-feedback", status: "running",
    startedAt: new Date().toISOString(), source: { fileName, inputRows: parsed.inputRows, excludedRows: parsed.excludedRows,
      duplicateRows: parsed.duplicateRows, totalSessions: parsed.totalSessions, selectedSessions: parsed.selectedSessions,
      sessionStart: parsed.sessionStart, nextSessionStart: parsed.nextSessionStart },
    configuration: { maxRounds, maxTurns, concurrency, sessionCount },
    counts: { criteria: parsed.candidates.length, plannedCriteria: parsed.candidates.length, totalWorkUnits: parsed.candidates.length, completed: 0, failed: 0 },
    items: parsed.candidates.map((candidate) => ({ rowNumber: candidate.rowNumber, sessionId: candidate.sessionId,
      criterionId: "反馈分析", scenario: "online-feedback", status: "queued", stage: "planned" })),
  };
  await mkdir(outputDir, { recursive: true });
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone(manifest);
    saveQueue = saveQueue.then(() => writeJsonAtomic(manifestPath, snapshot));
    return saveQueue;
  };
  await save();
  const groups = new Map();
  parsed.candidates.forEach((candidate, index) => {
    if (!groups.has(candidate.sessionId)) groups.set(candidate.sessionId, []);
    groups.get(candidate.sessionId).push(index);
  });
  const pendingGroups = [...groups.values()];
  let nextGroup = 0;
  const runItem = async (index) => {
    const candidate = parsed.candidates[index];
    const item = manifest.items[index];
    item.status = "running";
    item.stage = "timeline";
    await save();
    logger.info?.(`[${index + 1}/${parsed.candidates.length}] 处理 Session ${candidate.sessionId}`);
    try {
      const child = await runOne({ input: candidate, workflowOutputRoot: path.join(outputDir, "cases", String(index + 1)),
        traceOutputRoot, projectRoot, maxRounds, maxTurns, ingestion, logger });
      const childItem = child.items?.[0] ?? {};
      item.status = childItem.status ?? child.status;
      item.stage = "complete";
      item.rcaOutputDir = childItem.rcaOutputDir;
      item.feedbackAssessment = childItem.feedbackAssessment;
      item.causalInvestigationStatus = childItem.causalInvestigationStatus;
      item.problemClassification = childItem.problemClassification;
      manifest.counts.completed += 1;
    } catch (error) {
      item.status = "failed";
      item.stage = "failed";
      item.error = { code: error.code ?? "FEEDBACK_ANALYSIS_FAILED", message: error.message,
        remediation: "检查反馈原文、历史快照与 Sophon 访问配置后重新处理。" };
      manifest.counts.failed += 1;
    }
    await save();
  };
  const worker = async () => {
    while (nextGroup < pendingGroups.length) {
      const group = pendingGroups[nextGroup++];
      for (const index of group) await runItem(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pendingGroups.length) }, worker));
  manifest.status = manifest.counts.failed === manifest.items.length ? "failed"
    : manifest.counts.failed ? "completed_with_failures"
      : manifest.items.some((item) => item.status === "completed_with_evidence_gaps") ? "completed_with_evidence_gaps" : "completed";
  manifest.finishedAt = new Date().toISOString();
  await save();
  await writeTextAtomic(path.join(outputDir, "workflow-summary.md"), `# 负向反馈批次\n\n来源：${fileName}\n\n候选反馈：${manifest.items.length}\n完成：${manifest.counts.completed}\n失败：${manifest.counts.failed}\n\n详情见各 Session 的反馈分析报告。\n`);
  return { ...manifest, outputDir, manifestPath };
}
