import { readFile } from "node:fs/promises";
import path from "node:path";

export function parseArgs(argv, { valueOptions = [], booleanOptions = [] } = {}) {
  const values = new Set(valueOptions);
  const booleans = new Set(booleanOptions);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unknown positional argument: ${arg}`);
    const name = arg.slice(2);
    if (booleans.has(name)) result[name] = true;
    else if (values.has(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      result[name] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

export function positiveInteger(value, fallback, name, { allowZero = false } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

export function commonOptions(args) {
  const mode = args.mode || "live";
  if (!new Set(["live", "offline"]).has(mode)) throw new Error("--mode must be live or offline");
  return {
    workflowOutputRoot: path.resolve(args["workflow-output-root"] || "outputs/trace-rca-workflows"),
    traceOutputRoot: path.resolve(args["trace-output-root"] || "data/raw/sophon-sessions"),
    mode,
    maxRounds: positiveInteger(args["max-rounds"], 8, "max-rounds"),
    forceIngestion: Boolean(args["force-ingestion"]),
    allowContentMismatch: Boolean(args["allow-content-mismatch"]),
    ingestion: {
      tenant: args.tenant || "data",
      agentType: args["agent-type"] || "ida",
      region: args.region,
      userEmail: args["user-email"] || process.env.SOPHON_INGESTION_USER_EMAIL || process.env.SOPHON_OPERATOR_EMAIL,
      pageSize: positiveInteger(args["page-size"], 200, "page-size"),
      paddingMs: positiveInteger(args["padding-ms"], 300_000, "padding-ms", { allowZero: true }),
      timeoutMs: positiveInteger(args["timeout-ms"], 120_000, "timeout-ms"),
      retries: positiveInteger(args.retries, 2, "retries", { allowZero: true }),
    },
  };
}

export const COMMON_VALUE_OPTIONS = [
  "workflow-output-root", "trace-output-root", "mode", "max-rounds", "retry-plan",
  "tenant", "agent-type", "region", "user-email", "page-size",
  "padding-ms", "timeout-ms", "retries",
];

export const COMMON_BOOLEAN_OPTIONS = ["force-ingestion", "allow-content-mismatch", "help"];

export async function readTextOption(args, name, { required = true } = {}) {
  const inline = args[name];
  const file = args[`${name}-file`];
  if (inline !== undefined && file !== undefined) throw new Error(`Use only --${name} or --${name}-file`);
  if (file !== undefined) return readFile(path.resolve(file), "utf8");
  if (inline !== undefined) return inline;
  if (required) throw new Error(`--${name} or --${name}-file is required`);
  return undefined;
}

export function printWorkflowResult(result) {
  console.log(`Workflow status: ${result.status}`);
  console.log(`Workflow output: ${result.outputDir}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Completed: ${result.counts.completed}; failed: ${result.counts.failed}; skipped: ${result.counts.skipped}`);
}

export async function loadRetryPlan(args) {
  if (!args["retry-plan"]) return {};
  const planPath = path.resolve(args["retry-plan"]);
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid retry plan: ${error.message}`);
  }
  const scope = plan?.lineage?.scope;
  if (scope && !["failed_only", "full"].includes(scope)) throw new Error("Retry plan scope must be failed_only or full");
  if (scope === "failed_only" && (!Array.isArray(plan.retrySelection) || !plan.retrySelection.length)) {
    throw new Error("failed_only retry plan requires retrySelection");
  }
  return {
    retrySelection: scope === "failed_only" ? plan.retrySelection : undefined,
    lineage: plan.lineage,
  };
}
