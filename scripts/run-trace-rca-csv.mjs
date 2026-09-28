#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runCsvTraceRcaWorkflow } from "../src/workflows/trace-rca/index.mjs";
import {
  COMMON_BOOLEAN_OPTIONS,
  COMMON_VALUE_OPTIONS,
  commonOptions,
  parseArgs,
  printWorkflowResult,
  loadRetryPlan,
} from "./workflow-cli-common.mjs";

const usage = `Usage:
  npm run workflow:csv -- --csv <file.csv> [options]

CSV default columns:
  问题, gt_attribution, ida_结论报告评分, ida_decompressed_data, ida_url, ida_答案

Options:
  --trace-output-root <dir>       Trace cache/output root (default data/raw/sophon-sessions)
  --workflow-output-root <dir>    Workflow results (default outputs/trace-rca-workflows)
  --max-rounds <n>                RCA investigation limit (default 8)
  --concurrency <n>               Concurrent Sessions (default 3, max 16)
  --retry-plan <file>             Web生成的追加式复跑计划
  --mode live|offline             live is required for real attribution
  --fail-fast                     Stop at the first failed row/GT
  --force-ingestion               Re-fetch every Session Trace
  --allow-content-mismatch        Bypass CSV/Trace query-answer equality check (not recommended)
  --tenant/--agent-type/--region/--user-email
  --page-size/--padding-ms/--timeout-ms/--retries
`;

try {
  const args = parseArgs(process.argv.slice(2), {
    valueOptions: ["csv", "concurrency", ...COMMON_VALUE_OPTIONS],
    booleanOptions: ["fail-fast", ...COMMON_BOOLEAN_OPTIONS],
  });
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  if (!args.csv) throw new Error("--csv is required");
  const retry = await loadRetryPlan(args);
  const concurrency = args.concurrency === undefined ? (args["fail-fast"] ? 1 : 3) : Number.parseInt(args.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be an integer between 1 and 16");
  }
  if (args["fail-fast"] && concurrency > 1) {
    throw new Error("--fail-fast requires --concurrency 1");
  }
  const result = await runCsvTraceRcaWorkflow({
    csvPath: path.resolve(args.csv),
    continueOnError: !args["fail-fast"],
    concurrency,
    ...commonOptions(args),
    ...retry,
  });
  printWorkflowResult(result);
  if (result.counts.failed > 0) process.exitCode = 2;
} catch (error) {
  console.error(`CSV Trace RCA workflow failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}
