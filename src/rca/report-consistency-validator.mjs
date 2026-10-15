const ABSENCE_PATTERNS = [
  /无匹配/i,
  /(?:0|零)\s*(?:次)?命中/i,
  /未出现/i,
  /从未出现/i,
  /不存在/i,
];
const WHOLE_TRACE_PATTERNS = [
  /全(?:部)?(?:trace|Trace)/,
  /整个(?:trace|Trace)/,
  /全部.*(?:span|Span)/,
  /上下文.*(?:无|未|从未)/,
];
const VISIBLE_SCOPE_QUALIFIERS = [
  /当前可见(?:的)?(?:trace|Trace)/,
  /已拉取(?:的)?(?:trace|Trace)/,
  /现有可观察(?:范围|边界)/,
  /可见Span/,
];
const ABSENCE_DISCLAIMER_PATTERNS = [
  /无法证明.*(?:无|未|不存在|从未)/i,
  /不能(?:证明|断言|确认).*(?:无|未|不存在|从未)/i,
  /不足以(?:证明|断言|确认).*(?:无|未|不存在|从未)/i,
  /现有证据不支持.*(?:无|未|不存在|从未)/i,
];

function clauses(value) {
  return String(value ?? "").split(/[。；;，,\n]/).map((item) => item.trim()).filter(Boolean);
}

function stringValues(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringValues(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringValues(item, result));
  return result;
}

function queryMentionedExactly(clause, query) {
  const lowerClause = String(clause).toLocaleLowerCase();
  const lowerQuery = String(query).toLocaleLowerCase();
  let cursor = 0;
  while (cursor <= lowerClause.length) {
    const index = lowerClause.indexOf(lowerQuery, cursor);
    if (index === -1) return false;
    const before = lowerClause.lastIndexOf("“", index);
    const beforeClose = lowerClause.lastIndexOf("”", index);
    const insideChineseQuote = before > beforeClose;
    if (insideChineseQuote) {
      const close = lowerClause.indexOf("”", index + lowerQuery.length);
      if (close !== -1 && lowerClause.slice(before + 1, close) === lowerQuery) return true;
    } else {
      return true;
    }
    cursor = index + Math.max(lowerQuery.length, 1);
  }
  return false;
}

function isMeaningfulQuery(query) {
  // One character such as "丙" is only a lexical fragment. It cannot
  // contradict a claim about the complete phrase "神鼠丙和神鼠丁".
  return [...String(query ?? "").replace(/[\s\p{P}\p{S}]/gu, "")].length >= 2;
}

function saysAbsence(clause) {
  if (ABSENCE_DISCLAIMER_PATTERNS.some((pattern) => pattern.test(clause))) return false;
  return ABSENCE_PATTERNS.some((pattern) => pattern.test(clause));
}

function isLowSpecificityNumericQuery(query) {
  return /^[-+]?\d+(?:\.\d+)?$/u.test(String(query ?? "").trim());
}

function claimsLiteralAbsence(clause) {
  return /(?:字面|字符|字符串|任何位置|零次|0次|完全未出现|一次都未)/i.test(clause);
}

function positiveMatchContradictsAbsence(query, clause) {
  // A pure number frequently occurs inside timestamps, ids and unrelated Tool
  // payloads. Positive lexical hits cannot disprove a scoped semantic claim
  // such as "未发现作为VaseVolume范围使用的820". They only contradict an
  // explicit claim that the literal characters never occurred anywhere.
  return !isLowSpecificityNumericQuery(query) || claimsLiteralAbsence(clause);
}

function claimsWholeTrace(clause) {
  return WHOLE_TRACE_PATTERNS.some((pattern) => pattern.test(clause));
}

function qualifiesVisibleScope(clause) {
  return VISIBLE_SCOPE_QUALIFIERS.some((pattern) => pattern.test(clause));
}

function citedObjects(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => citedObjects(item, result));
  } else if (value && typeof value === "object") {
    if (Array.isArray(value.evidenceIds)) result.push(value);
    Object.values(value).forEach((item) => citedObjects(item, result));
  }
  return result;
}

function objectText(value) {
  return Object.entries(value)
    .filter(([key, child]) => key !== "evidenceIds" && typeof child === "string")
    .map(([, child]) => child)
    .join("。 ");
}

/**
 * Deterministic guardrails for claims that can be checked without another LLM.
 * This intentionally does not pretend to validate all report semantics.
 */
export function validateReportEvidenceConsistency(report, ledger) {
  const errors = [];
  const byId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry]));

  for (const node of citedObjects(report)) {
    const textClauses = clauses(objectText(node));
    for (const evidenceId of node.evidenceIds) {
      const entry = byId.get(evidenceId);
      if (entry?.tool !== "search_trace") continue;
      const query = String(entry.arguments?.query ?? "");
      const matches = entry.result?.totalMatches;
      if (!query || !isMeaningfulQuery(query) || !Number.isFinite(matches)) continue;
      if (matches > 0) {
        for (const clause of textClauses.filter((item) => queryMentionedExactly(item, query))) {
          if (saysAbsence(clause) && positiveMatchContradictsAbsence(query, clause)) {
            errors.push(`${evidenceId} reports ${matches} matches for ${JSON.stringify(query)} but cited claim says absence: ${clause}`);
          }
        }
      } else if (entry.result?.coverage?.negativeEvidenceEligible === false) {
        for (const clause of textClauses.filter((item) => queryMentionedExactly(item, query))) {
          if (saysAbsence(clause) && !qualifiesVisibleScope(clause)) {
            errors.push(`${evidenceId} searched an incomplete visible corpus for ${JSON.stringify(query)}; absence must be scoped as 当前可见Trace未发现: ${clause}`);
          }
        }
      }
    }
  }

  const reportTextClauses = stringValues(report).flatMap(clauses);
  for (const entry of ledger.entries.filter((item) => item.tool === "search_trace" && item.result?.totalMatches > 0)) {
    const query = String(entry.arguments?.query ?? "");
    if (!isMeaningfulQuery(query)) continue;
    for (const clause of reportTextClauses.filter((item) => queryMentionedExactly(item, query))) {
      if (claimsWholeTrace(clause) && saysAbsence(clause) && positiveMatchContradictsAbsence(query, clause)) {
        errors.push(`${entry.evidenceId} reports ${entry.result.totalMatches} matches for ${JSON.stringify(query)} but report makes a whole-Trace absence claim: ${clause}`);
      }
    }
  }

  const partialSearches = ledger.entries.filter((item) =>
    item.tool === "search_trace" &&
    item.result?.coverage?.negativeEvidenceEligible === false
  );
  for (const clause of reportTextClauses) {
    if (partialSearches.length && claimsWholeTrace(clause) && saysAbsence(clause) && !qualifiesVisibleScope(clause)) {
      errors.push(`Trace has unknown Tool output segments; whole-Trace absence is not provable: ${clause}`);
    }
  }
  for (const entry of partialSearches.filter((item) => item.result?.totalMatches === 0 && isMeaningfulQuery(item.arguments?.query))) {
    const query = String(entry.arguments.query);
    for (const clause of reportTextClauses.filter((item) => queryMentionedExactly(item, query))) {
      if (!saysAbsence(clause)) continue;
      if (claimsWholeTrace(clause) || !qualifiesVisibleScope(clause)) {
        errors.push(`${entry.evidenceId} cannot support a whole-Trace absence claim because unknown Tool output segments remain: ${clause}`);
      }
    }
  }
  if (partialSearches.length && !/(未知|截断|缺口|不可见|不完整)/.test(String(report?.evidenceBoundary?.notProven ?? ""))) {
    errors.push("partial Trace negative evidence requires evidenceBoundary.notProven to name the unknown or truncated segment");
  }

  const confidence = report?.rootCauseAssessment?.confidence;
  const hasInterventionEvidence = ledger.entries.some(
    (entry) => entry.source === "intervention" || entry.tool === "replay_intervention",
  );
  if (confidence === "high" && !hasInterventionEvidence) {
    errors.push("high causal confidence requires replay/intervention evidence; observational Trace evidence supports at most medium");
  }

  return {
    valid: errors.length === 0,
    scope: "deterministic contradictions and confidence ceiling only; not full semantic verification",
    errors,
  };
}
