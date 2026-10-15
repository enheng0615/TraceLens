#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs, positiveInteger } from "./workflow-cli-common.mjs";
import { runFeedbackBatchWorkflow } from "../src/workflows/online-feedback/feedback-batch.mjs";

const args = parseArgs(process.argv.slice(2), {
  valueOptions: ["csv", "workflow-output-root", "trace-output-root", "max-rounds", "max-turns", "session-start", "session-count", "concurrency"],
  booleanOptions: ["help"],
});
if (args.help) console.log("Usage: node --env-file=.env scripts/run-feedback-batch-workflow.mjs --csv <feedback.csv> --workflow-output-root <directory> [--session-start 1] [--session-count 10] [--concurrency 3] [--max-rounds 12] [--max-turns 24]");
else {
  if (!args.csv || !args["workflow-output-root"]) throw new Error("--csv and --workflow-output-root are required");
  const result = await runFeedbackBatchWorkflow({
    csvText: await readFile(path.resolve(args.csv), "utf8"), fileName: path.basename(args.csv),
    workflowOutputRoot: args["workflow-output-root"],
    traceOutputRoot: path.resolve(args["trace-output-root"] ?? "data/raw/sophon-sessions"),
    maxRounds: positiveInteger(args["max-rounds"], 12, "max-rounds"),
    maxTurns: positiveInteger(args["max-turns"], 24, "max-turns"),
    sessionStart: positiveInteger(args["session-start"], 1, "session-start"),
    sessionCount: positiveInteger(args["session-count"], 10, "session-count"),
    concurrency: positiveInteger(args.concurrency, 3, "concurrency"),
    ingestion: { tenant: process.env.SOPHON_INGESTION_TENANT ?? "data", region: process.env.SOPHON_INGESTION_REGION,
      userEmail: process.env.SOPHON_INGESTION_USER_EMAIL ?? process.env.SOPHON_OPERATOR_EMAIL },
  });
  console.log(`Workflow status: ${result.status}`);
}
