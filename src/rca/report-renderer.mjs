function ev(ids = []) {
  return ids.length ? `（证据：${ids.join(", ")}）` : "";
}

export function renderReportMarkdown(report, citationValidation, rawEvidenceValidation, evidenceConsistencyValidation, traceEvidenceBoundary) {
  const lines = [
    `# Trace RCA 报告：${report.caseId}`,
    "",
    "## 结论摘要",
    "",
    report.executiveSummary,
    "",
    "## 评分差距",
    "",
    `- 评分项：${report.scoreGap?.criterionId ?? ""}`,
    `- 最终差异：${report.scoreGap?.observedDifference ?? ""}`,
    "",
    "## IDA实际答案生成链",
    "",
  ];
  for (const [index, item] of (report.actualAnswerProductionChain ?? []).entries()) {
    lines.push(`${index + 1}. ${item.step} ${ev(item.evidenceIds)}`);
  }
  lines.push("", "## GT完整事实的信息生命周期", "", "| 阶段 | 状态 | 发现 | 证据 |", "|---|---|---|---|");
  for (const item of report.requiredFactLifecycle ?? []) {
    lines.push(`| ${item.stage} | ${item.status} | ${item.finding} | ${(item.evidenceIds ?? []).join(", ")} |`);
  }
  lines.push(
    "",
    "## 最早实质分叉",
    "",
    `${report.earliestMaterialDivergence?.finding ?? ""} ${ev(report.earliestMaterialDivergence?.evidenceIds)}`,
    "",
    report.earliestMaterialDivergence?.whyMaterial ?? "",
    "",
    "## 因果链",
    "",
  );
  for (const [index, item] of (report.causalChain ?? []).entries()) {
    lines.push(`${index + 1}. ${item.finding} ${ev(item.evidenceIds)}`);
  }
  lines.push("", "## 替代解释检查", "");
  for (const item of report.alternativeExplanations ?? []) {
    lines.push(`- **${item.status}**：${item.explanation}。${item.reason} ${ev(item.evidenceIds)}`);
  }
  lines.push(
    "",
    "## 可观察边界内的原因判断",
    "",
    `- 判断：${report.rootCauseAssessment?.finding ?? ""}`,
    `- 置信度：${report.rootCauseAssessment?.confidence ?? ""}`,
    `- 证据：${(report.rootCauseAssessment?.evidenceIds ?? []).join(", ")}`,
    "",
    "## 证据边界",
    "",
    `- 已确认：${report.evidenceBoundary?.confirmed ?? ""}`,
    `- 未证明：${report.evidenceBoundary?.notProven ?? ""}`,
    "",
    "## Trace完整性与证据边界",
    "",
    `- 完整性：${traceEvidenceBoundary?.classification ?? "unknown"}`,
    `- 是否允许分析：${traceEvidenceBoundary?.analysisAllowed === true ? "是" : "未知"}`,
    `- 否定性证据是否可证明全量不存在：${traceEvidenceBoundary?.negativeEvidenceEligible === true ? "是" : "否"}`,
    `- 说明：${traceEvidenceBoundary?.summary ?? "未提供Trace完整性元数据。"}`,
  );
  for (const segment of traceEvidenceBoundary?.missingSegments ?? []) {
    lines.push(`- 局部缺口：${segment.spanType ?? "UNKNOWN"}/${segment.toolName ?? "unknown"} Span ${segment.spanId}.${segment.field}，当前可见${segment.observedChars ?? 0}字符；补拉状态 ${segment.recovery?.code ?? segment.recovery?.status ?? "unknown"}。`);
  }
  lines.push("", "## 建议的下一步验证", "");
  for (const item of report.recommendedNextVerification ?? []) lines.push(`- ${item}`);
  lines.push(
    "",
    "## 自动校验",
    "",
    `- RCA证据编号校验：${citationValidation.valid ? "通过" : "失败"}`,
    `- 确定性证据语义一致性校验：${evidenceConsistencyValidation?.valid ? "通过" : "失败"}`,
    `- 原始Span引用、SHA-256与全量检索重放校验：${rawEvidenceValidation.valid ? "通过" : "失败"}`,
    "",
    "> 说明：本报告中的“根因”仅限现有Trace可观察边界。没有重放/干预实验时，不宣称实验意义上的绝对因果。",
    "",
  );
  return lines.join("\n");
}
