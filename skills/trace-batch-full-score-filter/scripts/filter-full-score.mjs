#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writeFullScoreSplit } from "../../../src/workflows/trace-rca/full-score-filter.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (["--input", "--output-dir", "--score-column"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

const usage = `Usage:
  node skills/trace-batch-full-score-filter/scripts/filter-full-score.mjs \\
    --input <batch.csv> \\
    --output-dir <directory> \\
    [--score-column <name>]
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  if (!args.input) throw new Error("--input is required");
  if (!args["output-dir"]) throw new Error("--output-dir is required");
  const inputPath = path.resolve(args.input);
  const result = await writeFullScoreSplit({
    csvText: await readFile(inputPath, "utf8"),
    inputName: path.basename(inputPath),
    outputDir: path.resolve(args["output-dir"]),
    scoreColumn: args["score-column"],
  });
  console.log(JSON.stringify({
    inputRows: result.summary.inputRows,
    fullScoreRows: result.summary.fullScoreRows,
    rcaCandidateRows: result.summary.rcaCandidateRows,
    nonNumericScoreRows: result.summary.nonNumericScoreRows,
    outOfRangeScoreRows: result.summary.outOfRangeScoreRows,
    fullScorePath: result.fullScorePath,
    rcaPath: result.rcaPath,
    summaryPath: result.summaryPath,
  }, null, 2));
} catch (error) {
  console.error(`Full-score filter failed: ${error.message}`);
  process.exitCode = 1;
}
