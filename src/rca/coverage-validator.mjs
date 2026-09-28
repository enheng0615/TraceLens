import { findFactGroupEvidence } from "./fact-evidence.mjs";

function lower(value) {
  return String(value ?? "").toLocaleLowerCase();
}

function legacyEntryText(entry) {
  return lower(JSON.stringify({ arguments: entry.arguments, result: entry.result }));
}

function finalGenerationId(executionSteps = []) {
  return [...executionSteps].reverse().find((step) => step.spanType === "GENERATION")?.spanId;
}

/** Evaluate the declarative, case-specific minimum investigation contract. */
export function evaluateInvestigationCoverage(ledger, { policy, executionSteps = [] } = {}) {
  if (!policy) throw new Error("investigation coverage requires a case investigationPolicy");
  const entries = ledger.entries;
  const searches = entries.filter((entry) => entry.tool === "search_trace");
  const exchanges = entries.filter((entry) => entry.tool === "get_tool_exchange");
  const hasSearch = (text, scope) => searches.some(
    (entry) => lower(entry.arguments?.query) === lower(text) && (!scope || entry.arguments?.scope === scope),
  );
  const hasLegacyFactChainEvidence = (text) =>
    searches.some((entry) => lower(entry.arguments?.query) === lower(text)) ||
    entries.some((entry) => ["get_span_content", "get_tool_exchange"].includes(entry.tool) && legacyEntryText(entry).includes(lower(text)));

  const checks = [];
  if (policy.requireToolInventory) {
    checks.push([entries.some((entry) => entry.tool === "get_trace_overview" && Array.isArray(entry.result?.toolNames)), "读取Trace Tool清单，按实际执行环境规划调查"]);
  }
  if (policy.requireToolQueryInventory) {
    checks.push([entries.some((entry) => entry.tool === "list_tool_queries"), "列出全部结构化查询，确认分析维度覆盖"]);
  }
  for (const query of policy.allTraceSearches ?? []) {
    checks.push([hasSearch(query, "all"), `在全部原始Span中确定性搜索：${query}`]);
  }
  if ((policy.factEvidenceGroups ?? []).length) {
    for (const group of policy.factEvidenceGroups) {
      const evidence = findFactGroupEvidence(entries, group);
      checks.push([
        evidence.length > 0,
        `定位实际答案事实组：${group.anchors.join(" + ")}`,
        { factGroupId: group.id, sourceQuote: group.sourceQuote, anchors: group.anchors, evidenceIds: evidence.map((item) => item.evidenceId) },
      ]);
    }
  } else {
    // Backward compatibility for explicit policies and old checkpoints.
    for (const term of policy.factChainTerms ?? []) {
      checks.push([hasLegacyFactChainEvidence(term), `定位实际答案事实链：${term}`]);
    }
  }
  for (const name of policy.schemaToolNames ?? []) {
    checks.push([exchanges.some((entry) => entry.result?.name === name), `读取Schema/元数据Tool交换：${name}`]);
  }
  for (const name of policy.executionToolNames ?? []) {
    checks.push([exchanges.some((entry) => entry.result?.name === name), `读取关键执行Tool交换：${name}`]);
  }
  if (policy.requireAnyExecutionTool) {
    checks.push([exchanges.some((entry) => (policy.executionToolCandidates ?? []).includes(entry.result?.name)), `读取至少一个实际分析Tool交换：${(policy.executionToolCandidates ?? []).join(" / ")}`]);
  }
  for (const spanId of policy.requiredToolSpanIds ?? []) {
    checks.push([exchanges.some((entry) => entry.result?.spanId === spanId), `读取指定关键Tool交换：${spanId}`]);
  }
  for (const spanId of policy.artifactToolSpanIds ?? []) {
    checks.push([exchanges.some((entry) => entry.result?.spanId === spanId), `读取答案产物链Tool交换：${spanId}`]);
  }
  if (policy.requireFinalGenerationOutput) {
    const expected = finalGenerationId(executionSteps);
    checks.push([
      entries.some((entry) => entry.tool === "get_span_content" && entry.result?.span?.spanType === "GENERATION" && entry.result?.field === "output" && (!expected || entry.result.span.spanId === expected)),
      expected ? `读取最终Generation原始输出：${expected}` : "读取最终Generation原始输出",
    ]);
  }

  const missing = checks.filter(([ok]) => !ok).map(([, description]) => description);
  return {
    complete: missing.length === 0,
    policy,
    checks: checks.map(([ok, description, details]) => ({ ok, description, ...(details ? { details } : {}) })),
    missing,
  };
}
