import { getJsonField } from "./field-evidence.mjs";
import { traceText } from "./trace-repository.mjs";

/** Mechanical evidence requirements, not a semantic proof of causality. */
export function validateCausalClosure(report, ledger, repository) {
  const errors = [];
  const findings = report.causalFindings ?? [];
  if (!Array.isArray(findings)) return { valid: false, errors: ["causalFindings must be an array"], status: "unresolved" };
  const known = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry]));
  const covered = (ids) => Array.isArray(ids) && ids.length > 0 && ids.every((id) => known.has(id));
  for (const [index, finding] of findings.entries()) {
    const at = `causalFindings[${index}]`;
    if (!["localized_unverified", "mechanism_supported", "intervention_supported"].includes(finding.status)) errors.push(`${at}: invalid status`);
    const loc = finding.location;
    const locatedSpan = repository.byId.get(loc?.spanId);
    finding.localizationLevel = locatedSpan?.spanType === "AGENT" && loc.field === "output" ? "symptom_only"
      : locatedSpan?.spanType === "TOOL" ? "execution_field" : locatedSpan?.spanType === "GENERATION" ? "generation_contract_or_decision" : "unknown";
    if (finding.localizationLevel === "symptom_only" && finding.status !== "localized_unverified") errors.push(`${at}: final delivery alone cannot establish an upstream root cause`);
    try {
      if (!loc || !["input", "output"].includes(loc.field)) throw new Error("Exact source field is required");
      let bound;
      const rawSource = repository.byId.get(loc.spanId)?.[loc.field];
      let textRoot = false;
      if (loc.pointer === "" && loc.quote) { try { JSON.parse(rawSource); } catch { textRoot = true; } }
      if (typeof loc.pointer === "string" && !textRoot) {
        const actual = getJsonField(repository, { ...loc, length: 12000 });
        if (actual.truncated || (loc.fieldSha256 && actual.fieldSha256 !== loc.fieldSha256)) throw new Error("Location field hash differs from recorded field or is incomplete");
        loc.fieldSha256 = actual.fieldSha256;
        bound = (finding.evidenceIds ?? []).some((id) => {
          const entry = known.get(id);
          return entry?.tool === "get_json_field" && entry.result?.truncated === false && entry.rawRefs?.some((r) => r.spanId === loc.spanId && r.field === loc.field
            && (r.pointer === loc.pointer || (entry.result?.truncated === false && typeof r.pointer === "string" && loc.pointer.startsWith(`${r.pointer}/`)))
            && Boolean(r.decodeJsonStrings) === Boolean(loc.decodeJsonStrings));
        });
      } else {
        const raw = repository.byId.get(loc.spanId)?.[loc.field];
        if (typeof raw !== "string" || !loc.quote) throw new Error("Text location needs an exact quote");
        const start = Number.isInteger(loc.startOffset) ? loc.startOffset : raw.indexOf(loc.quote);
        if (start < 0 || raw.slice(start, start + loc.quote.length) !== loc.quote || (!Number.isInteger(loc.startOffset) && raw.lastIndexOf(loc.quote) !== start)) throw new Error("Text quote is absent or ambiguous");
        if (loc.contentSha256 && loc.contentSha256 !== traceText.sha256(raw)) throw new Error("Text content hash differs from recorded field");
        loc.startOffset = start; loc.endOffset = start + loc.quote.length; loc.contentSha256 = traceText.sha256(raw);
        delete loc.pointer;
        bound = (finding.evidenceIds ?? []).some((id) => known.get(id)?.tool === "get_span_content" && known.get(id)?.rawRefs?.some((r) => r.spanId === loc.spanId && r.field === loc.field && r.startOffset <= loc.startOffset && r.endOffset >= loc.endOffset));
      }
      if (!bound) throw new Error("Location is not bound to a cited exact field read");
    } catch (error) { errors.push(`${at}: ${error.message}`); }
    if (!covered(finding.evidenceIds)) errors.push(`${at}: defect evidence is missing`);
    if (!finding.expectedBehavior || !covered(finding.contractEvidenceIds)) errors.push(`${at}: expected behavior needs source evidence`);
    else if (finding.contractEvidenceIds.every((id) => {
      const entry = known.get(id);
      return !(entry.rawRefs?.some((ref) => ref.spanId !== loc?.spanId || ref.field !== loc?.field || ref.pointer !== loc?.pointer)
        || (entry.tool === "get_turn_content" && entry.result?.field === "input" && entry.result?.content));
    })) errors.push(`${at}: defect value alone cannot establish expected behavior`);
    const locationTime = repository.byId.get(loc?.spanId)?.startTime;
    finding.contractAvailability = (finding.contractEvidenceIds ?? []).some((id) => {
      const entry = known.get(id);
      return (entry?.tool === "get_turn_content" && entry.result.field === "input" && entry.result.startTime <= locationTime)
        || entry?.rawRefs?.some((ref) => {
          const span = repository.byId.get(ref.spanId);
          return Number.isFinite(ref.field === "input" ? span?.startTime : span?.endTime)
            && (ref.field === "input" ? span.startTime : span.endTime) <= locationTime;
        });
    }) ? "available_before_call" : "observed_after_call_or_unknown";
    if (finding.status !== "localized_unverified") {
      if (report.phenomenon?.status !== "confirmed" || !covered(report.phenomenon?.evidenceIds)) errors.push(`${at}: delivery phenomenon is not confirmed`);
      if (!finding.mechanism || !finding.downstream?.length || !finding.alternatives?.length) errors.push(`${at}: mechanism, downstream mapping and alternatives are required`);
      for (const edge of finding.downstream ?? []) {
        if (!covered(edge.evidenceIds) || !edge.mapping || !repository.byId.has(edge.spanId)
          || !edge.evidenceIds.some((id) => known.get(id)?.rawRefs?.some((ref) => ref.spanId === edge.spanId))) errors.push(`${at}: downstream mapping needs a real Span and source evidence`);
      }
      for (const alternative of finding.alternatives ?? []) {
        if (!covered(alternative.evidenceIds) || alternative.status !== "rejected") errors.push(`${at}: unresolved alternatives require localized_unverified status`);
      }
    }
    if (finding.status === "intervention_supported") {
      const experiments = (finding.verificationEvidenceIds ?? []).map((id) => known.get(id));
      if (!experiments.length || !experiments.every((entry) => entry?.source === "intervention" && entry.result?.baseline && entry.result?.controlledChange && entry.result?.outcome && entry.result?.dataVersion)) errors.push(`${at}: controlled intervention evidence is unavailable`);
    }
  }
  const status = !findings.length ? "unresolved" : findings.every((f) => f.localizationLevel === "symptom_only") ? "symptom_only" : findings.every((f) => f.status === "intervention_supported") ? "intervention_supported"
    : findings.every((f) => f.status !== "localized_unverified") ? "mechanism_supported" : "localized_unverified";
  if (/high/i.test(String(report.rootCauseAssessment?.confidence)) && status !== "intervention_supported") errors.push("Observational causal confidence must not exceed medium");
  return { valid: errors.length === 0, errors, status: errors.length ? "unresolved" : status,
    scope: "Checks exact locations, source bindings and required proof structure; semantic entailment remains reviewable." };
}

export function mergeHypotheses(previous, updates = [], ledger) {
  if (!Array.isArray(updates) || updates.length > 12) throw new Error("hypotheses must be an array of at most 12 items");
  const known = ledger.ids();
  const result = new Map(previous.map((h) => [h.id, h]));
  for (const hypothesis of updates) {
    if (!hypothesis.id || !hypothesis.question || !hypothesis.discriminatingCheck || !["open", "supported", "rejected", "unobservable"].includes(hypothesis.status)) throw new Error("Hypothesis needs id, question, discriminatingCheck and status");
    if ([...(hypothesis.supportEvidenceIds ?? []), ...(hypothesis.counterEvidenceIds ?? [])].some((id) => !known.has(id))) throw new Error("Hypothesis cites unknown evidence");
    if (["supported", "rejected"].includes(hypothesis.status) && ![...(hypothesis.supportEvidenceIds ?? []), ...(hypothesis.counterEvidenceIds ?? [])].length) throw new Error("Closing a hypothesis requires recorded evidence");
    result.set(hypothesis.id, hypothesis);
  }
  return [...result.values()];
}

/** Preserve overstatements as hypotheses, with an explicit program-generated limit. */
export function scopeCausalFindings(report) {
  const adjustments = [];
  for (const finding of Array.isArray(report.causalFindings) ? report.causalFindings : []) {
    if (finding.status === "mechanism_supported" && (finding.alternatives ?? []).some((a) => a.status !== "rejected")) {
      finding.claimedStatus = finding.status;
      finding.status = "localized_unverified";
      finding.closureLimitations = "关键替代解释仍未排除，程序将机制结论保留为待验证定位。";
      adjustments.push(finding.closureLimitations);
    }
  }
  return adjustments;
}

/** New source reads require another model pass; fetching alone is not endorsement. */
export function materializeLocationEvidence(report, ledger, repository) {
  const added = [];
  for (const finding of Array.isArray(report.causalFindings) ? report.causalFindings : []) {
    const loc = finding.location;
    if (!loc) continue;
    try {
      let tool, args, result;
      const raw = repository.byId.get(loc.spanId)?.[loc.field];
      let validJson = false; try { JSON.parse(raw); validJson = true; } catch {}
      if (typeof loc.pointer === "string" && (validJson || !loc.quote)) {
        tool = "get_json_field";
        args = { spanId: loc.spanId, field: loc.field, pointer: loc.pointer, decodeJsonStrings: Boolean(loc.decodeJsonStrings), length: 12000 };
        result = getJsonField(repository, args);
      } else {
        if (typeof raw !== "string" || !loc.quote || raw.indexOf(loc.quote) < 0 || raw.indexOf(loc.quote) !== raw.lastIndexOf(loc.quote)) continue;
        tool = "get_span_content";
        args = { spanId: loc.spanId, field: loc.field, start: raw.indexOf(loc.quote), length: Math.min(12000, loc.quote.length) };
        result = repository.getSpanContent(args);
      }
      const prior = ledger.entries.find((e) => e.tool === tool && JSON.stringify(e.arguments) === JSON.stringify(args));
      const evidence = prior ?? ledger.add({ source: "program", tool, arguments: args, purpose: "最终报告提出精确位置，补读并要求模型重新核对", result });
      finding.evidenceIds = [...new Set([...(finding.evidenceIds ?? []), evidence.evidenceId])];
      if (!prior) added.push(evidence.evidenceId);
    } catch { /* Invalid locations remain validator errors; never invent a source. */ }
  }
  return added;
}
