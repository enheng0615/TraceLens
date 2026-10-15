import { extractMissedCriteria, parseGroundTruth } from "./grading-parser.mjs";
import { isFullScore, parseStrictNumericScore } from "./score-utils.mjs";

function blank(value) {
  return !String(value ?? "").trim();
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function emptyObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function inspectMachineGrading(machineGrading) {
  const payload = parseObject(machineGrading);
  const errorSignals = [
    ["score_dict.error100", payload?.score_dict?.error100],
    ["error", payload?.error],
    ["error_message", payload?.error_message],
    ["origin_critic_res.error", payload?.origin_critic_res?.error],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== false && value !== 0 && value !== "0")
    .map(([field, value]) => ({ field, value: String(value).slice(0, 240) }));
  const conclusionMissed = payload?.conclusion?.结论?.缺失项?.inReportMissedRecall;
  const detailed = payload?.complete_v2?.用户需求一致性;
  return {
    empty: blank(machineGrading) || emptyObject(payload),
    jsonParsed: Boolean(payload && typeof payload === "object"),
    originCriticEmpty: emptyObject(payload?.origin_critic_res),
    missingIndicatorsEmpty: Array.isArray(payload?.origin_critic_res?.missing_indicators) && payload.origin_critic_res.missing_indicators.length === 0,
    labelingEvalScoreEmpty: Array.isArray(payload?.score_dict?.labeling_eval_score) && payload.score_dict.labeling_eval_score.length === 0,
    recognizedMissedListEmpty: Array.isArray(conclusionMissed) && conclusionMissed.length === 0,
    recognizedDetailedListEmpty: Array.isArray(detailed) && detailed.length === 0,
    errorSignals,
  };
}

function gtCount(value) {
  try { return parseGroundTruth(value).length; } catch { return 0; }
}

function detailFor(conditions) {
  const details = [];
  if (conditions.scoreMissing) details.push("score为空，机评未产出可用分数");
  else if (conditions.scoreInvalid) details.push("score不是0到1之间的有效数字");
  if (conditions.groundTruthMissing) details.push("GT为空");
  if (conditions.machineGradingEmpty) details.push("机评为空或{}");
  else details.push("机评未包含可识别的未命中GT");
  if (conditions.originCriticEmpty) details.push("origin_critic_res为空对象");
  if (conditions.missingIndicatorsEmpty) details.push("missing_indicators为空数组");
  if (conditions.labelingEvalScoreEmpty) details.push("labeling_eval_score为空数组");
  if (conditions.recognizedMissedListEmpty) details.push("机评缺失项列表为空");
  if (conditions.recognizedDetailedListEmpty) details.push("机评逐项验证列表为空");
  if (conditions.evaluatorErrors?.length) details.push(`评分器错误信号：${conditions.evaluatorErrors.map((item) => `${item.field}=${item.value}`).join("；")}`);
  return `${details.join("；")}。该行没有形成明确的官方未命中项，无法启动Trace归因。`;
}

/**
 * Inspect whether an evaluation row has an authoritative missed-GT target.
 * This is deliberately separate from RCA failure: incomplete upstream
 * evaluation output is recorded and skipped before Trace collection.
 */
export function inspectEvaluationInput({ score, machineGrading, groundTruth, explicitGt } = {}) {
  if (isFullScore(score)) return { kind: "full_score", criteria: [] };

  try {
    const criteria = extractMissedCriteria({ machineGrading, groundTruth, explicitGt });
    if (criteria.length) return { kind: "actionable", criteria };
  } catch (error) {
    if (error?.code !== "MISSED_GT_NOT_PARSED") {
      // A malformed GT catalog must not hide a directly stated missed GT.
      try {
        const criteria = extractMissedCriteria({ machineGrading, explicitGt });
        if (criteria.length) return { kind: "actionable", criteria, catalogWarning: error.message };
      } catch {}
    }
  }

  const numericScore = parseStrictNumericScore(score);
  const grading = inspectMachineGrading(machineGrading);
  const conditions = {
    scoreMissing: blank(score),
    scoreInvalid: !blank(score) && (numericScore === null || numericScore < 0 || numericScore > 1),
    groundTruthMissing: gtCount(groundTruth ?? explicitGt) === 0,
    machineGradingEmpty: grading.empty,
    originCriticEmpty: grading.originCriticEmpty,
    missingIndicatorsEmpty: grading.missingIndicatorsEmpty,
    labelingEvalScoreEmpty: grading.labelingEvalScoreEmpty,
    recognizedMissedListEmpty: grading.recognizedMissedListEmpty,
    recognizedDetailedListEmpty: grading.recognizedDetailedListEmpty,
    evaluatorErrors: grading.errorSignals,
    missedCriterionMissing: true,
  };
  const explicitUpstreamGap = conditions.scoreMissing || conditions.scoreInvalid || conditions.machineGradingEmpty ||
    conditions.originCriticEmpty || conditions.missingIndicatorsEmpty || conditions.labelingEvalScoreEmpty ||
    conditions.recognizedMissedListEmpty || conditions.recognizedDetailedListEmpty || conditions.evaluatorErrors.length > 0;
  if (!explicitUpstreamGap) {
    // A valid non-full score plus an unknown grading format may indicate a
    // parser compatibility defect. Keep the existing fail-closed path instead
    // of silently relabeling it as an upstream evaluation issue.
    return { kind: "unclassified", criteria: [] };
  }
  const code = conditions.evaluatorErrors.length
    ? "EVALUATION_SCORER_ERROR"
    : conditions.scoreMissing
    ? "EVALUATION_SCORE_OR_TARGET_MISSING"
    : conditions.scoreInvalid
      ? "EVALUATION_SCORE_INVALID_AND_TARGET_MISSING"
      : "EVALUATION_MISSED_GT_MISSING";
  return {
    kind: "evaluation_input_issue",
    criteria: [],
    issue: {
      code,
      status: "evaluation_input_issue",
      label: conditions.evaluatorErrors.length
        ? "评测执行异常：评分器返回错误"
        : conditions.scoreMissing
        ? conditions.groundTruthMissing ? "评测结果缺失：无分数、无GT和未命中项" : "评测结果缺失：无分数和未命中项"
        : conditions.scoreInvalid ? "评测结果异常：分数无效且无未命中项" : "评测结果冲突：非满分但未提供未命中GT",
      detail: detailFor(conditions),
      remediation: "请检查上游评测任务，补齐有效score和机评未命中项后重新导出CSV。当前行不会拉取Trace、不会调用模型，也不计为RCA失败。",
      conditions,
    },
  };
}

export function classifyEvaluationInputStatus(input = {}) {
  return inspectEvaluationInput(input).issue ?? null;
}
