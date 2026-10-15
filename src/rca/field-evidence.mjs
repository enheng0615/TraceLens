import { traceText } from "./trace-repository.mjs";

function parsed(value) { try { return JSON.parse(value); } catch { return null; } }
export function resolvePointer(value, pointer = "", { decodeJsonStrings = false, operations = [] } = {}) {
  if (typeof pointer !== "string" || (pointer && !pointer.startsWith("/"))) throw new Error("Expected an RFC6901 JSON Pointer");
  const consumed = [];
  for (const token of pointer ? pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")) : []) {
    if (decodeJsonStrings && typeof value === "string") {
      value = parsed(value);
      operations.push({ format: "JSON.parse", atPointer: `/${consumed.map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` });
    }
    if (!value || typeof value !== "object" || !Object.hasOwn(value, token)) throw new Error(`JSON field does not exist: ${pointer}`);
    value = value[token];
    consumed.push(token);
  }
  return value;
}

export function getJsonField(repository, { spanId, field = "input", pointer = "", decodeJsonStrings = false, start = 0, length = 8000 }) {
  const span = repository.byId.get(spanId);
  if (!span || !["input", "output"].includes(field)) throw new Error("Unknown Span or invalid field");
  const raw = String(span[field] ?? "");
  const value = parsed(raw);
  if (value === null && raw.trim() !== "null") throw new Error("Span field is not parseable JSON; use get_span_content");
  const operations = [{ format: "JSON.parse", atPointer: "" }];
  const selected = resolvePointer(value, pointer, { decodeJsonStrings, operations });
  const serialized = JSON.stringify(selected);
  const from = Math.min(serialized.length, Math.max(0, Number.parseInt(start, 10) || 0));
  const to = Math.min(serialized.length, from + Math.min(12000, Math.max(1, Number(length) || 8000)));
  return {
    spanId, field, pointer,
    value: from === 0 && to === serialized.length ? JSON.parse(traceText.redact(serialized)) : undefined,
    content: traceText.redact(serialized.slice(from, to)),
    range: { startOffset: from, endOffset: to, totalChars: serialized.length },
    truncated: from > 0 || to < serialized.length,
    fieldSha256: traceText.sha256(serialized),
    evidenceRef: { spanId, traceId: span.traceId, field, startOffset: 0, endOffset: raw.length,
      contentSha256: traceText.sha256(raw), rawPath: field === "output" ? span.outputRawPath ?? span.rawPath : span.rawPath,
      jsonPath: `$.data.${field}`, decoding: operations, pointer, decodeJsonStrings },
  };
}

function locateCall(repository, spanId) {
  const tool = repository.byId.get(spanId);
  if (!tool || tool.spanType !== "TOOL") throw new Error("Call bundle requires a TOOL Span");
  const request = parsed(tool.input);
  const callId = request?.call_id ?? request?.tool_call_id;
  const matches = [];
  if (callId) for (const generation of repository.spans.filter((s) => s.spanType === "GENERATION" && s.startTime <= tool.startTime && s.traceId === tool.traceId)) {
    const out = parsed(generation.output);
    for (const [index, call] of (out?.tool_calls ?? []).entries()) {
      if (call.id === callId && call.function?.name === tool.name) matches.push({ generation, call, index });
    }
  }
  return { tool, request, callId, matches };
}

export function getToolDefinitionAtCall(repository, { spanId }) {
  const { tool, callId, matches } = locateCall(repository, spanId);
  if (matches.length !== 1) return { spanId, callId, status: matches.length ? "ambiguous" : "unobservable", reason: "Unique original Generation tool_call was not found" };
  const { generation } = matches[0];
  const input = parsed(generation.input);
  const definitions = (input?.tools ?? []).map((item, index) => ({ item: item.function ?? item, index, wrapped: Boolean(item.function) }))
    .filter(({ item }) => item.name === tool.name);
  if (definitions.length !== 1) return { spanId, callId, generationSpanId: generation.id, status: definitions.length ? "ambiguous" : "unobservable", reason: "Historical tool definition is unavailable or duplicated" };
  const { index, wrapped } = definitions[0];
  return { spanId, callId, generationSpanId: generation.id, status: "observed", definition:
    getJsonField(repository, { spanId: generation.id, field: "input", pointer: `/tools/${index}${wrapped ? "/function" : ""}`, length: 12000 }) };
}

export function getToolCallBundle(repository, { spanId }) {
  const { tool, callId, matches } = locateCall(repository, spanId);
  const emitted = matches.length === 1 ? getJsonField(repository, {
    spanId: matches[0].generation.id, field: "output", pointer: `/tool_calls/${matches[0].index}`, length: 12000,
  }) : null;
  const consumers = [];
  if (callId) for (const generation of repository.spans.filter((s) => s.spanType === "GENERATION" && s.traceId === tool.traceId && s.startTime >= tool.startTime)) {
    const input = parsed(generation.input);
    for (const [index, message] of (input?.messages ?? []).entries()) {
      if (message.role === "tool" && (message.tool_call_id ?? message.call_id) === callId) {
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        consumers.push({ generationSpanId: generation.id, pointer: `/messages/${index}`, callId,
          relation: "result_message_bound_by_call_id", bodyEqualsRawReturn: content === String(tool.output ?? ""),
          message: getJsonField(repository, { spanId: generation.id, field: "input", pointer: `/messages/${index}`, length: 12000 }) });
      }
    }
  }
  return { spanId, callId, status: matches.length === 1 ? "call_linked" : matches.length ? "ambiguous" : "unobservable",
    emittedCall: emitted, recordedRequest: getJsonField(repository, { spanId, field: "input", length: 12000 }),
    historicalDefinition: getToolDefinitionAtCall(repository, { spanId }),
    response: { totalChars: String(tool.output ?? "").length, reader: { tool: "get_json_field", arguments: { spanId, field: "output", pointer: "" } } },
    consumers: consumers.slice(0, 8), totalConsumers: consumers.length,
    unavailableLayers: ["effective_backend_parameters", "backend_implementation", "historical_artifact_version_unless_recorded"],
    note: "Call ID proves association; equality/embedding and field consumption require separate checks. Unrecorded layers remain unknown.",
  };
}

/** Recorded occurrences only; matching values do not prove data dependence. */
export function findFieldOccurrences(repository, { spanId, field = "output", pointer, direction = "consumers", maxHits = 20 }) {
  if (!["origins", "consumers"].includes(direction)) throw new Error("Invalid field relation direction");
  const source = repository.byId.get(spanId);
  const selected = getJsonField(repository, { spanId, field, pointer, length: 12000 });
  if (selected.truncated || typeof selected.value === "object" || String(selected.value).length < 2) throw new Error("Field relation search requires a complete scalar with at least 2 characters");
  const query = String(selected.value);
  const matches = repository.search({ query, scope: "all", fields: ["input", "output"], maxHits: 50 });
  const eligible = matches.hits.filter((hit) => hit.spanId !== spanId && (direction === "origins"
    ? repository.byId.get(hit.spanId).startTime <= source.startTime
    : repository.byId.get(hit.spanId).startTime >= source.startTime));
  return { source: selected, direction, relationStatus: "candidate_occurrence_only", totalMatches: matches.totalMatches,
    hits: eligible.slice(0, Math.min(50, Math.max(1, Number(maxHits) || 20))),
    warning: "Temporal/lexical matches do not establish origin or consumption; use call IDs, exact file versions or explicit code mapping." };
}

export function getGenerationContract(repository, { spanId }) {
  const span = repository.byId.get(spanId);
  if (!span || span.spanType !== "GENERATION") throw new Error("Expected a GENERATION Span");
  const input = parsed(span.input), output = parsed(span.output), decision = parsed(output?.content);
  return { spanId, inputStructure: input ? Object.keys(input) : [],
    messages: (input?.messages ?? []).map((message, index) => ({ index, role: message.role, contentChars: JSON.stringify(message.content ?? "").length, pointer: `/messages/${index}` })),
    toolDefinitions: (input?.tools ?? []).map((item, index) => ({ name: (item.function ?? item).name, pointer: `/tools/${index}${item.function ? "/function" : ""}` })),
    decisionFields: decision && typeof decision === "object" ? Object.keys(decision).map((key) => ({ key, pointer: `/content/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, decodeJsonStrings: true })) : [],
    source: getJsonField(repository, { spanId, field: "input", pointer: "", length: 1 }),
    instruction: "Use get_json_field on a listed pointer to inspect exact instructions or explicit decision fields; this index does not prove understanding or causality." };
}

export function checkDataInvariant(repository, { kind, left, right, tolerance = 0 }) {
  if (!["equal", "numeric_equal", "sum_equals"].includes(kind)) throw new Error("Unsupported deterministic invariant");
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Invalid tolerance");
  const lhs = getJsonField(repository, { ...left, length: 12000 });
  const rhs = getJsonField(repository, { ...right, length: 12000 });
  if (lhs.truncated || rhs.truncated) throw new Error("Invariant requires complete fields");
  let observed;
  if (kind === "equal") observed = JSON.stringify(lhs.value) === JSON.stringify(rhs.value);
  else {
    const values = kind === "sum_equals" ? lhs.value : [lhs.value];
    if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "number" || !Number.isFinite(v)) || typeof rhs.value !== "number" || !Number.isFinite(rhs.value)) throw new Error("Invariant requires finite numeric values");
    observed = Math.abs(values.reduce((a, b) => a + b, 0) - rhs.value) <= tolerance;
  }
  return { kind, passed: observed, left: lhs, right: rhs, tolerance, verificationKind: "deterministic_field_comparison",
    causalIntervention: false, note: "Checks recorded fields only, does not execute business tools or prove causality." };
}
