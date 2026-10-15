#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { filterNegativeFeedbackDirectory } from "../src/workflows/online-feedback/negative-feedback-filter.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      result.help = true;
      continue;
    }
    if (["--input-dir", "--output-dir", "--negative-label"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

const usage = `Usage:
  npm run feedback:filter-negative -- \\
    --input-dir <directory-containing-csv-files> \\
    --output-dir <output-directory> \\
    [--negative-label negative]

Each input CSV must contain:
  A: session_id
  D: request_query
  E: label

Outputs:
  negative-feedback-source-rows.csv  all negative source rows, without deduplication
  negative-feedback-candidates.csv   Session + Query + task/request association groups
  negative-session-ids.csv           unique Session IDs with candidate counts
  negative-feedback-summary.json     counts and per-source audit summary
  by-category/*.negative.csv         one filtered source-row file per category
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  if (!args["input-dir"]) throw new Error("--input-dir is required");
  if (!args["output-dir"]) throw new Error("--output-dir is required");
  const result = await filterNegativeFeedbackDirectory({
    inputDir: path.resolve(args["input-dir"]),
    outputDir: path.resolve(args["output-dir"]),
    negativeLabel: args["negative-label"] || "negative",
  });
  console.log(JSON.stringify({
    sourceFiles: result.summary.sourceFiles,
    inputRows: result.summary.inputRows,
    negativeSourceRows: result.summary.negativeSourceRows,
    feedbackCandidates: result.summary.feedbackCandidates,
    uniqueNegativeSessions: result.summary.uniqueNegativeSessions,
    sourceRowsPath: result.sourceRowsPath,
    candidatesPath: result.candidatesPath,
    sessionsPath: result.sessionsPath,
    summaryPath: result.summaryPath,
    categories: result.categoryOutputs,
  }, null, 2));
} catch (error) {
  console.error(`Negative-feedback filter failed: ${error.message}`);
  process.exitCode = 1;
}
