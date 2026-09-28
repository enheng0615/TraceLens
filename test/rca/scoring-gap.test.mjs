import assert from "node:assert/strict";
import test from "node:test";
import { locateAnswerQuote, validateScoringGapTarget } from "../../src/rca/scoring-gap.mjs";

const caseData = {
  query: "23年5月高利贷的突然增加，是什么原因",
  officialMissedCriteria: [{ text: "Self-Employed用于Debt Consolidation的Personal Loan增多", officialVerdict: "未命中" }],
  idaAnswer: "5月的增量来自个人贷和Debt Consolidation。",
};

test("accepts a grounded neutral scoring gap and resolves answer offsets", () => {
  const target = {
    criterion: { text: caseData.officialMissedCriteria[0].text, officialVerdict: "未命中" },
    requiredState: { elements: [{ source: { type: "ground_truth", excerpt: "Self-Employed" } }] },
    answerState: { relevantExcerpts: [{ quote: "个人贷和Debt Consolidation" }] },
    difference: { summary: "最终答案没有呈现Self-Employed主体限定" },
    phenomenonToExplain: "解释最终答案呈现宽泛组合但没有呈现主体限定的运行过程。",
  };
  const result = validateScoringGapTarget(target, caseData);
  assert.equal(result.valid, true);
  assert.equal(result.target.answerState.relevantExcerpts[0].startOffset, 7);
});

test("rejects pre-Trace causal labels and fabricated quotes", () => {
  const target = {
    rootCauseType: "tool_error",
    criterion: { text: caseData.officialMissedCriteria[0].text, officialVerdict: "未命中" },
    requiredState: { elements: [] },
    answerState: { relevantExcerpts: [{ quote: "不存在的原文" }] },
    phenomenonToExplain: "因为工具导致遗漏",
  };
  const result = validateScoringGapTarget(target, caseData);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});


test("deterministically restores Markdown and whitespace in a unique quote", () => {
  const answer = "对5月个人贷高利贷按贷款用途拆解，155笔中有 **102笔集中在 Debt Consolidation（以贷还贷/债务重组）**，其余不变。";
  const modelQuote = "对5月个人贷高利贷按贷款用途拆解，155笔中有102笔集中在 Debt Consolidation（以贷还贷/债务重组）";
  const located = locateAnswerQuote(answer, modelQuote);
  assert.equal(located.alignment, "display_normalized_unique");
  assert.equal(located.quote, "对5月个人贷高利贷按贷款用途拆解，155笔中有 **102笔集中在 Debt Consolidation（以贷还贷/债务重组）");
  assert.equal(answer.slice(located.startOffset, located.endOffset), located.quote);
});

test("does not auto-align an ambiguous display-normalized quote", () => {
  assert.equal(locateAnswerQuote("**同一句**，然后再次出现_同一句_。", "同 一句"), null);
});

test("accepts causal words copied inside an exact IDA quote", () => {
  const localCase = {
    query: "为什么TTR上升",
    officialMissedCriteria: [{ text: "工单数量增长较大，人力相对增长较小。", officialVerdict: "未命中" }],
    idaAnswer: "处理能力未同步覆盖，导致积压持续扩大。",
  };
  const target = {
    criterion: { text: localCase.officialMissedCriteria[0].text, officialVerdict: "未命中" },
    requiredState: { elements: [{ source: { type: "ground_truth", excerpt: "人力相对增长较小" } }] },
    answerState: {
      summary: "答案提到了处理能力和积压。",
      relevantExcerpts: [{ quote: "处理能力未同步覆盖，导致积压持续扩大" }],
    },
    difference: {
      summary: "答案没有呈现人力增长情况。",
      requiredButNotPresent: ["人力相对增长较小"],
      presentAndRelevant: ["处理能力未同步覆盖"],
    },
    phenomenonToExplain: "解释人力增长信息没有进入最终答案的运行过程。",
  };
  assert.equal(validateScoringGapTarget(target, localCase).valid, true);
});

test("still rejects causal language authored in a generated pre-Trace field", () => {
  const target = {
    criterion: { text: caseData.officialMissedCriteria[0].text, officialVerdict: "未命中" },
    requiredState: { elements: [{ source: { type: "ground_truth", excerpt: "Self-Employed" } }] },
    answerState: { relevantExcerpts: [{ quote: "个人贷和Debt Consolidation" }] },
    difference: { summary: "最终答案没有呈现主体限定" },
    phenomenonToExplain: "因为工具导致主体限定遗漏",
  };
  const result = validateScoringGapTarget(target, caseData);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("phenomenonToExplain")));
});

test("registers grader causal language as provenance and revalidates the normalized target", () => {
  const localCase = {
    query: "为什么TTR上升",
    officialMissedCriteria: [{ id: "GT-1", text: "工单数量增长较大，人力相对增长较小。", officialVerdict: "未命中" }],
    machineGrading: "因为没有提到人力增长，所以该GT未命中。",
    idaAnswer: "工单量增长导致积压扩大。",
  };
  const candidate = {
    criterion: { text: localCase.officialMissedCriteria[0].text, officialVerdict: "未命中" },
    requiredState: { elements: [{ description: "模型自己的占位文本", source: { type: "ground_truth", excerpt: "人力相对增长较小" } }] },
    answerState: { relevantExcerpts: [{ quote: "工单量增长导致积压扩大" }] },
    difference: { summary: "仅描述表面差距" },
    phenomenonToExplain: "调查该评分差距在运行轨迹中的信息生命周期。",
  };
  const first = validateScoringGapTarget(candidate, localCase);
  assert.equal(first.valid, true);
  assert.equal(first.target.sourceRegistry.some((source) => source.sourceType === "grader_claim"), true);
  assert.deepEqual(first.target.sourceAttribution.criterion, ["SRC-GT-CRITERION"]);
  assert.deepEqual(first.target.sourceAttribution.officialGraderReason, ["SRC-GRADER-001"]);
  assert.equal(first.target.requiredState.elements[0].description, "要求呈现：人力相对增长较小");
  const second = validateScoringGapTarget(first.target, localCase);
  assert.equal(second.valid, true);
});
