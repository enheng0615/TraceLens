import { renderCausalFindings } from "./causal-renderer.mjs";
import { renderReportOpening, reportSentence } from "./report-template.mjs";

function ev(ids = []) {
  return ids.length ? `（证据：${ids.join(", ")}）` : "";
}

function rcaRootCauseSentence(report) {
  const status = report.causalInvestigationStatus ?? "unresolved";
  if (status === "unresolved" || status === "symptom_only") {
    return "根因尚未定位：当前证据不足以将上游偏差与最终评分差距闭合。";
  }
  const headline = report.rootCauseHeadline;
  if (headline) return `${status === "localized_unverified" ? "候选原因（尚未证实）" : "当前证据支持的原因"}：${reportSentence(headline)}`;
  const divergence = report.earliestMaterialDivergence?.finding;
  const scopedDivergence = String(divergence || "已定位可疑上游偏差").trim().replace(/[。；;，,\s]+$/u, "");
  return status === "localized_unverified"
    ? `候选原因（尚未证实）：${scopedDivergence}；它可能影响最终答案，但因果链仍待核验。`
    : `当前证据支持的原因：${reportSentence(divergence || "上游偏差经后续执行传递至最终答案")}`;
}

function renderRcaPropagation(report) {
  const status = report.causalInvestigationStatus ?? "unresolved";
  const lines = [];
  if (status === "localized_unverified") lines.push("> 以下是有证据定位的候选传递路径，尚不能把未排除的替代解释写成确定根因。", "");
  if (status === "unresolved" || status === "symptom_only") lines.push("> 当前只确认结果差距或最终表现，尚未建立从上游原因到结果的完整因果链。", "");
  lines.push(report.executiveSummary || "当前证据不足以形成完整分析结论。", "");
  lines.push("### 1. 预期与最终差距", "", `- 评分项：${report.scoreGap?.criterionId ?? "未提供"}`, `- 最终差距：${report.scoreGap?.observedDifference ?? "未提供"}`, "");
  lines.push("### 2. 最早可定位的偏差及其影响", "");
  lines.push(`${report.earliestMaterialDivergence?.finding ?? "尚未定位有证据支持的上游偏差。"} ${ev(report.earliestMaterialDivergence?.evidenceIds)}`, "");
  if (report.earliestMaterialDivergence?.whyMaterial) lines.push(`- 影响原因：${report.earliestMaterialDivergence.whyMaterial}`, "");
  if (status === "localized_unverified") lines.push("- 更上游的决策原因：现有证据尚不足以确定为何选择该参数、维度或处理方式。", "");
  lines.push("### 3. 偏差如何传递至最终答案", "");
  if (report.causalChain?.length) {
    for (const [index, item] of report.causalChain.entries()) lines.push(`${index + 1}. ${item.finding} ${ev(item.evidenceIds)}`);
  } else lines.push("尚无可核验的完整传递路径。");
  lines.push("", "### 4. 最终表现", "", `- ${report.scoreGap?.observedDifference ?? "最终答案尚未独立核实。"}`, "");
  lines.push("### 5. 因果判断与剩余缺口", "",
    `- 已确认：${report.evidenceBoundary?.confirmed ?? "未提供"}`,
    `- 尚未证明：${report.evidenceBoundary?.notProven ?? "未提供"}`, "");
  if (report.problemClassification?.rationale) lines.push(`- 类别依据：${report.problemClassification.rationale} ${ev(report.problemClassification.evidenceIds)}`, "");
  return lines;
}

const REPORT_FIELD_DISPLAY_MAX_CHARS = 12000;

function printable(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
}

function reportDisplay(value, maxChars = REPORT_FIELD_DISPLAY_MAX_CHARS) {
  const text = printable(value);
  return {
    totalChars: text.length,
    shownChars: Math.min(text.length, maxChars),
    omitted: text.length > maxChars,
  };
}

function fenced(value, maxChars = REPORT_FIELD_DISPLAY_MAX_CHARS) {
  const text = printable(value);
  const shown = text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…<仅报告正文为控制篇幅省略；这不表示原始 Trace 截断。完整内容见 evidence-ledger.json 或下方原始文件>`;
  return `\`\`\`text\n${shown.replaceAll("```", "` ` `")}\n\`\`\``;
}

function citedEvidenceIds(report) {
  const ids = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      if (/evidence/i.test(key)) value.forEach((item) => typeof item === "string" && ids.add(item));
      value.forEach((item) => visit(item, key));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(report);
  return ids;
}

export function buildKeyExecutionEvidence(report, ledger) {
  const cited = citedEvidenceIds(report);
  const citedEntries = (ledger?.entries ?? []).filter((entry) => cited.has(entry.evidenceId));
  const citedSpanIds = new Set(citedEntries.flatMap((entry) => [
    entry.result?.spanId,
    ...(entry.rawRefs ?? []).map((ref) => ref.spanId),
  ]).filter(Boolean));
  const citedExcerptsBySpan = new Map();
  for (const entry of citedEntries) {
    for (const hit of entry.result?.hits ?? []) {
      if (!hit?.spanId || !hit?.excerpt) continue;
      const values = citedExcerptsBySpan.get(hit.spanId) ?? [];
      values.push({
        evidenceId: entry.evidenceId, field: hit.field, startOffset: hit.startOffset,
        excerpt: hit.excerpt,
      });
      citedExcerptsBySpan.set(hit.spanId, values);
    }
    if (entry.tool === "get_span_content" && entry.result?.span?.spanId && entry.result?.content) {
      const spanId = entry.result.span.spanId;
      const values = citedExcerptsBySpan.get(spanId) ?? [];
      values.push({
        evidenceId: entry.evidenceId,
        field: entry.result.field,
        startOffset: entry.result.range?.startOffset ?? 0,
        excerpt: entry.result.content,
      });
      citedExcerptsBySpan.set(spanId, values);
    }
  }
  return (ledger?.entries ?? [])
    // Every Tool/Skill exchange explicitly inspected by the investigation is
    // auditable report material. Do not hide an input/output merely because
    // the final model cited a sibling search EV instead of this exchange EV.
    .filter((entry) => entry.tool === "get_tool_exchange")
    .map((entry) => ({
      evidenceId: entry.evidenceId,
      spanId: entry.result?.spanId ?? null,
      toolName: entry.result?.name ?? "unknown",
      executionKind: entry.result?.executionKind ?? "tool",
      status: entry.result?.status ?? null,
      purpose: entry.purpose ?? "",
      request: entry.result?.request ?? null,
      response: entry.result?.response ?? "",
      responseTruncated: entry.result?.responseTruncated === true,
      responseTotalChars: entry.result?.responseTotalChars ?? String(entry.result?.response ?? "").length,
      requestTotalChars: entry.result?.requestTotalChars ?? null,
      rawRefs: entry.rawRefs ?? [],
      requestRawPath: entry.result?.requestEvidenceRef?.rawPath ?? null,
      responseRawPath: entry.result?.responseEvidenceRef?.rawPath ?? null,
      citedByFinalReport: cited.has(entry.evidenceId) || citedSpanIds.has(entry.result?.spanId),
      citedExcerpts: citedExcerptsBySpan.get(entry.result?.spanId) ?? [],
    }));
}

export function renderReportMarkdown(report, citationValidation, rawEvidenceValidation, evidenceConsistencyValidation, traceEvidenceBoundary, ledger) {
  const keyExecutionEvidence = buildKeyExecutionEvidence(report, ledger);
  const lines = [
    ...renderReportOpening({
      title: `Trace RCA 报告：${report.caseId}`,
      rootCause: rcaRootCauseSentence(report),
      category: report.problemClassification?.category || "尚未归类（旧报告缺少问题类别）",
      detailHeading: "详细分析：从原因到最终结果",
    }),
    ...renderRcaPropagation(report),
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
  lines.push("", "## 关键 Tool/Skill 调用审计", "");
  if (!keyExecutionEvidence.length) {
    lines.push("> 本次调查未读取可展开的Tool/Skill交换；不能据此推断原始Trace中没有Tool或Skill调用。完整证据索引仍保存在 evidence-ledger.json。");
  }
  for (const item of keyExecutionEvidence) {
    const requestDisplay = reportDisplay(item.request);
    const responseDisplay = reportDisplay(item.response);
    const rcaReadChars = String(item.response ?? "").length;
    const rcaTotalChars = Number.isFinite(Number(item.responseTotalChars))
      ? Number(item.responseTotalChars)
      : rcaReadChars;
    lines.push(
      `### ${item.evidenceId} · ${item.executionKind === "skill" ? "Skill" : "Tool"} · ${item.toolName}`,
      "",
      `- Span ID：\`${item.spanId ?? "unknown"}\``,
      `- 状态：${item.status ?? "unknown"}`,
      `- 调查目的：${item.purpose}`,
      `- 最终报告是否直接引用该交换：${item.citedByFinalReport ? "是" : "否；但本次调查实际读取过，仍完整展示"}`,
      "- 原始 Trace 返回载荷：本项不以报告篇幅判断是否截断；以文末“Trace完整性与证据边界”为准",
      `- RCA 读取窗口：${item.responseTruncated ? `仅读取前 ${rcaReadChars}/${rcaTotalChars} 字符；可按 offset 继续读取` : `已读取完整返回 ${rcaReadChars}/${rcaTotalChars} 字符`}`,
      `- 报告正文展示：输入${requestDisplay.omitted ? `展示前 ${requestDisplay.shownChars}/${requestDisplay.totalChars} 字符` : `完整展示 ${requestDisplay.totalChars} 字符`}；返回${responseDisplay.omitted ? `展示前 ${responseDisplay.shownChars}/${responseDisplay.totalChars} 字符` : `完整展示 ${responseDisplay.totalChars} 字符`}`,
      `- 输入字符数：${item.requestTotalChars ?? "unknown"}；返回总字符数：${item.responseTotalChars ?? "unknown"}`,
      "",
      `**实际 ${item.executionKind === "skill" ? "Skill" : "Tool"} 输入/参数**`,
      "",
      fenced(item.request),
      "",
      `**实际 ${item.executionKind === "skill" ? "Skill" : "Tool"} 输出（报告内关键原文）**`,
      "",
      fenced(item.response),
      "",
      ...(item.citedExcerpts.length ? [
        "**本报告引用的返回值命中片段**",
        "",
        ...item.citedExcerpts.flatMap((hit) => [
          `- ${hit.evidenceId} · ${hit.field}[${hit.startOffset ?? 0}]`,
          fenced(hit.excerpt, 1800),
        ]),
        "",
      ] : []),
      `**原始证据定位**：${(item.rawRefs ?? []).map((ref) => `\`${ref.spanId}.${ref.field}[${ref.startOffset ?? 0}:${ref.endOffset ?? "end"}]\``).join("；") || "见 evidence-ledger.json"}`,
      `**输入原始文件**：${item.requestRawPath ? `\`${item.requestRawPath}#$.data.input\`` : "见 evidence-ledger.json"}`,
      `**返回原始文件**：${item.responseRawPath ? `\`${item.responseRawPath}#$.data.output\`` : "见 evidence-ledger.json"}`,
      "",
    );
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
    `- 调查状态：${report.causalInvestigationStatus ?? "legacy_report_without_field_closure"}`,
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
  lines.push("", ...renderCausalFindings(report));
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
