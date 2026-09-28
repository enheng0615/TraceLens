function collectRawRefs(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.spanId && value.field && value.contentSha256) result.push(value);
  for (const item of Object.values(value)) collectRawRefs(item, result);
  return result;
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…<truncated>`;
}

function compactIndexEntry(entry) {
  return {
    evidenceId: entry.evidenceId,
    source: entry.source,
    tool: entry.tool,
    purpose: truncate(entry.purpose, 180),
  };
}

function minimalIndexEntry(entry) {
  return { evidenceId: entry.evidenceId, tool: entry.tool };
}

function stripRawRefs(value) {
  if (Array.isArray(value)) return value.map(stripRawRefs);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/EvidenceRef$/.test(key) || key === "rawRefs" || key === "rawPath" || key === "contentSha256") continue;
    result[key] = stripRawRefs(child);
  }
  return result;
}

function compactSearch(result) {
  return {
    query: result.query,
    scope: result.scope,
    fields: result.fields,
    coverage: result.coverage
      ? {
          searchedSpans: result.coverage.searchedSpans,
          searchedFields: result.coverage.searchedFields,
          searchedChars: result.coverage.searchedChars,
          complete: result.coverage.complete,
          visibleCorpusComplete: result.coverage.visibleCorpusComplete,
          negativeEvidenceEligible: result.coverage.negativeEvidenceEligible,
          unknownSegments: result.coverage.unknownSegments,
        }
      : undefined,
    totalMatches: result.totalMatches,
    returnedHits: result.returnedHits,
    hits: (result.hits ?? []).slice(0, 8).map((hit) => ({
      spanId: hit.spanId,
      spanType: hit.spanType,
      spanName: hit.spanName,
      field: hit.field,
      startOffset: hit.startOffset,
      excerpt: truncate(hit.excerpt, 420),
    })),
    hitDisplayNote:
      (result.hits?.length ?? 0) > 8
        ? `Only 8 of ${result.hits.length} returned hits are shown in model context; full result remains in evidence ledger.`
        : undefined,
  };
}

function compactToolExchange(result) {
  const request = result.request?.arguments ?? result.request ?? {};
  return {
    spanId: result.spanId,
    name: result.name,
    timestamp: result.timestamp,
    status: result.status,
    durationMs: result.durationMs,
    request: {
      goal: request.goal,
      instruction: truncate(request.instruction, 2600),
      ansi_sql: truncate(request.ansi_sql, 2600),
      query: request.query,
      data_set_id_list: request.data_set_id_list,
      code: truncate(request.code, 5000),
      command: truncate(request.command, 3600),
      file_path: request.file_path,
      line_range: request.line_range,
      action: request.action,
      content: truncate(request.content, 5000),
      ops_text: truncate(request.ops_text, 1800),
    },
    response: truncate(result.response, 2800),
    responseTruncatedInRawToolRead: result.responseTruncated,
  };
}

function compactSpanContent(result) {
  return {
    span: result.span,
    field: result.field,
    range: result.range,
    truncatedBefore: result.truncatedBefore,
    truncatedAfter: result.truncatedAfter,
    content: truncate(result.content, 3200),
  };
}

function compactQueries(result) {
  return result.map((item) => ({
    spanId: item.spanId,
    timestamp: item.timestamp,
    goal: item.goal,
    instruction: item.instruction,
    sql: truncate(item.sql, 1100),
    outputFilePrefix: item.outputFilePrefix,
  }));
}

function compactExecutionSteps(result) {
  return result.map((item) => ({
    order: item.order,
    timestamp: item.timestamp,
    spanId: item.spanId,
    parentSpanId: item.parentSpanId,
    spanType: item.spanType,
    name: item.name,
    status: item.status,
    outputSummary: truncate(item.outputSummary, 220),
  }));
}

function compactOverview(result) {
  return {
    sessionId: result.sessionId,
    traceIds: result.traceIds,
    spanCount: result.spanCount,
    typeCounts: result.typeCounts,
    primarySpanCount: result.primarySpanCount,
    durationMs: result.durationMs,
    integrity: result.integrity
      ? {
          result: result.integrity.result,
          counts: result.integrity.counts,
          explicitTruncationMarkersFound: result.integrity.explicitTruncationMarkersFound,
        }
      : null,
    toolNames: result.toolNames,
  };
}

function compactResult(entry) {
  if (entry.tool === "search_trace") return compactSearch(entry.result);
  if (entry.tool === "get_tool_exchange") return compactToolExchange(entry.result);
  if (entry.tool === "get_span_content") return compactSpanContent(entry.result);
  if (entry.tool === "list_tool_queries" && Array.isArray(entry.result)) return compactQueries(entry.result);
  if (entry.tool === "list_execution_steps" && Array.isArray(entry.result)) return compactExecutionSteps(entry.result);
  if (entry.tool === "get_trace_overview") return compactOverview(entry.result);
  return stripRawRefs(entry.result);
}

export class EvidenceLedger {
  constructor() {
    this.entries = [];
  }

  add({ source, tool, arguments: args, purpose, result }) {
    const evidenceId = `EV-${String(this.entries.length + 1).padStart(3, "0")}`;
    const entry = {
      evidenceId,
      source,
      tool,
      arguments: args,
      purpose,
      result,
      rawRefs: collectRawRefs(result),
    };
    this.entries.push(entry);
    return entry;
  }

  ids() {
    return new Set(this.entries.map((entry) => entry.evidenceId));
  }

  /** Reuse one immutable EV id without pretending a duplicate read is new evidence. */
  refreshExisting({ tool, arguments: args, purpose, round }) {
    const serializedArgs = JSON.stringify(args ?? {});
    const existing = [...this.entries].reverse().find(
      (entry) => entry.tool === tool && JSON.stringify(entry.arguments ?? {}) === serializedArgs,
    );
    if (!existing) return null;
    existing.lastReferencedRound = Number.isInteger(round) ? round : existing.lastReferencedRound;
    existing.referenceCount = (existing.referenceCount ?? 1) + 1;
    return {
      ...existing,
      reused: true,
      reusePurpose: purpose || `复用已验证证据 ${existing.evidenceId}`,
    };
  }

  validateCitations(report) {
    const known = this.ids();
    const cited = new Set();
    const visit = (value, key = "") => {
      if (Array.isArray(value)) {
        if (/evidence/i.test(key)) {
          for (const item of value) if (typeof item === "string") cited.add(item);
        }
        for (const item of value) visit(item, key);
      } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      }
    };
    visit(report);
    const unknown = [...cited].filter((id) => !known.has(id));
    return {
      valid: unknown.length === 0 && cited.size > 0,
      citedEvidenceIds: [...cited],
      unknownEvidenceIds: unknown,
      availableEvidenceIds: [...known],
    };
  }

  /**
   * Return a bounded navigation view for the model. Full results and raw refs
   * remain in entries and are never replaced by this derived view.
   */
  toModelContext({ maxTotalChars = 32_000, focusTerms = [] } = {}) {
    const items = this.entries.map((entry) => ({
      evidenceId: entry.evidenceId,
      source: entry.source,
      tool: entry.tool,
      purpose: entry.purpose,
      arguments: entry.arguments,
      result: compactResult(entry),
    }));
    const fullIndex = items.map(compactIndexEntry);
    const full = { totalEntries: items.length, omittedDetails: 0, evidenceIndex: fullIndex, detailedEntries: items };
    if (JSON.stringify(full).length <= maxTotalChars) return full;

    const normalizedTerms = focusTerms.map((term) => String(term).toLocaleLowerCase()).filter(Boolean);
    const priority = items.map((item, index) => {
      const text = JSON.stringify(item).toLocaleLowerCase();
      const focused = normalizedTerms.some((term) => text.includes(term));
      const mandatory = item.source === "program" || item.tool === "search_trace";
      return { item, index, score: (focused ? 1000 : 0) + (mandatory ? 300 : 0) + index };
    }).sort((left, right) => right.score - left.score);
    let evidenceIndex = fullIndex;
    let base = { totalEntries: items.length, omittedDetails: items.length, evidenceIndex, detailedEntries: [] };
    if (JSON.stringify(base).length > Math.max(1_000, maxTotalChars * 0.45)) {
      evidenceIndex = items.map(minimalIndexEntry);
      base = {
        totalEntries: items.length,
        omittedDetails: items.length,
        indexNote: "精简索引仍保留全部EV编号；详细内容按调查焦点和最近证据选择。",
        evidenceIndex,
        detailedEntries: [],
      };
    }
    const selected = [];
    for (const candidate of priority) {
      const proposed = [...selected, candidate].sort((left, right) => left.index - right.index);
      const context = {
        ...base,
        omittedDetails: items.length - proposed.length,
        detailedEntries: proposed.map((entry) => entry.item),
      };
      if (JSON.stringify(context).length <= maxTotalChars) selected.push(candidate);
    }
    selected.sort((left, right) => left.index - right.index);
    const result = {
      totalEntries: items.length,
      omittedDetails: items.length - selected.length,
      ...(base.indexNote ? { indexNote: base.indexNote } : {}),
      evidenceIndex,
      detailedEntries: selected.map((entry) => entry.item),
    };
    // An enormous ledger can make even the minimal all-ID index exceed a very
    // small caller budget. Keep every ID in a compact string list rather than
    // silently dropping citeable evidence.
    if (JSON.stringify(result).length > maxTotalChars) {
      return {
        totalEntries: items.length,
        omittedDetails: items.length,
        indexNote: "极限压缩索引；格式为EV编号:tool，完整账本保留在磁盘。",
        evidenceIndex: items.map((item) => `${item.evidenceId}:${item.tool}`),
        detailedEntries: [],
      };
    }
    return result;
  }
}
