export function renderCausalFindings(report, { showStatus = true, scopeUnverified = false } = {}) {
  const lines = [scopeUnverified ? "## 字段级定位与证据" : "## 字段级根因定位", ""];
  if (!report.causalFindings?.length) return [...lines, "当前尚未形成有精确位置和证据支持的根因记录。", ""];
  for (const [index, finding] of report.causalFindings.entries()) {
    const loc = finding.location;
    lines.push(showStatus ? `### ${index + 1}. ${finding.status}` : `### 定位 ${index + 1}`, "",
      `- 位置：Span ${loc.spanId} / ${loc.field} / ${loc.pointer ?? `[${loc.startOffset}, ${loc.endOffset})`}`,
      `- 定位层次：${finding.localizationLevel ?? "unknown"}`,
      `- 期望及依据：${finding.expectedBehavior}`,
      `- 缺陷证据：${(finding.evidenceIds ?? []).join(", ")}`,
      `- 契约证据：${(finding.contractEvidenceIds ?? []).join(", ")}`,
      `- 规则可见时点：${finding.contractAvailability ?? "unknown"}`,
      `- ${scopeUnverified && (finding.status === "localized_unverified" || finding.localizationLevel === "symptom_only") ? "候选机制（未证实）" : "形成机制"}：${finding.mechanism ?? "尚待验证"}`);
    if (finding.closureLimitations) lines.push(`- 判定限制：${finding.closureLimitations}`);
    if (loc.quote) lines.push("", "原始片段：", "", "```text", loc.quote, "```", "");
    for (const edge of finding.downstream ?? []) lines.push(`- 下游 Span ${edge.spanId}：${edge.mapping} [${edge.evidenceIds.join(", ")}]`);
    for (const alt of finding.alternatives ?? []) lines.push(`- 替代解释（${alt.status}）：${alt.explanation ?? alt.reason ?? "见结构化报告"} [${alt.evidenceIds.join(", ")}]`);
    lines.push("");
  }
  return lines;
}
