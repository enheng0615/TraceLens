import { readRcaCsv } from "../workflows/trace-rca/csv-input.mjs";
import { isFullScore } from "../workflows/trace-rca/score-utils.mjs";

function firstErrorLine(stderr = []) {
  const lines = stderr.map((line) => String(line ?? "").trim()).filter(Boolean);
  return lines.find((line) => !line.startsWith("at ") && !line.startsWith("at async ")) || lines[0] || "任务进程异常退出";
}

function cleanErrorPrefix(line) {
  return String(line)
    .replace(/^(?:CSV|Single-session) Trace RCA workflow failed:\s*/i, "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .trim();
}

function stageLabel(stage) {
  return ({
    input_validation: "CSV输入校验",
    ingestion: "Trace采集",
    preparation: "归因准备",
    investigation: "Trace调查",
    process_start: "任务进程启动",
    pre_workflow: "工作流启动前",
    web_runtime: "Web运行状态恢复",
  })[stage] || stage || "未知阶段";
}

async function inspectCsv(job) {
  if (job.type !== "csv" || !job.inputPath) return null;
  try {
    const parsed = await readRcaCsv(job.inputPath);
    const issues = parsed.records.filter((record) => record.inputError).map((record) => ({
      rowNumber: record.rowNumber,
      scoreState: isFullScore(record.score) ? "full_score" : String(record.score ?? "").trim() ? "non_full_score" : "missing",
      ...record.inputError,
    }));
    const sourceRunStatuses = parsed.records.filter((record) => record.sourceRunStatus).map((record) => ({
      rowNumber: record.rowNumber,
      ...record.sourceRunStatus,
    }));
    return {
      inputRows: parsed.records.length,
      fullScoreRows: parsed.records.filter((record) => isFullScore(record.score)).length,
      actionableRows: parsed.records.filter((record) => !isFullScore(record.score) && !record.sourceRunStatus).length,
      sourceRunFailedRows: sourceRunStatuses.length,
      sourceRunStatuses,
      issueCount: issues.length,
      issues,
    };
  } catch (error) {
    return { inspectionError: cleanErrorPrefix(error?.message || error), issueCount: 0, issues: [] };
  }
}

export async function buildJobDiagnosis(job, manifest = null) {
  const manifestFailures = (manifest?.items ?? []).filter((item) => item.status === "failed");
  const failureGroups = new Map();
  for (const item of manifestFailures) {
    const key = item.error?.code || `${item.stage || "unknown"}:${item.error?.message || "unknown"}`;
    const group = failureGroups.get(key) || { key, count: 0, first: item };
    group.count += 1;
    failureGroups.set(key, group);
  }
  const primaryFailureGroup = [...failureGroups.values()].sort((left, right) => right.count - left.count)[0];
  const firstManifestFailure = primaryFailureGroup?.first;
  const csvInspection = await inspectCsv(job);
  const firstInputIssue = csvInspection?.issues?.[0];
  const rawPrimary = cleanErrorPrefix(firstErrorLine(job.stderr));
  const failureContext = job.failureContext;

  let stage = failureContext?.stage || firstManifestFailure?.stage || (firstInputIssue ? "input_validation" : "pre_workflow");
  let code = failureContext?.code || firstManifestFailure?.error?.code || firstInputIssue?.code || null;
  let message = failureContext?.message || firstManifestFailure?.error?.message || firstInputIssue?.message || rawPrimary;
  let remediation = failureContext?.remediation || firstManifestFailure?.error?.remediation || (!firstManifestFailure ? firstInputIssue?.remediation : null) || "查看Web日志和工作流产物，修复输入或运行环境后创建新的Attempt。";
  let impact = failureContext?.impact || (manifest
    ? `工作流记录了${manifestFailures.length}个失败项；其他已完成项和日志保持不变。`
    : "工作流Manifest尚未创建，失败发生在CSV解析或任务初始化阶段；没有进入Trace归因。");

  if (!failureContext && /query URL 格式非法|SESSION_ID_(?:MISSING|INVALID)/i.test(`${rawPrimary} ${code ?? ""}`) && firstInputIssue) {
    stage = "input_validation";
    code = firstInputIssue.code;
    message = firstInputIssue.message;
    remediation = firstInputIssue.remediation;
    impact = `检测到${csvInspection.issueCount}个不可归因输入行。该行不会拉取Trace或调用模型；修复后的工作流可继续处理其他有效行。`;
  } else if (!failureContext && /fetch failed|CONNECT_TIMEOUT|SOCKET|ECONN/i.test(rawPrimary)) {
    stage = manifest ? stage : "pre_workflow";
    code ||= "NETWORK_FAILURE";
    remediation = "检查内网、VPN、Sophon网关和模型连通性；临时中断可Resume，代码或配置变化应创建新Attempt。";
  } else if (!failureContext && code === "SESSION_NOT_FOUND") {
    const count = manifestFailures.filter((item) => item.error?.code === "SESSION_NOT_FOUND").length;
    impact = `有${count}个待归因输入已成功解析Session ID，但Sophon Session查询返回0条；其他失败类型和已完成项仍分别保留。`;
    remediation = "当前版本会先查询近期Session，未命中时按严格小于30天的窗口逐段回溯，并自动刷新旧的空查询缓存；若新Attempt仍返回0条，请核对Sophon tenant、agent-type和当前账号的数据访问权限。";
  } else if (!failureContext && code === "SOPHON_CLI_ERROR") {
    const count = primaryFailureGroup?.count ?? 1;
    impact = `${count}个待归因输入在Trace采集命令阶段发生相同的sophon-cli错误；其他失败类型、满分跳过项和已完成项仍分别保留。`;
    remediation = /查询范围不能超过\s*30\s*天|range.*30\s*days/i.test(message)
      ? "Sophon限制单次Session查询范围不能超过30天；当前版本已改为近期查询，未命中时按小于30天的窗口逐段回溯。请创建新Attempt重跑失败项。"
      : /--since.*--until|--until.*--since/i.test(message)
        ? "sophon-cli要求--since和--until成对出现；当前版本的历史回溯窗口会成对提供这两个参数。请创建新Attempt重跑失败项。"
      : "查看Web失败诊断中的CLI消息和对应Session采集Manifest；修复参数、认证或运行环境后创建新Attempt。";
  }

  return {
    schemaVersion: "trace-rca-web-diagnosis-v1",
    generatedAt: new Date().toISOString(),
    jobId: job.id,
    status: job.status,
    stage,
    stageLabel: stageLabel(stage),
    code,
    message,
    impact,
    remediation,
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    manifestAvailable: Boolean(manifest),
    manifestFailureCount: manifestFailures.length,
    failureGroups: [...failureGroups.values()].map((group) => ({
      code: group.first.error?.code ?? null,
      stage: group.first.stage ?? null,
      count: group.count,
    })).sort((left, right) => right.count - left.count),
    inputInspection: csvInspection,
    technical: {
      primaryErrorLine: rawPrimary,
      stderrLineCount: job.stderr?.length ?? 0,
    },
  };
}

function md(value) {
  return String(value ?? "-").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

export function renderWebFailureSummary(diagnosis) {
  const lines = [
    "# Web任务失败诊断",
    "",
    `- Job ID：${md(diagnosis.jobId)}`,
    `- 失败阶段：${md(diagnosis.stageLabel)}`,
    `- 错误码：${md(diagnosis.code)}`,
    `- 进程退出码：${md(diagnosis.exitCode)}`,
    "",
    "## 根因摘要",
    "",
    diagnosis.message,
    "",
    "## 影响范围",
    "",
    diagnosis.impact,
    "",
    "## 处理建议",
    "",
    diagnosis.remediation,
  ];
  const issues = diagnosis.inputInspection?.issues ?? [];
  if (issues.length) {
    lines.push("", "## 输入问题", "", "| CSV行 | 字段 | 错误码 | 分数状态 |", "|---:|---|---|---|");
    for (const issue of issues) lines.push(`| ${md(issue.rowNumber)} | ${md(issue.field)} | ${md(issue.code)} | ${md(issue.scoreState)} |`);
  }
  lines.push(
    "",
    "## 技术信息",
    "",
    `- 原始首条错误：${md(diagnosis.technical.primaryErrorLine)}`,
    `- stderr行数：${md(diagnosis.technical.stderrLineCount)}`,
    `- Manifest已创建：${diagnosis.manifestAvailable ? "是" : "否"}`,
    "",
    "> 完整脱敏运行事件见 `web-job.jsonl`。日志不记录CSV正文、IDA答案、JWT、API Key或Authorization。",
    "",
  );
  return lines.join("\n");
}
