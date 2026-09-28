const TOOL_NAMES = new Set([
  "get_trace_overview",
  "list_execution_steps",
  "search_trace",
  "get_span_content",
  "get_tool_exchange",
  "list_tool_queries",
  "get_span_relations",
]);

export const TRACE_TOOL_DOCS = [
  { name: "get_trace_overview", args: {}, purpose: "读取Trace规模、类型、完整性和Tool概览" },
  { name: "list_execution_steps", args: { maxSummaryChars: "100-800" }, purpose: "按时间列出AGENT/GENERATION/TOOL主执行链" },
  { name: "search_trace", args: { query: "string", scope: "primary|all", fields: ["input", "output"], maxHits: "1-50" }, purpose: "对完整原始字段执行确定性精确检索" },
  { name: "get_span_content", args: { spanId: "AGENT|GENERATION|TOOL span ID", field: "input|output", start: 0, length: "1-12000" }, purpose: "读取某个主Span的指定原文区间" },
  { name: "get_tool_exchange", args: { spanId: "TOOL span ID only", outputLength: "1-12000" }, purpose: "只读取TOOL类型Span的请求参数与返回；GENERATION请使用get_span_content" },
  { name: "list_tool_queries", args: {}, purpose: "列出全部SQL Tool调用目标和SQL，检查分析维度覆盖" },
  { name: "get_span_relations", args: { spanId: "string" }, purpose: "查看Span父子关系" },
];

export function normalizeAction(action) {
  const tool = action?.tool;
  if (!TOOL_NAMES.has(tool)) throw new Error(`Unknown or disallowed Trace tool: ${tool}`);
  return {
    tool,
    arguments: action.arguments && typeof action.arguments === "object" ? action.arguments : {},
    purpose: typeof action.purpose === "string" ? action.purpose : "",
  };
}

export async function executeTraceTool(repository, action) {
  const normalized = normalizeAction(action);
  switch (normalized.tool) {
    case "get_trace_overview":
      return repository.getOverview();
    case "list_execution_steps":
      return repository.listExecutionSteps(normalized.arguments);
    case "search_trace":
      return repository.search(normalized.arguments);
    case "get_span_content":
      return repository.getSpanContent(normalized.arguments);
    case "get_tool_exchange":
      return repository.getToolExchange(normalized.arguments);
    case "list_tool_queries":
      return repository.listToolQueries();
    case "get_span_relations":
      return repository.getRelations(normalized.arguments);
    default:
      throw new Error(`Unhandled Trace tool: ${normalized.tool}`);
  }
}
