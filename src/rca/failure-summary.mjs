function code(value) {
  return `\`${String(value ?? "").replaceAll("`", "\\`")}\``;
}

function errorStage(message) {
  const text = String(message ?? "");
  if (/Scoring Gap/i.test(text)) return "scoring_gap";
  if (/coverage|readyForConclusion|maxRounds/i.test(text)) return "investigation";
  if (/Final RCA|report/i.test(text)) return "final_report_validation";
  if (/Raw evidence/i.test(text)) return "raw_evidence_validation";
  return "rca_runtime";
}

export function renderFailureSummary({
  runId,
  mode,
  modelInfo,
  target,
  decisions = [],
  ledger,
  coverage,
  error,
  casePath,
  traceRoot,
  outputDir,
  resumable = true,
}) {
  const last = decisions.at(-1);
  const lines = [
    "# Trace RCA 失败摘要",
    "",
    `- Run ID：${runId ?? "尚未生成"}`,
    "- 状态：failed",
    `- 失败阶段：${errorStage(error?.message)}`,
    `- 模式：${mode ?? "unknown"}`,
    `- Provider：${modelInfo?.provider ?? "unknown"}`,
    `- 错误：${error?.message ?? String(error)}`,
    `- 已完成调查轮数：${decisions.length}`,
    `- 已登记证据：${ledger?.entries?.length ?? 0}`,
    `- 固定覆盖：${coverage?.complete ? "已完成" : "未完成"}`,
    "",
    "## 调查目标",
    "",
    `- 官方未命中项：${target?.criterion?.text ?? "尚未生成"}`,
    `- 待解释现象：${target?.phenomenonToExplain ?? "尚未生成"}`,
    "",
    "## 尚未满足的条件",
    "",
  ];
  if (coverage?.missing?.length) coverage.missing.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- 无固定覆盖缺口；失败发生在其他停止或校验条件。 ");

  lines.push("", "## 最后一轮Agent状态", "");
  if (last) {
    lines.push(
      `- 轮次：${last.round}`,
      `- 观察：${last.decision?.analysisSummary ?? ""}`,
      `- 已出现事实链：${last.decision?.actualAnswerPathStatus ?? ""}`,
      `- 缺失事实链：${last.decision?.requiredFactPathStatus ?? ""}`,
      `- 是否申请结束：${last.decision?.readyForConclusion ? "是" : "否"}`,
    );
    for (const question of last.decision?.openQuestions ?? []) lines.push(`- 开放问题：${question}`);
  } else lines.push("- 尚未进入Trace调查轮次。 ");

  lines.push(
    "",
    "## 已保留产物",
    "",
    `- 完整日志：${code(`${outputDir}/agent-run.md`)}`,
    `- 结构化日志：${code(`${outputDir}/agent-run.jsonl`)}`,
    `- Checkpoint：${resumable ? code(`${outputDir}/checkpoint.json`) : "尚未生成"}`,
    `- 失败时证据快照：${code(`${outputDir}/evidence-ledger.partial.json`)}`,
    `- 失败时校验快照：${code(`${outputDir}/validation.partial.json`)}`,
    "",
    resumable ? "## 恢复命令" : "## 重新运行命令",
    "",
    "```bash",
  );
  if (resumable) {
    lines.push(`npm run rca:run -- \\\n  --case ${casePath} \\\n  --trace-root ${traceRoot} \\\n  --resume ${outputDir} \\\n  --max-rounds <大于当前轮次的值>`);
  } else {
    lines.push(`npm run rca:run -- \\\n  --case ${casePath} \\\n  --trace-root ${traceRoot} \\\n  --max-rounds <正整数>`);
  }
  lines.push(
    "```",
    "",
    resumable
      ? "> 已存在Checkpoint；修复错误或提高轮数后可从断点恢复。"
      : "> 失败发生在首个Checkpoint之前，不能使用--resume；请修复输入、配置或Trace后重新运行。",
    "",
    "> 失败摘要不是最终RCA结论；只有全部覆盖和证据校验通过后才会生成rca-report.md。",
    "",
  );
  return lines.join("\n");
}
