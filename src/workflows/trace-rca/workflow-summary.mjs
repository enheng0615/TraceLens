function cell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderWorkflowSummary(manifest) {
  const lines = [
    "# Trace RCA 全链路执行摘要",
    "",
    `- Workflow ID：${manifest.workflowId}`,
    `- 状态：${manifest.status}`,
    `- 输入类型：${manifest.source.type}`,
    `- 输入行数：${manifest.counts.inputRows}`,
    `- 满分跳过：${manifest.counts.fullScoreSkipped ?? 0}`,
    `- 源任务未成功运行：${manifest.counts.sourceRunFailed ?? 0}`,
    `- Session并发数：${manifest.configuration.concurrency ?? 1}`,
    `- 完成：${manifest.counts.completed}`,
    `- 其中Trace局部不完整：${manifest.counts.completedWithEvidenceGaps ?? 0}`,
    `- 失败：${manifest.counts.failed}`,
    `- 跳过：${manifest.counts.skipped}`,
    "",
    "## 任务明细",
    "",
    "| CSV行 | Session | GT | 状态 | Trace来源 | RCA输出/错误 |",
    "|---:|---|---|---|---|---|",
  ];
  for (const item of manifest.items) {
    lines.push(`| ${cell(item.rowNumber ?? "-")} | ${cell(item.sessionId)} | ${cell(item.criterionId ?? "-")} | ${cell(item.status)} | ${cell(item.traceSource ?? "-")} | ${cell(item.failureSummaryPath ?? item.rcaOutputDir ?? item.error?.message ?? item.detail ?? item.reason ?? "-")} |`);
  }
  lines.push("", "> CSV中的Session URL只用于提取Session ID，完整URL和JWT不会写入Workflow输出。", "");
  return lines.join("\n");
}
