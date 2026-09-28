import { TRACE_TOOL_DOCS } from "./trace-tools.mjs";

export const RCA_SYSTEM_PROMPT = `你是内部评测平台的Trace RCA调查Agent。你只接受官方评分定义的丢分事实，不重新评分，不质疑GT，不使用竞品信息。

调查原则：
1. 先重建IDA实际答案中已出现事实的生成链，再追踪GT要求但最终缺失的事实。
2. 不以关键词命中或缺失直接认定根因；关键词只用于定位。
3. 每个可疑分叉都必须向上检查为什么发生、向下检查是否影响最终答案，并检查替代解释。
4. 区分最终表现点、执行分叉点和可观察根因。
5. 对词面相近但口径不同的概念分别验证，不能直接合并（例如人员结构与人力规模或人力增长）。
6. 证据不足时明确unobservable，禁止补故事。
6.1 Trace存在局部缺口时，当前可见范围内的正向命中仍可使用；零命中只能写“当前可见Trace未发现”，不得写“全Trace不存在”。
7. 只引用证据账本中的EV编号。
8. 你输出的是显式、简洁的调查摘要和下一步动作，不要输出隐藏思维链。
9. 当前Sophon Provider没有原生Tool Calling。你必须以JSON actions请求应用层执行Trace工具。`;

function compactExecutionSteps(executionSteps, maxChars = 9_000) {
  const detailed = executionSteps.map((step) => ({
    order: step.order,
    timestamp: step.timestamp,
    spanId: step.spanId,
    parentSpanId: step.parentSpanId,
    spanType: step.spanType,
    name: step.name,
    status: step.status,
    outputSummary: step.outputSummary,
  }));
  if (JSON.stringify(detailed).length <= maxChars) return { total: detailed.length, omitted: 0, steps: detailed };
  const important = detailed.filter((step) => step.spanType === "GENERATION");
  const selected = new Map();
  for (const step of [...detailed.slice(0, 10), ...important, ...detailed.slice(-16)]) selected.set(step.spanId, step);
  const steps = [...selected.values()].sort((left, right) => left.order - right.order);
  return {
    total: detailed.length,
    omitted: detailed.length - steps.length,
    note: "中间步骤仅保留于不可变Trace和执行索引；模型可通过Trace工具按需读取。",
    steps,
  };
}

function compactOverview(overview) {
  return {
    sessionId: overview.sessionId,
    traceIds: overview.traceIds,
    spanCount: overview.spanCount,
    typeCounts: overview.typeCounts,
    primarySpanCount: overview.primarySpanCount,
    durationMs: overview.durationMs,
    integrity: overview.integrity
      ? {
          result: overview.integrity.result,
          counts: overview.integrity.counts,
          explicitTruncationMarkersFound: overview.integrity.explicitTruncationMarkersFound,
        }
      : null,
    toolNames: overview.toolNames,
  };
}

export function investigationPrompt({
  target, overview, executionSteps, ledger, round, coverageFeedback, traceEvidenceBoundary, workingState,
  evidenceBudget = 24_000, executionBudget = 9_000,
}) {
  const compactEvidence = ledger.toModelContext({ maxTotalChars: evidenceBudget });
  return `这是第${round}轮Trace调查。

调查合同：
${JSON.stringify(target)}

Trace客观总览：
${JSON.stringify(compactOverview(overview))}

Trace证据完整性边界：
${JSON.stringify(traceEvidenceBoundary ?? { classification: "unknown" })}

主执行链：
${JSON.stringify(compactExecutionSteps(executionSteps, executionBudget))}

当前调查工作状态：
${JSON.stringify(workingState ?? {})}

已有证据账本（模型导航用紧凑视图；完整原文仍保存在Evidence Ledger）：
${JSON.stringify(compactEvidence)}

${coverageFeedback ? `覆盖校验反馈：\n${coverageFeedback}\n` : ""}
可用Trace工具：
${JSON.stringify(TRACE_TOOL_DOCS)}

请决定下一步。不得重复已有的同参数调用。每轮最多3个actions。只返回JSON：
{
  "analysisSummary":"基于已有证据的简短观察；不要声称未被证据支持的事实",
  "actualAnswerPathStatus":"IDA已出现事实的生成链目前查到哪里",
  "requiredFactPathStatus":"GT完整事实的信息状态目前查到哪里",
  "openQuestions":["..."],
  "actions":[{"tool":"工具名","arguments":{},"purpose":"该动作要回答什么证据问题"}],
  "readyForConclusion":false,
  "proposedEvidenceBoundary":"当前最多能确定到哪里"
}
只有在实际答案链、缺失事实生命周期、上下游因果、替代解释和证据边界都检查后，才能令readyForConclusion=true。
已经调用过的同参数动作不得重复请求；若现有Trace无法回答剩余问题，应将其标记为unobservable并写入proposedEvidenceBoundary，而不是继续重复读取。覆盖校验已完成且所有可观察路径均已检查时，必须令readyForConclusion=true。`;
}

export function finalReportPrompt({ caseData, target, overview, ledger, evidenceBudget = 26_000 }) {
  const compactEvidence = ledger.toModelContext({ maxTotalChars: evidenceBudget });
  return `基于下列官方调查合同和已获取的Trace证据，生成最终RCA。不得重新评分。不得把搜索命中等同于理解，也不得把相关性写成因果。必须说明：实际答案生成链、GT完整事实的信息生命周期、最早实质分叉点、分叉的上游原因和下游影响、替代解释、证据边界。只引用存在的EV编号。不得把Schema字段被提供等同于模型已注意或理解该字段；不得把字段名在上下文中出现写成0命中；没有重放或干预证据时，因果置信度最高为medium。

调查合同：
${JSON.stringify(target)}

Trace总览：
${JSON.stringify(compactOverview(overview))}

Trace证据完整性边界：
${JSON.stringify(caseData.traceEvidenceBoundary ?? { classification: "unknown" })}

边界写作规则：若negativeEvidenceEligible=false，零命中只能表述为“当前可见Trace未发现”，并在evidenceBoundary.notProven中明确具体未知Tool/Span/字段；不得推断完整Trace中不存在。

证据账本（模型导航用紧凑视图；完整原文仍保存在Evidence Ledger）：
${JSON.stringify(compactEvidence)}

只返回JSON：
{
  "caseId":"${caseData.caseId}",
  "executiveSummary":"...",
  "scoreGap":{"criterionId":${JSON.stringify(target.criterion.id)},"observedDifference":"..."},
  "actualAnswerProductionChain":[{"step":"...","evidenceIds":["EV-..."]}],
  "requiredFactLifecycle":[{"stage":"data availability|planning|tool request|tool result|context propagation|intermediate conclusion|final answer","finding":"...","status":"present|absent|not_examined|unobservable","evidenceIds":["EV-..."]}],
  "earliestMaterialDivergence":{"finding":"...","whyMaterial":"...","evidenceIds":["EV-..."]},
  "causalChain":[{"finding":"...","evidenceIds":["EV-..."]}],
  "alternativeExplanations":[{"explanation":"...","status":"rejected|possible|unobservable","reason":"...","evidenceIds":["EV-..."]}],
  "rootCauseAssessment":{"finding":"可观察边界内的原因，不使用预设分类标签","confidence":"high|medium|low","evidenceIds":["EV-..."]},
  "evidenceBoundary":{"confirmed":"...","notProven":"..."},
  "recommendedNextVerification":["如果要提升因果强度应做什么重放或干预"]
}`;
}
