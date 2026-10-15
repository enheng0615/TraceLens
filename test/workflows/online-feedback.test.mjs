import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConversationTimeline, resolveFeedbackAnchor } from "../../src/workflows/online-feedback/feedback-anchor-resolver.mjs";
import { planFeedbackEpisode } from "../../src/workflows/online-feedback/episode-planner.mjs";
import { loadFeedbackTimeline } from "../../src/workflows/online-feedback/timeline-snapshot.mjs";
import { TraceRepository } from "../../src/rca/trace-repository.mjs";
import { runOnlineFeedbackCase, validateIntentLedger, validateFeedbackFocus, scopeFeedbackAssessment } from "../../src/rca/scenarios/online-feedback.mjs";

const turns = Array.from({ length: 14 }, (_, i) => ({ turnId: `turn-${i + 1}`, sessionId: "1", businessTraceId: `trace-${i + 1}`,
  startTime: (i + 1) * 10, endTime: (i + 1) * 10 + 5, status: "SUCCESS", input: i === 12 ? "不对" : `request-${i + 1}`, output: `answer-${i + 1}` }));
const timeline = buildConversationTimeline(turns);
const candidate = { sessionId: "1", requestQuery: "不对" };
const anchor = resolveFeedbackAnchor(timeline, candidate);

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feedback-episode-"));
  try {
    await mkdir(path.join(root, "spans/details/nested"), { recursive: true });
    await mkdir(path.join(root, "traces/trees"), { recursive: true });
    for (const t of turns) {
      await writeFile(path.join(root, `spans/details/nested/${t.turnId}.json`), JSON.stringify({ data: { id: t.turnId, sessionId: "1", traceId: t.businessTraceId,
        spanType: "AGENT", startTime: t.startTime, endTime: t.endTime, input: t.input, output: t.output } }));
      await writeFile(path.join(root, `traces/trees/${t.turnId}.json`), JSON.stringify({ data: { id: t.turnId, childs: [] } }));
    }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("expands a bounded initial window to an older explicit dependency", () => {
  const initial = planFeedbackEpisode({ timeline, anchor });
  assert.equal(initial.selectedTurns.length, 8);
  assert.equal(initial.selectedTurnIds.includes("turn-1"), false);
  const expanded = planFeedbackEpisode({ timeline, anchor, requiredTurnIds: ["turn-1"], reason: "artifact origin" });
  assert.equal(expanded.selectedTurns.length, 9);
  assert.equal(expanded.selectedTurnIds.includes("turn-1"), true);
  assert.equal(planFeedbackEpisode({ timeline, anchor, maxTurns: 8, requiredTurnIds: ["turn-1"] }).closure, "budget_exhausted");
  assert.throws(() => planFeedbackEpisode({ timeline, anchor, requiredTurnIds: ["turn-14"] }), /boundary|outside/);
});

test("loads only selected nested Spans and rejects future outputs or missing tree members", async () => {
  await fixture(async (root) => {
    const episode = planFeedbackEpisode({ timeline, anchor });
    const r = await TraceRepository.open(root, { episode });
    assert.equal(r.spans.length, 8);
    assert.equal(r.byId.has("turn-14"), false);
    assert.equal(r.search({ query: "absent", scope: "all" }).coverage.negativeEvidenceEligible, false);
    const f = path.join(root, "spans/details/nested/turn-12.json");
    const payload = JSON.parse(await readFile(f, "utf8")); payload.data.endTime = 140;
    await writeFile(f, JSON.stringify(payload));
    await assert.rejects(TraceRepository.open(root, { episode }), /boundary/);
    payload.data.endTime = 125; await writeFile(f, JSON.stringify(payload));
    await writeFile(path.join(root, "traces/trees/turn-12.json"), JSON.stringify({ data: { id: "turn-12", childs: [{ id: "missing" }] } }));
    await assert.rejects(TraceRepository.open(root, { episode }), /membership mismatch/);
  });
});

test("does not treat empty storage or unknown integrity as proof of absence", async () => {
  await fixture(async (root) => {
    const r = await TraceRepository.open(root);
    assert.equal(r.search({ query: "absent", scope: "all" }).coverage.negativeEvidenceEligible, false);
    await rm(path.join(root, "spans/details/nested"), { recursive: true });
    await assert.rejects(TraceRepository.open(root), /no readable Spans/);
  });
});

test("validates raw timeline pagination and Session ownership", async () => {
  await fixture(async (root) => {
    const dir = path.join(root, "session/detail-pages"); await mkdir(dir, { recursive: true });
    const file = path.join(dir, "page-0001.json");
    const data = { sessionId: "1", hasMore: false, total: turns.length, turns };
    await writeFile(file, JSON.stringify({ data }));
    assert.equal((await loadFeedbackTimeline(root, "1")).coverage.entireSessionHistoryProven, false);
    await assert.rejects(loadFeedbackTimeline(root, "2"), /Session mismatch/);
    data.hasMore = true; await writeFile(file, JSON.stringify({ data }));
    await assert.rejects(loadFeedbackTimeline(root, "1"), /pagination/);
    data.hasMore = false; data.total++; await writeFile(file, JSON.stringify({ data }));
    await assert.rejects(loadFeedbackTimeline(root, "1"), /count mismatch/);
  });
});

test("does not apply feedback-time requirements to an older target", () => {
  const focus = { targetTurnId: "turn-1" };
  assert.throws(() => validateIntentLedger([{ id: "R", turnId: "turn-13", quote: "不对", status: "active" }], timeline, focus, anchor), /did not exist/);
  const reqs = validateIntentLedger([{ id: "R", turnId: "turn-13", quote: "不对", status: "new_at_feedback" }], timeline, focus, anchor);
  assert.equal(reqs[0].sourceType, "user_input");
});

test("source quote selection confirms the delivery Turn while artifact identity remains separately unresolved", () => {
  const focus = validateFeedbackFocus({ status: "resolved", targetTurnId: "turn-1", targetType: "delivered_artifact", quoteIndex: 0 }, timeline, anchor);
  assert.equal(focus.quote, "answer-1");
  assert.equal(focus.status, "resolved");
  assert.equal(focus.artifactIdentityStatus, "unresolved");
  const report = { feedbackAssessment: "supported" };
  assert.ok(scopeFeedbackAssessment(report, focus));
  assert.equal(report.feedbackAssessment, "partially_supported");
  assert.throws(() => validateFeedbackFocus({ ...focus, quoteIndex: 99 }, timeline, anchor), /exact/);
});

test("online runner expands old focus, blocks future reads and persists unresolved outcome without a fake GT", async () => {
  await fixture(async (root) => {
    const outputDir = path.join(root, "run");
    const agent = { async invoke({ phase, prompt }) {
      assert.equal(prompt.includes('"officialMissedCriteria"'), false);
      if (phase === "feedback_final") return { rootCauseHeadline: "根因尚未定位，投诉数值和目标产物仍需核验。", executiveSummary: "尚未验证投诉数值", problemClassification: { category: "尚未定位具体缺陷", rationale: "投诉数值尚未核验", evidenceIds: [] }, feedbackAssessment: "unresolved", phenomenon: { status: "unresolved", evidenceIds: [] }, causalFindings: [], rootCauseAssessment: { confidence: "low", evidenceIds: [] } };
      return { focus: { status: "resolved", targetTurnId: "turn-1", targetType: "assistant_response_fragment", quote: "answer-1" }, requirements: [], hypotheses: [],
        actions: [{ tool: "get_turn_content", arguments: { turnId: "turn-14", field: "output" } }, { tool: "get_turn_content", arguments: { turnId: "turn-1", field: "input" } }], readyForConclusion: true };
    } };
    const result = await runOnlineFeedbackCase({ candidate, timeline, traceRoot: root, outputDir, agent, maxRounds: 1 });
    assert.equal(result.causalInvestigationStatus, "unresolved");
    assert.ok(result.episode.selectedTurnIds.includes("turn-1"));
    const entries = JSON.parse(await readFile(path.join(outputDir, "evidence-ledger.json"), "utf8"));
    assert.equal(entries.some((e) => e.result.turnId === "turn-14"), false);
    assert.equal(entries.some((e) => e.result.turnId === "turn-1"), true);
    await assert.rejects(runOnlineFeedbackCase({ candidate: { ...candidate, requestIdList: "changed" }, timeline, traceRoot: root, outputDir, agent, resume: true }), /identity changed/);
  });
});

test("final feedback validation can recover after three invalid proposals", async () => {
  await fixture(async (root) => {
    let finalAttempts = 0;
    const agent = { async invoke({ phase }) {
      if (phase !== "feedback_final") return { actions: [], readyForConclusion: true };
      finalAttempts += 1;
      return {
        rootCauseHeadline: finalAttempts < 4 ? "" : "根因尚未定位，当前证据不足以确认反馈原因。",
        executiveSummary: "当前证据不足以确认反馈原因。",
        problemClassification: { category: "尚未定位具体缺陷", rationale: "当前证据不足", evidenceIds: [] },
        feedbackAssessment: "unresolved", phenomenon: { status: "unresolved", evidenceIds: [] },
        causalFindings: [], rootCauseAssessment: { confidence: "low", evidenceIds: [] },
      };
    } };
    const result = await runOnlineFeedbackCase({ candidate, timeline, traceRoot: root, outputDir: path.join(root, "validation-run"), agent, maxRounds: 1 });
    assert.equal(result.status, "unresolved");
    assert.equal(finalAttempts, 4);
  });
});
