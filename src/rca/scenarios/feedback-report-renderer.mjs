import { renderCausalFindings } from "../causal-renderer.mjs";
import { renderReportOpening, reportSentence } from "../report-template.mjs";

function evidence(ids) {
  return ids?.length ? `（证据：${ids.join("、")}）` : "";
}

function causalStatus(result) {
  return result.causalInvestigationStatus ?? result.report.rootCauseAssessment?.status ?? "unresolved";
}

function rootCauseSentence(result) {
  const status = causalStatus(result);
  if (status === "unresolved" || status === "symptom_only") {
    return "根因尚未定位：当前证据尚不能说明哪个上游决策或执行步骤造成了用户反馈。";
  }
  const headline = result.report.rootCauseHeadline;
  if (headline) {
    const prefix = status === "localized_unverified" ? "候选原因（尚未证实）：" : "当前证据支持的原因：";
    return `${prefix}${reportSentence(headline)}`;
  }
  // Older saved reports have no dedicated headline. Do not turn a long,
  // possibly overstated rootCauseAssessment into a confirmed conclusion.
  const firstSummarySentence = String(result.report.executiveSummary ?? "").match(/^([^。！？]{1,160})[。！？]/u)?.[1];
  if (status === "localized_unverified" && firstSummarySentence && /指向|可疑|候选|原因|偏差/u.test(firstSummarySentence)) {
    return `候选原因（尚未证实）：${firstSummarySentence}；这可能使未核对的结果进入交付并引发反馈，但因果关系仍待验证。`;
  }
  return status === "localized_unverified"
    ? "候选原因（尚未证实）：已定位到可疑的上游执行步骤及其下游使用，但尚不能证明它造成了用户反馈。"
    : "当前证据支持的原因：已定位上游偏差及其到交付结果的传递，具体过程见下文。";
}

function renderPropagation(result) {
  const { report, requirements = [], anchor = {} } = result;
  const status = causalStatus(result);
  const upstream = ["unresolved", "symptom_only"].includes(status) ? []
    : (report.causalFindings ?? []).filter((finding) => finding.localizationLevel !== "symptom_only");
  const lines = [];
  if (report.executiveSummary) lines.push(report.executiveSummary, "");
  if (status === "localized_unverified") lines.push("> 以下是已定位字段支持的候选传递路径；关键替代解释尚未排除，不能据此认定投诉的最终根因。", "");
  if (status === "symptom_only" || status === "unresolved") lines.push("> 目前只有反馈或交付现象，尚不能从上游根因构建完整因果链。下文按现有证据说明已知环节和缺口。", "");

  lines.push("### 1. 当时的要求与预期", "");
  const contractIds = new Set(upstream.flatMap((finding) => finding.contractEvidenceIds ?? []));
  const activeRequirements = requirements.filter((item) => item.status === "active" && (!contractIds.size || contractIds.has(item.evidenceId)));
  if (activeRequirements.length) {
    for (const item of activeRequirements) lines.push(`- ${item.quote} ${evidence([item.evidenceId].filter(Boolean))}`);
  } else if (upstream.length) {
    for (const finding of upstream) lines.push(`- ${finding.expectedBehavior} ${evidence(finding.contractEvidenceIds)}`);
  } else {
    lines.push("现有报告尚未建立可用于解释该反馈的明确历史要求。", "");
  }
  lines.push("", "### 2. 最早可定位的偏差及其形成机制", "");
  if (!upstream.length) {
    lines.push("尚未定位有证据支持的上游偏差；最终回答中的表现不能代替根因。", "");
  } else {
    for (const [index, finding] of upstream.entries()) {
      const loc = finding.location ?? {};
      lines.push(`- ${index + 1}. ${status === "localized_unverified" ? "候选位置" : "位置"}：Span ${loc.spanId ?? "未知"} / ${loc.field ?? "未知"} / ${loc.pointer ?? (Number.isInteger(loc.startOffset) ? `[${loc.startOffset}, ${loc.endOffset})` : "未知范围")}。${evidence(finding.evidenceIds)}`);
      lines.push(`  - ${status === "localized_unverified" ? "待验证的形成机制" : "形成机制"}：${finding.mechanism || "尚未查明为何出现该偏差。"}`);
    }
    if (status === "localized_unverified") lines.push("- 更上游的决策原因：现有证据尚不能确定为何选择这些参数或处理方式；模型误解、工具说明和数据口径等解释仍需逐项核验。");
    lines.push("");
  }
  lines.push("### 3. 偏差如何进入后续结果", "");
  const seen = new Set();
  const downstream = upstream.flatMap((finding) => finding.downstream ?? []).filter((edge) => {
    const key = `${edge.spanId}:${edge.mapping}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (downstream.length) {
    for (const [index, edge] of downstream.entries()) lines.push(`${index + 1}. ${edge.mapping} ${evidence(edge.evidenceIds)}`);
  } else {
    lines.push("尚无足够证据把可疑位置连接到最终交付。");
  }
  lines.push("", "### 4. 最终交付与用户反馈", "");
  lines.push(`- 报告记录的交付现象（按下文证据边界解读）：${report.phenomenon?.finding || "尚未独立核实具体交付内容。"} ${evidence(report.phenomenon?.evidenceIds)}`);
  lines.push(`- 用户反馈原文：${anchor.query ? `“${anchor.query}”` : "当前结果未保留反馈原文。"}`);
  lines.push("- 用户反馈是待核实的主张；反馈中的数字、产物版本或质量判断，不能仅凭反馈原文视为已证实。", "");
  lines.push("### 5. 因果判断与剩余缺口", "");
  lines.push(`- 已确认：${report.evidenceBoundary?.confirmed ?? "未提供"}`);
  lines.push(`- 尚未证明：${report.evidenceBoundary?.notProven ?? "未提供"}`, "");
  return lines;
}

/** Put two scoped conclusion sentences before the inspectable causal account. */
export function renderFeedbackReportMarkdown(result, { note } = {}) {
  const { report, focus = {} } = result;
  const classification = report.problemClassification;
  const lines = [
    ...renderReportOpening({
      title: "在线负向反馈分析",
      rootCause: rootCauseSentence(result),
      category: classification?.category || "尚未归类，需结合执行证据进一步判断",
      detailHeading: "详细分析：从原因到用户反馈",
    }),
    ...renderPropagation(result),
    "## 字段级证据与引用", "",
    `目标Turn：${focus.targetTurnId ?? "未确认"}`, "",
    ...renderCausalFindings(report, { showStatus: false, scopeUnverified: true }),
    "## 归类依据", "",
    classification?.rationale || "未提供", "",
  ];
  if (classification?.evidenceIds?.length) lines.push(`对应证据：${classification.evidenceIds.join(", ")}`, "");
  lines.push("完整字段、引用和校验结果见 feedback-result.json、evidence-ledger.json、validation.json；如已重审，另见 validation-reaudit.json。", "");
  if (note) lines.push(note, "");
  lines.push("## 核验信息", "",
    `- 反馈判断：${report.feedbackAssessment}`,
    `- 核验限制：${report.assessmentLimitations ?? report.evidenceBoundary?.notProven ?? "未提供"}`,
    `- 根因状态：${causalStatus(result)}`,
    `- 因果置信度：${report.rootCauseAssessment?.confidence ?? "未提供"}`, "");
  return lines.join("\n");
}
