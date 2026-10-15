import { createHash } from "node:crypto";

function normalizeExact(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Controlled fallback for display-only whitespace differences. This does not
 * remove punctuation or perform fuzzy/semantic matching.
 */
function normalizeWhitespace(value) {
  return normalizeExact(value).replace(/\s+/gu, " ").replace(/(?<=[\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/gu, "");
}

function byTime(left, right) {
  return Number(left.startTime ?? 0) - Number(right.startTime ?? 0)
    || Number(left.endTime ?? 0) - Number(right.endTime ?? 0)
    || String(left.turnId ?? "").localeCompare(String(right.turnId ?? ""));
}

export function buildConversationTimeline(turns) {
  if (!Array.isArray(turns)) throw new Error("turns must be an array");
  const ids = new Set();
  for (const turn of turns) {
    if (!turn.turnId || !turn.sessionId) throw new Error("Timeline requires turnId and sessionId");
    if (ids.has(String(turn.turnId))) throw new Error(`Duplicate Turn: ${turn.turnId}`);
    ids.add(String(turn.turnId));
    for (const field of ["startTime", "endTime"]) {
      if (turn[field] === null || turn[field] === undefined || turn[field] === "" || !Number.isFinite(Number(turn[field])) || Number(turn[field]) <= 0) {
        throw new Error(`Invalid ${field} for Turn ${turn.turnId}`);
      }
    }
    if (Number(turn.endTime) < Number(turn.startTime)) throw new Error(`Invalid time interval for Turn ${turn.turnId}`);
  }
  if (new Set(turns.map((turn) => String(turn.sessionId))).size > 1) throw new Error("Mixed Session timeline");
  return [...turns].sort(byTime).map((turn, index) => ({
    ordinal: index + 1,
    turnId: String(turn.turnId ?? ""),
    sessionId: String(turn.sessionId ?? ""),
    spanId: turn.spanId ? String(turn.spanId) : null,
    businessTraceId: turn.businessTraceId ? String(turn.businessTraceId) : null,
    startTime: Number(turn.startTime),
    endTime: Number(turn.endTime),
    status: String(turn.status ?? ""),
    input: String(turn.input ?? ""),
    output: String(turn.output ?? ""),
  }));
}

function candidateMatches(timeline, query, normalizer) {
  const target = normalizer(query);
  if (!target) return [];
  return timeline.filter((turn) => normalizer(turn.input) === target);
}

/**
 * Locate one negative request_query on the immutable Session Turn timeline.
 * Exact equality is preferred; whitespace-normalized equality is accepted
 * only when it resolves to one unique Turn.
 */
export function resolveFeedbackAnchor(timeline, candidate) {
  // Callers may supply a prebuilt timeline; validate that path too.
  timeline = buildConversationTimeline(timeline);
  const sessionId = String(candidate?.sessionId ?? candidate?.session_id ?? "");
  if (!sessionId || timeline.some((turn) => turn.sessionId !== sessionId)) throw new Error("Feedback Session does not match timeline");
  const query = String(candidate?.requestQuery ?? candidate?.request_query ?? "");
  let requestIds = candidate?.requestIdList ?? candidate?.request_id_list ?? [];
  if (typeof requestIds === "string") {
    try { requestIds = JSON.parse(requestIds); } catch { requestIds = requestIds.split(/[|,\s]+/u); }
  }
  if (!Array.isArray(requestIds)) requestIds = [requestIds];
  const explicitId = candidate?.turnId ?? candidate?.traceId ?? candidate?.spanId;
  const acceptedIds = new Set([explicitId, ...requestIds].filter(Boolean).map(String));
  const linked = timeline.filter((turn) => [turn.turnId, turn.spanId, turn.businessTraceId].some((id) => id && acceptedIds.has(id)));
  if (explicitId && !linked.length) throw new Error("Explicit feedback identifier not found in timeline");
  const candidates = linked.length ? linked : timeline;
  const exact = candidateMatches(candidates, query, normalizeExact);
  const fallback = exact.length ? [] : candidateMatches(candidates, query, normalizeWhitespace);
  const matches = exact.length ? exact : fallback;
  const matchMethod = exact.length ? "exact" : fallback.length ? "whitespace_normalized_exact" : "not_found";
  const status = matches.length === 1 ? "resolved" : matches.length > 1 ? "ambiguous" : "not_found";
  const anchor = matches.length === 1 ? matches[0] : null;
  const cutoffTimestamp = anchor?.startTime ?? null;
  const priorTurns = anchor
    ? timeline.filter((turn) => turn.startTime < cutoffTimestamp && turn.endTime <= cutoffTimestamp && turn.turnId !== anchor.turnId)
      .sort((a, b) => a.endTime - b.endTime || byTime(a, b))
    : [];
  const overlappingPriorTurns = anchor
    ? timeline.filter((turn) =>
        turn.turnId !== anchor.turnId
        && Number(turn.startTime) < cutoffTimestamp
        && Number(turn.endTime) > cutoffTimestamp)
    : [];

  return {
    feedbackCandidateId: candidate?.feedbackCandidateId ?? candidate?.feedback_candidate_id ?? null,
    sessionId: candidate?.sessionId ?? candidate?.session_id ?? anchor?.sessionId ?? null,
    status,
    matchMethod,
    identityMethod: linked.length ? "verified_turn_trace_or_span_identifier" : "text_only",
    query,
    matchCount: matches.length,
    matches: matches.map((turn) => ({
      ordinal: turn.ordinal,
      turnId: turn.turnId,
      spanId: turn.spanId,
      businessTraceId: turn.businessTraceId,
      startTime: turn.startTime,
      endTime: turn.endTime,
      status: turn.status,
    })),
    feedbackAnchor: anchor ? {
      ordinal: anchor.ordinal,
      turnId: anchor.turnId,
      spanId: anchor.spanId,
      businessTraceId: anchor.businessTraceId,
      feedbackReceivedAt: cutoffTimestamp,
      turnEndTime: anchor.endTime,
      status: anchor.status,
    } : null,
    causalBoundary: anchor ? {
      cutoffExclusive: cutoffTimestamp,
      rule: "Only completed turns with endTime <= feedbackReceivedAt are eligible for pre-feedback causal analysis",
      priorTurnCount: priorTurns.length,
      overlappingPriorTurnCount: overlappingPriorTurns.length,
      immediatelyPreviousTurn: priorTurns.length ? {
        ordinal: priorTurns.at(-1).ordinal,
        turnId: priorTurns.at(-1).turnId,
        businessTraceId: priorTurns.at(-1).businessTraceId,
        startTime: priorTurns.at(-1).startTime,
        endTime: priorTurns.at(-1).endTime,
      } : null,
    } : null,
  };
}


/** Full available Turn timeline is searched first; detailed Trace stays bounded. */
export function planFeedbackEpisode({ timeline, anchor, requiredTurnIds = [], priorTurns = 8, maxTurns = 24, reason = "initial_window" }) {
  if (anchor?.status !== "resolved") throw new Error("Episode requires a uniquely resolved feedback anchor");
  if (!Number.isInteger(priorTurns) || priorTurns < 1 || !Number.isInteger(maxTurns) || maxTurns < priorTurns) throw new Error("Invalid episode Turn budget");
  timeline = buildConversationTimeline(timeline);
  if (timeline.some((t) => t.sessionId !== String(anchor.sessionId))) throw new Error("Episode Session mismatch");
  const cutoff = anchor.feedbackAnchor.feedbackReceivedAt;
  const prior = timeline.filter((t) => t.startTime < cutoff && t.endTime <= cutoff && t.turnId !== anchor.feedbackAnchor.turnId)
    .sort((a, b) => a.endTime - b.endTime || a.startTime - b.startTime);
  const eligible = new Map(prior.map((t) => [t.turnId, t]));
  for (const id of requiredTurnIds) if (!eligible.has(id)) throw new Error(`Required Turn is outside the pre-feedback timeline: ${id}`);
  const selected = new Map(prior.slice(-priorTurns).map((t) => [t.turnId, t]));
  const missing = [];
  for (const id of requiredTurnIds) {
    if (!selected.has(id) && selected.size >= maxTurns) missing.push(id);
    else selected.set(id, eligible.get(id));
  }
  const turns = [...selected.values()].sort((a, b) => a.startTime - b.startTime);
  if (turns.some((t) => !t.businessTraceId)) throw new Error("Selected Turn is missing businessTraceId");
  const basis = { sessionId: String(anchor.sessionId), feedbackTurnId: anchor.feedbackAnchor.turnId, feedbackReceivedAt: cutoff, selectedTurnIds: turns.map((t) => t.turnId), traceIds: [...new Set(turns.map((t) => t.businessTraceId))] };
  return { schemaVersion: "feedback-episode-v1", ...basis,
    episodeId: createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 24),
    selectedTurns: turns, scope: "selected_pre_feedback_turns", reason,
    maxTurns, missingRequiredTurnIds: missing,
    closure: missing.length ? "budget_exhausted" : "selection_ready",
    historyComplete: false, payloadCompleteness: "requires_repository_audit",
  };
}
