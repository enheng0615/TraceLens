import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PRIMARY_TYPES = new Set(["AGENT", "GENERATION", "TOOL"]);
const MAX_CONTENT_CHARS = 12_000;

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|access_token|jwt)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/([\"']?(?:api[-_]?key|authorization|token|jwt)[\"']?\s*[:=]\s*[\"'])[^\"']+([\"'])/gi, "$1<redacted>$2")
    .replace(/[A-Z0-9._%+-]+@(?:bytedance|byteintl)\.com/gi, "<redacted-email>");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function assistantContent(output) {
  const parsed = parseJson(output);
  if (!parsed) return String(output ?? "");
  if (typeof parsed.content === "string") return parsed.content;
  if (typeof parsed.output === "string") return parsed.output;
  return String(output ?? "");
}

function compactText(value, maxChars = 360) {
  const text = redact(value).replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function walkTree(node, parentId = null, depth = 0, result = new Map()) {
  result.set(node.id, { parentId, depth });
  for (const child of node.childs ?? []) {
    walkTree(child, node.id, depth + 1, result);
  }
  return result;
}

function normalizeScope(scope) {
  if (!scope || scope === "primary") return (span) => PRIMARY_TYPES.has(span.spanType);
  if (scope === "all") return () => true;
  if (Array.isArray(scope)) {
    const allowed = new Set(scope.map((item) => String(item).toUpperCase()));
    return (span) => allowed.has(span.spanType);
  }
  throw new Error(`Unsupported search scope: ${scope}`);
}

function evidenceRef(span, field, start, end) {
  const content = String(span[field] ?? "");
  return {
    traceId: span.traceId,
    spanId: span.id,
    spanType: span.spanType,
    spanName: span.name,
    field,
    startOffset: start,
    endOffset: end,
    contentSha256: sha256(content),
    rawPath: span.rawPath,
    jsonPath: `$.data.${field}`,
  };
}

export class TraceRepository {
  constructor({ root, spans, relations, manifest, integrity }) {
    this.root = root;
    this.spans = spans.sort((a, b) => a.startTime - b.startTime);
    this.byId = new Map(this.spans.map((span) => [span.id, span]));
    this.relations = relations;
    this.manifest = manifest;
    this.integrity = integrity;
  }

  static async open(root) {
    const resolved = path.resolve(root);
    const detailDir = path.join(resolved, "spans", "details");
    const files = (await readdir(detailDir)).filter((file) => file.endsWith(".json")).sort();
    const expandedBySpanId = new Map();
    const expandedDir = path.join(resolved, "expanded-tool-results");
    try {
      for (const file of (await readdir(expandedDir)).filter((name) => name.endsWith(".json")).sort()) {
        const expandedPath = path.join(expandedDir, file);
        const artifact = JSON.parse(await readFile(expandedPath, "utf8"));
        if (artifact?.spanId && typeof artifact?.data?.output === "string") {
          expandedBySpanId.set(String(artifact.spanId), { output: artifact.data.output, rawPath: expandedPath });
        }
      }
    } catch {}
    const spans = [];
    for (const file of files) {
      const wrapper = JSON.parse(await readFile(path.join(detailDir, file), "utf8"));
      const data = wrapper.data;
      if (!data?.id) throw new Error(`Invalid span detail: ${file}`);
      const expanded = expandedBySpanId.get(String(data.id));
      spans.push({
        ...data,
        ...(expanded ? { output: expanded.output, expandedToolResult: true } : {}),
        rawPath: expanded?.rawPath ?? path.join(detailDir, file),
      });
    }

    const treeDir = path.join(resolved, "traces", "trees");
    const treeFiles = (await readdir(treeDir)).filter((file) => file.endsWith(".json")).sort();
    const relations = new Map();
    for (const file of treeFiles) {
      const wrapper = JSON.parse(await readFile(path.join(treeDir, file), "utf8"));
      walkTree(wrapper.data, null, 0, relations);
    }

    const readOptional = async (name) => {
      try {
        return JSON.parse(await readFile(path.join(resolved, name), "utf8"));
      } catch {
        return null;
      }
    };
    return new TraceRepository({
      root: resolved,
      spans,
      relations,
      manifest: await readOptional("manifest.json"),
      integrity: (await readOptional("integrity-report.json")) ?? (await readOptional("integrity-audit.json")),
    });
  }

  getOverview() {
    const typeCounts = {};
    const nameCounts = {};
    for (const span of this.spans) {
      typeCounts[span.spanType] = (typeCounts[span.spanType] ?? 0) + 1;
      nameCounts[span.name] = (nameCounts[span.name] ?? 0) + 1;
    }
    const first = this.spans.at(0);
    const last = this.spans.at(-1);
    const minStart = Math.min(...this.spans.map((span) => span.startTime));
    const maxEnd = Math.max(...this.spans.map((span) => span.endTime));
    return {
      sessionId: first?.sessionId,
      traceIds: [...new Set(this.spans.map((span) => span.traceId))],
      spanCount: this.spans.length,
      typeCounts,
      primarySpanCount: this.spans.filter((span) => PRIMARY_TYPES.has(span.spanType)).length,
      startTime: Number.isFinite(minStart) ? minStart : first?.startTime,
      endTime: Number.isFinite(maxEnd) ? maxEnd : last?.endTime,
      durationMs: Number.isFinite(minStart) && Number.isFinite(maxEnd) ? maxEnd - minStart : null,
      largestInputs: [...this.spans]
        .sort((a, b) => String(b.input ?? "").length - String(a.input ?? "").length)
        .slice(0, 5)
        .map((span) => ({ spanId: span.id, chars: String(span.input ?? "").length })),
      largestOutputs: [...this.spans]
        .sort((a, b) => String(b.output ?? "").length - String(a.output ?? "").length)
        .slice(0, 5)
        .map((span) => ({ spanId: span.id, chars: String(span.output ?? "").length })),
      integrity: this.integrity
        ? {
            result: this.integrity.result,
            counts: this.integrity.counts,
            explicitTruncationMarkersFound:
              this.integrity.payloads?.explicitTruncationMarkersFound,
            scopeNote: this.integrity.scopeNote,
          }
        : null,
      toolNames: Object.entries(nameCounts)
        .filter(([name]) => this.spans.some((span) => span.spanType === "TOOL" && span.name === name))
        .map(([name, count]) => ({ name, count })),
    };
  }

  listExecutionSteps({ maxSummaryChars = 360 } = {}) {
    return this.spans
      .filter((span) => PRIMARY_TYPES.has(span.spanType))
      .map((span, index) => {
        const relation = this.relations.get(span.id) ?? {};
        return {
          order: index + 1,
          timestamp: span.startTime,
          spanId: span.id,
          parentSpanId: relation.parentId ?? null,
          depth: relation.depth ?? null,
          spanType: span.spanType,
          name: span.name,
          status: span.status,
          durationMs: span.costTime,
          inputChars: String(span.input ?? "").length,
          outputChars: String(span.output ?? "").length,
          outputSummary: compactText(assistantContent(span.output), maxSummaryChars),
          evidenceRef: evidenceRef(span, "output", 0, String(span.output ?? "").length),
        };
      });
  }

  search({ query, scope = "primary", fields = ["input", "output"], maxHits = 30, contextChars = 180 }) {
    if (!query || typeof query !== "string") throw new Error("search_trace requires a non-empty query");
    const filter = normalizeScope(scope);
    const needle = query.toLocaleLowerCase();
    const hits = [];
    const corpusFingerprint = createHash("sha256");
    let searchedSpans = 0;
    let searchedFields = 0;
    let searchedChars = 0;
    for (const span of this.spans) {
      if (!filter(span)) continue;
      searchedSpans += 1;
      for (const field of fields) {
        if (!new Set(["input", "output"]).has(field)) throw new Error(`Unsupported search field: ${field}`);
        const content = String(span[field] ?? "");
        corpusFingerprint.update(`${span.id}\0${field}\0${sha256(content)}\n`);
        searchedFields += 1;
        searchedChars += content.length;
        const lower = content.toLocaleLowerCase();
        let cursor = 0;
        while (cursor <= lower.length) {
          const index = lower.indexOf(needle, cursor);
          if (index === -1) break;
          if (hits.length < maxHits) {
            const start = Math.max(0, index - contextChars);
            const end = Math.min(content.length, index + query.length + contextChars);
            hits.push({
              ...evidenceRef(span, field, index, index + query.length),
              excerptStartOffset: start,
              excerptEndOffset: end,
              excerpt: redact(content.slice(start, end)),
            });
          }
          cursor = index + Math.max(query.length, 1);
        }
      }
    }
    const unresolved = new Set((this.integrity?.expandedToolResults?.unresolvedSpanIds ?? []).map(String));
    const recoveryBySpan = new Map(
      (this.integrity?.expandedToolResults?.attempts ?? []).map((attempt) => [String(attempt.spanId), {
        status: attempt.status ?? "unknown",
        code: attempt.code ?? null,
        message: attempt.message ?? null,
      }]),
    );
    const unknownSegments = this.spans
      .filter((span) => unresolved.has(String(span.id)) && filter(span))
      .flatMap((span) => fields.includes("output") ? [{
        kind: "truncated_tool_result",
        spanId: span.id,
        spanType: span.spanType,
        toolName: span.name,
        field: "output",
        observedChars: String(span.output ?? "").length,
        recovery: recoveryBySpan.get(String(span.id)) ?? null,
      }] : []);
    return {
      query,
      exactCaseInsensitive: true,
      scope,
      fields,
      coverage: {
        searchedSpans,
        searchedFields,
        searchedChars,
        complete: true,
        visibleCorpusComplete: true,
        negativeEvidenceEligible: unknownSegments.length === 0,
        unknownSegments,
        corpusSha256: corpusFingerprint.digest("hex"),
      },
      totalMatches: this.countMatches({ query, filter, fields }),
      returnedHits: hits.length,
      hits,
    };
  }

  countMatches({ query, filter, fields }) {
    const needle = query.toLocaleLowerCase();
    let count = 0;
    for (const span of this.spans) {
      if (!filter(span)) continue;
      for (const field of fields) {
        const lower = String(span[field] ?? "").toLocaleLowerCase();
        let cursor = 0;
        while (cursor <= lower.length) {
          const index = lower.indexOf(needle, cursor);
          if (index === -1) break;
          count += 1;
          cursor = index + Math.max(needle.length, 1);
        }
      }
    }
    return count;
  }

  getSpanContent({ spanId, field = "output", start = 0, length = 6000 }) {
    const span = this.byId.get(spanId);
    if (!span) throw new Error(`Unknown spanId: ${spanId}`);
    if (!PRIMARY_TYPES.has(span.spanType)) {
      throw new Error("Direct content reading is limited to AGENT/GENERATION/TOOL spans in this test version");
    }
    if (!new Set(["input", "output"]).has(field)) throw new Error(`Unsupported field: ${field}`);
    const content = String(span[field] ?? "");
    const safeStart = Math.max(0, Number.parseInt(start, 10) || 0);
    const safeLength = Math.min(MAX_CONTENT_CHARS, Math.max(1, Number.parseInt(length, 10) || 6000));
    const end = Math.min(content.length, safeStart + safeLength);
    return {
      span: {
        spanId: span.id,
        traceId: span.traceId,
        spanType: span.spanType,
        name: span.name,
        timestamp: span.startTime,
        status: span.status,
      },
      field,
      range: { startOffset: safeStart, endOffset: end, totalChars: content.length },
      truncatedBefore: safeStart > 0,
      truncatedAfter: end < content.length,
      content: redact(content.slice(safeStart, end)),
      evidenceRef: evidenceRef(span, field, safeStart, end),
    };
  }

  getToolExchange({ spanId, outputLength = 7000 }) {
    const span = this.byId.get(spanId);
    if (!span || span.spanType !== "TOOL") throw new Error(`Not a TOOL span: ${spanId}`);
    const parsedInput = parseJson(span.input);
    const content = String(span.output ?? "");
    const end = Math.min(content.length, Math.min(MAX_CONTENT_CHARS, outputLength));
    return {
      spanId: span.id,
      traceId: span.traceId,
      name: span.name,
      timestamp: span.startTime,
      status: span.status,
      durationMs: span.costTime,
      request: parsedInput ? JSON.parse(redact(JSON.stringify(parsedInput))) : redact(span.input),
      response: redact(content.slice(0, end)),
      responseTruncated: end < content.length,
      requestEvidenceRef: evidenceRef(span, "input", 0, String(span.input ?? "").length),
      responseEvidenceRef: evidenceRef(span, "output", 0, end),
    };
  }

  listToolQueries() {
    return this.spans
      .filter((span) => span.spanType === "TOOL" && span.name === "aeolus_sql_query")
      .map((span) => {
        const request = parseJson(span.input);
        const args = request?.arguments ?? {};
        return {
          spanId: span.id,
          timestamp: span.startTime,
          goal: redact(args.goal),
          instruction: redact(args.instruction),
          sql: redact(args.ansi_sql),
          outputFilePrefix: redact(args.output_file_prefix),
          requestEvidenceRef: evidenceRef(span, "input", 0, String(span.input ?? "").length),
        };
      });
  }

  getRelations({ spanId }) {
    const span = this.byId.get(spanId);
    if (!span) throw new Error(`Unknown spanId: ${spanId}`);
    const relation = this.relations.get(spanId) ?? {};
    const children = [...this.relations.entries()]
      .filter(([, value]) => value.parentId === spanId)
      .map(([id]) => this.byId.get(id))
      .filter(Boolean)
      .map((child) => ({ spanId: child.id, spanType: child.spanType, name: child.name, timestamp: child.startTime }));
    const parent = relation.parentId ? this.byId.get(relation.parentId) : null;
    return {
      spanId,
      parent: parent ? { spanId: parent.id, spanType: parent.spanType, name: parent.name } : null,
      children,
    };
  }

  findPrimary({ spanType, name }) {
    return this.spans.filter(
      (span) => (!spanType || span.spanType === spanType) && (!name || span.name === name),
    );
  }
}

export const traceText = { redact, sha256, assistantContent, compactText };
