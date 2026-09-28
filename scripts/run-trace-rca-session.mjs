#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runSingleSessionTraceRcaWorkflow } from "../src/workflows/trace-rca/index.mjs";
import {
  COMMON_BOOLEAN_OPTIONS,
  COMMON_VALUE_OPTIONS,
  commonOptions,
  parseArgs,
  printWorkflowResult,
  loadRetryPlan,
  readTextOption,
} from "./workflow-cli-common.mjs";

const usage = `Usage:
  npm run workflow:session -- --input <six-field-input.json> [options]

Or provide the six inputs directly:
  npm run workflow:session -- \\
    --session-id <id> \\
    --query-file <query.txt> \\
    --gt-file <gt.txt> \\
    --score <score> \\
    --grading-file <grading.txt-or-json> \\
    --answer-file <ida-answer.md>

The JSON file must contain:
  sessionId, query, gt, score, machineGrading, idaAnswer

Long values support --query-file, --gt-file, --grading-file and --answer-file.
Workflow/ingestion options are the same as workflow:csv.
`;

async function loadInput(args) {
  if (args.input) {
    const data = JSON.parse(await readFile(path.resolve(args.input), "utf8"));
    for (const key of ["sessionId", "machineGrading", "idaAnswer"]) {
      if (data[key] === undefined || data[key] === null || data[key] === "") throw new Error(`input JSON is missing ${key}`);
    }
    return data;
  }
  if (!args["session-id"]) throw new Error("--session-id is required when --input is not used");
  return {
    sessionId: args["session-id"],
    query: await readTextOption(args, "query", { required: false }),
    gt: await readTextOption(args, "gt", { required: false }),
    score: args.score,
    machineGrading: await readTextOption(args, "grading"),
    idaAnswer: await readTextOption(args, "answer"),
  };
}

try {
  const args = parseArgs(process.argv.slice(2), {
    valueOptions: [
      "input", "session-id", "query", "query-file", "gt", "gt-file", "score",
      "grading", "grading-file", "answer", "answer-file", ...COMMON_VALUE_OPTIONS,
    ],
    booleanOptions: COMMON_BOOLEAN_OPTIONS,
  });
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  const input = await loadInput(args);
  const retry = await loadRetryPlan(args);
  const result = await runSingleSessionTraceRcaWorkflow({
    ...input,
    ...commonOptions(args),
    ...retry,
  });
  printWorkflowResult(result);
  if (result.counts.failed > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Single-session Trace RCA workflow failed: ${error.stack || error.message}`);
  if (error.workflowOutputDir) console.error(`Workflow output: ${error.workflowOutputDir}`);
  if (error.rcaOutputDir) console.error(`RCA output: ${error.rcaOutputDir}`);
  if (error.failureSummaryPath) console.error(`Failure summary: ${error.failureSummaryPath}`);
  if (error.failureArtifactError) console.error(`Failure artifact warning: ${error.failureArtifactError}`);
  process.exitCode = 1;
}
