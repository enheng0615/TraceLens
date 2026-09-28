export function buildWithinPromptBudget({ builder, maxPromptChars, stage }) {
  const target = Math.max(1_000, Math.floor(maxPromptChars * 0.94));
  const plans = [
    { evidenceBudget: 24_000, executionBudget: 9_000 },
    { evidenceBudget: 18_000, executionBudget: 6_000 },
    { evidenceBudget: 12_000, executionBudget: 4_000 },
    { evidenceBudget: 7_000, executionBudget: 2_000 },
  ];
  for (const plan of plans) {
    const prompt = builder(plan);
    if (prompt.length <= target) return { prompt, plan, compacted: plan !== plans[0] };
  }
  const error = new Error(`${stage} minimum safe prompt exceeds budget after deterministic compaction`);
  error.code = "RCA_CONTEXT_BUDGET_EXHAUSTED";
  error.details = { stage, maxPromptChars, target };
  error.remediation = "减少单个输入正文或拆分该GT；完整Evidence Ledger已保留，可仅重试当前阶段。";
  throw error;
}
