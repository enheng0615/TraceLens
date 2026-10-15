#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs, positiveInteger } from "./workflow-cli-common.mjs";
import { runFeedbackWorkflow } from "../src/workflows/online-feedback/workflow.mjs";
const args = parseArgs(process.argv.slice(2), { valueOptions: ["input", "workflow-output-root", "trace-output-root", "max-rounds", "max-turns"], booleanOptions: ["help"] });
if (args.help) console.log("Usage: node --env-file=.env scripts/run-feedback-workflow.mjs --input <feedback.json> --workflow-output-root <directory> [--trace-output-root <directory>] [--max-rounds 12] [--max-turns 24]");
else {
  if (!args.input || !args["workflow-output-root"]) throw new Error("--input and --workflow-output-root are required");
  const result = await runFeedbackWorkflow({ input: JSON.parse(await readFile(path.resolve(args.input), "utf8")), workflowOutputRoot: args["workflow-output-root"],
    traceOutputRoot: path.resolve(args["trace-output-root"] ?? "data/raw/sophon-sessions"),
    maxRounds: positiveInteger(args["max-rounds"], 12, "max-rounds"), maxTurns: positiveInteger(args["max-turns"], 24, "max-turns"),
    ingestion: { tenant: process.env.SOPHON_INGESTION_TENANT ?? "data", region: process.env.SOPHON_INGESTION_REGION,
      userEmail: process.env.SOPHON_INGESTION_USER_EMAIL ?? process.env.SOPHON_OPERATOR_EMAIL } });
  console.log(`Workflow status: ${result.status}`);
}
