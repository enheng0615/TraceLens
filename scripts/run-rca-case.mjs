#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runRcaCase } from "../src/rca/index.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (["--case", "--trace-root", "--output-root", "--max-rounds", "--mode", "--resume"].includes(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = argv[++index];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:\n  npm run rca:run -- --case <case.json> --trace-root <full-raw>\n  node --env-file=.env scripts/run-rca-case.mjs --case <case.json> --trace-root <full-raw> [--output-root outputs/rca-runs] [--max-rounds 8] [--mode live|offline] [--resume <run-dir>]\n\nRegression fixture:\n  npm run rca:test:29785869`);
  process.exit(0);
}
if (!args.case || !args["trace-root"]) {
  throw new Error("--case and --trace-root are required; use npm run rca:test:29785869 for the fixed regression fixture");
}
const casePath = path.resolve(args.case);
const traceRoot = path.resolve(args["trace-root"]);
const outputRoot = path.resolve(args["output-root"] || "outputs/rca-runs");
const maxRounds = Number.parseInt(args["max-rounds"] || "8", 10);
const mode = args.mode || "live";
if (!["live", "offline"].includes(mode)) throw new Error("--mode must be live or offline");
if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("--max-rounds must be a positive integer");

try {
  const result = await runRcaCase({
    casePath,
    traceRoot,
    outputRoot,
    maxRounds,
    mode,
    resumeDir: args.resume ? path.resolve(args.resume) : undefined,
  });
  console.log(`RCA run completed: ${result.outputDir}`);
  console.log(`Readable agent log: ${path.join(result.outputDir, "agent-run.md")}`);
  console.log(`Final report: ${path.join(result.outputDir, "rca-report.md")}`);
} catch (error) {
  console.error(`RCA test failed: ${error.stack || error.message}`);
  if (error.rcaOutputDir) console.error(`RCA output: ${error.rcaOutputDir}`);
  if (error.failureSummaryPath) console.error(`Failure summary: ${error.failureSummaryPath}`);
  if (error.failureArtifactError) console.error(`Failure artifact warning: ${error.failureArtifactError}`);
  process.exitCode = 1;
}
