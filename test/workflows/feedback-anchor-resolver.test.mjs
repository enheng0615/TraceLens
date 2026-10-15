import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationTimeline,
  resolveFeedbackAnchor,
} from "../../src/workflows/online-feedback/feedback-anchor-resolver.mjs";

const timeline = buildConversationTimeline([
  {
    turnId: "turn-2", sessionId: "1", businessTraceId: "trace-2",
    startTime: 300, endTime: 400, input: "还是不对", output: "修复回答", status: "SUCCESS",
  },
  {
    turnId: "turn-1", sessionId: "1", businessTraceId: "trace-1",
    startTime: 100, endTime: 250, input: "原始请求", output: "有问题的回答", status: "SUCCESS",
  },
]);

test("resolves the negative query and creates a pre-feedback causal boundary", () => {
  const result = resolveFeedbackAnchor(timeline, {
    feedbackCandidateId: "NFC-1",
    sessionId: "1",
    requestQuery: "还是不对",
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.matchMethod, "exact");
  assert.equal(result.feedbackAnchor.ordinal, 2);
  assert.equal(result.feedbackAnchor.feedbackReceivedAt, 300);
  assert.equal(result.causalBoundary.priorTurnCount, 1);
  assert.equal(result.causalBoundary.immediatelyPreviousTurn.turnId, "turn-1");
});

test("accepts only controlled whitespace normalization as a fallback", () => {
  const result = resolveFeedbackAnchor(timeline, {
    feedbackCandidateId: "NFC-2",
    sessionId: "1",
    requestQuery: "还是  不对",
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.matchMethod, "whitespace_normalized_exact");
});

test("fails closed when normalized text maps to multiple Turns", () => {
  const repeated = buildConversationTimeline([
    ...timeline,
    {
      turnId: "turn-3", sessionId: "1", businessTraceId: "trace-3",
      startTime: 500, endTime: 600, input: "还是不对", output: "", status: "SUCCESS",
    },
  ]);
  const result = resolveFeedbackAnchor(repeated, {
    feedbackCandidateId: "NFC-3",
    sessionId: "1",
    requestQuery: "还是不对",
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.matchCount, 2);
  assert.equal(result.feedbackAnchor, null);
});

test("rejects wrong Session, missing times, duplicate IDs and mixed timelines", () => {
  assert.throws(() => resolveFeedbackAnchor(timeline, { sessionId: "other", requestQuery: "还是不对" }), /Session/);
  assert.throws(() => buildConversationTimeline([{ ...timeline[0], endTime: null }]), /Invalid endTime/);
  assert.throws(() => buildConversationTimeline([...timeline, timeline[0]]), /Duplicate/);
  assert.throws(() => buildConversationTimeline([timeline[0], { ...timeline[1], sessionId: "other" }]), /Mixed Session/);
  assert.throws(() => buildConversationTimeline([{ ...timeline[0], startTime: null }]), /Invalid startTime/);
});

test("preserves Latin word boundaries and uses an exact request link for repeated feedback", () => {
  const turns = buildConversationTimeline([
    { ...timeline[0], input: "a bc 不对" },
    { ...timeline[1], input: "a bc 不对" },
  ]);
  assert.equal(resolveFeedbackAnchor(turns, { sessionId: "1", requestQuery: "ab c 不对" }).status, "not_found");
  const anchored = resolveFeedbackAnchor(turns, { sessionId: "1", requestQuery: "a bc 不对", requestIdList: '["trace-2"]' });
  assert.equal(anchored.status, "resolved");
  assert.equal(anchored.feedbackAnchor.turnId, "turn-2");
});
