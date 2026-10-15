import { getJsonField, getToolDefinitionAtCall, getToolCallBundle, getGenerationContract, findFieldOccurrences, checkDataInvariant } from "./field-evidence.mjs";

const TOOL_NAMES = new Set([
  "get_trace_overview",
  "list_execution_steps",
  "search_trace",
  "get_span_content",
  "get_tool_exchange",
  "list_tool_queries",
  "get_span_relations",
  "get_generation_contract",
  "get_json_field", "get_tool_definition_at_call", "get_tool_call_bundle", "find_field_origin", "trace_value_consumers", "check_data_invariant",
]);

export const TRACE_TOOL_DOCS = [
  { name: "get_trace_overview", args: {}, purpose: "读取Trace规模、类型、完整性和Tool概览" },
  { name: "list_execution_steps", args: { maxSummaryChars: 260, start: 0, limit: 20, name: "optional exact tool name", spanType: "optional TOOL|GENERATION|AGENT" }, purpose: "分页列出主执行链；用name/spanType筛选，沿nextStart继续" },
  { name: "search_trace", args: { query: "string", scope: "primary|all", fields: ["input", "output"], maxHits: "1-50" }, purpose: "对完整原始字段执行确定性精确检索" },
  { name: "get_span_content", args: { spanId: "AGENT|GENERATION|TOOL span ID", field: "input|output", start: 0, length: "1-12000" }, purpose: "读取某个主Span的指定原文区间" },
  { name: "get_tool_exchange", args: { spanId: "TOOL或Skill执行Span ID", outputStart: 0, outputLength: 7000 }, purpose: "读取真实请求参数与返回；按responseRange.endOffset设置outputStart继续翻页；GENERATION请使用get_span_content" },
  { name: "list_tool_queries", args: {}, purpose: "列出全部SQL Tool调用目标和SQL，检查分析维度覆盖" },
  { name: "get_generation_contract", args: { spanId: "GENERATION Span ID" }, purpose: "索引调用当时的指令、Skill消息、历史工具定义及显式JSON决策字段，追查规划/约束开关等上游决策" },
  { name: "get_span_relations", args: { spanId: "string" }, purpose: "查看Span父子关系" },
  { name: "get_json_field", args: { spanId: "string", field: "input|output", pointer: "/arguments/report_filters/0", decodeJsonStrings: false, start: 0, length: 8000 }, purpose: "精确读取JSON字段；字符串内嵌JSON需decodeJsonStrings=true。携带解码路径、SHA与分页范围" },
  { name: "get_tool_definition_at_call", args: { spanId: "TOOL Span ID" }, purpose: "读取生成该调用时实际注入的历史description和参数Schema；不使用当前文档代替" },
  { name: "get_tool_call_bundle", args: { spanId: "TOOL Span ID" }, purpose: "按call_id关联模型原始调用、记录参数、历史定义和后续模型接收的Tool消息" },
  { name: "find_field_origin", args: { spanId: "string", field: "input|output", pointer: "RFC6901 pointer" }, purpose: "检索字段上游来源候选；同值和时间关系不证明因果" },
  { name: "trace_value_consumers", args: { spanId: "string", field: "input|output", pointer: "RFC6901 pointer" }, purpose: "检索字段后续消费候选，需进一步证明数据依赖" },
  { name: "check_data_invariant", args: { kind: "equal|numeric_equal|sum_equals", left: { spanId: "string", field: "input|output", pointer: "string" }, right: { spanId: "string", field: "input|output", pointer: "string" }, tolerance: 0 }, purpose: "只对记录字段进行确定性比较/求和，不重执行业务工具，也不自动证明因果" },
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
    case "get_json_field": return getJsonField(repository, normalized.arguments);
    case "get_tool_definition_at_call": return getToolDefinitionAtCall(repository, normalized.arguments);
    case "get_generation_contract": return getGenerationContract(repository, normalized.arguments);
    case "get_tool_call_bundle": return getToolCallBundle(repository, normalized.arguments);
    case "find_field_origin": return findFieldOccurrences(repository, { ...normalized.arguments, direction: "origins" });
    case "trace_value_consumers": return findFieldOccurrences(repository, { ...normalized.arguments, direction: "consumers" });
    case "check_data_invariant": return checkDataInvariant(repository, normalized.arguments);
    case "get_trace_overview":
      return repository.getOverview();
    case "list_execution_steps":
      {
        const args = normalized.arguments;
        const all = repository.listExecutionSteps({ maxSummaryChars: Math.min(800, Math.max(100, Number(args.maxSummaryChars) || 260)) })
          .filter((step) => (!args.name || step.name === args.name) && (!args.spanType || step.spanType === args.spanType));
        const start = Math.max(0, Number.parseInt(args.start, 10) || 0), limit = Math.min(40, Math.max(1, Number(args.limit) || 20));
        return { total: all.length, start, nextStart: start + limit < all.length ? start + limit : null, steps: all.slice(start, start + limit) };
      }
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
