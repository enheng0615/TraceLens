function code(value) {
  return `\`${String(value ?? "").replaceAll("`", "\\`")}\``;
}

export function renderRunSummary({ runId, mode, modelInfo, target, decisions, ledger, coverage, report, investigationPolicy }) {
  const lines = [
    "# Trace RCA Agent 执行摘要",
    "",
    `- Run ID：${runId}`,
    `- 模式：${mode}`,
    `- Runtime：${modelInfo.runtime}`,
    `- Provider：${modelInfo.provider}`,
    "",
  ];
  if (mode === "offline") {
    lines.push(
      "> **边界：这是离线确定性模拟运行。** 它验证完整编排、Trace Tool、证据和校验链路，但不代表Sophon模型的真实自主调查表现。",
      "",
    );
  }
  lines.push(
    "## 1. 调查合同",
    "",
    `- 官方未命中项：${target.criterion.text}`,
    `- 最终事实差距：${target.difference.summary}`,
    `- 待解释现象：${target.phenomenonToExplain}`,
    "",
    "## 2. Agent逐轮执行",
    "",
  );
  for (const item of decisions) {
    lines.push(`### 第${item.round}轮`, "", `**观察**：${item.decision.analysisSummary}`, "");
    lines.push(`**已出现事实链**：${item.decision.actualAnswerPathStatus}`, "");
    lines.push(`**缺失事实链**：${item.decision.requiredFactPathStatus}`, "");
    lines.push("**开放问题**：");
    for (const question of item.decision.openQuestions ?? []) lines.push(`- ${question}`);
    lines.push("", "**请求的Trace Tool**：");
    for (const action of item.decision.actions ?? []) {
      lines.push(`- ${code(action.tool)}：${action.purpose}；参数 ${code(JSON.stringify(action.arguments))}`);
    }
    lines.push(
      "",
      `**本轮后覆盖状态**：${item.coverage.complete ? "固定调查骨架已完成" : `尚缺 ${item.coverage.missing.length} 项`}`,
    );
    if (item.coverage.missing.length) {
      for (const missing of item.coverage.missing) lines.push(`- 待补：${missing}`);
    }
    lines.push("", `**Agent是否申请结束**：${item.decision.readyForConclusion ? "是" : "否"}`, "");
  }
  lines.push("## 3. 证据账本索引", "", "| Evidence | Tool | 调查目的 |", "|---|---|---|");
  for (const entry of ledger.entries) {
    lines.push(`| ${entry.evidenceId} | ${entry.tool} | ${entry.purpose} |`);
  }
  lines.push(
    "",
    "## 4. 停止条件",
    "",
    `- 固定调查覆盖：${coverage.complete ? "通过" : "未通过"}`,
    `- 已追踪案例声明的实际答案事实链：${(investigationPolicy?.factChainTerms ?? []).join(" / ") || "未声明"}。`,
    `- 已检查缺失事实检索项在Schema、计划、Tool结果、上下文和最终答案中的状态：${(investigationPolicy?.allTraceSearches ?? []).join(" / ") || "未声明"}。`,
    "- 已检查替代解释并明确现有Trace的不可观察边界。",
    "",
    "## 5. 最终判断摘要",
    "",
    report.executiveSummary,
    "",
    `- 置信度：${report.rootCauseAssessment.confidence}`,
    `- 未证明部分：${report.evidenceBoundary.notProven}`,
    "",
  );
  return lines.join("\n");
}
