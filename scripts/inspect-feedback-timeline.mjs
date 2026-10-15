#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadFeedbackTimeline } from "../src/workflows/online-feedback/timeline-snapshot.mjs";
import { parseCsv } from "../src/workflows/online-feedback/csv.mjs";
import {
  resolveFeedbackAnchor,
} from "../src/workflows/online-feedback/feedback-anchor-resolver.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (["--session-id", "--trace-root", "--candidates", "--output"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function candidateRecords(text, sessionId) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("Candidate CSV is empty");
  const headers = rows[0];
  const indexes = {
    id: headers.indexOf("feedback_candidate_id"),
    sessionId: headers.indexOf("session_id"),
    query: headers.indexOf("request_query"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("Candidate CSV must contain feedback_candidate_id, session_id and request_query");
  }
  return rows.slice(1)
    .filter((row) => String(row[indexes.sessionId]) === String(sessionId))
    .map((row) => ({
      feedbackCandidateId: row[indexes.id],
      sessionId: row[indexes.sessionId],
      requestQuery: row[indexes.query],
      requestIdList: row[headers.indexOf("request_id_list")] ?? "",
      taskId: row[headers.indexOf("task_id")] ?? "",
    }));
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

const usage = `Usage:
  node scripts/inspect-feedback-timeline.mjs \
    --session-id <id> \
    --trace-root <session-trace-directory> \
    --candidates <negative-feedback-candidates.csv> \
    [--output <result.json>]
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  for (const name of ["session-id", "trace-root", "candidates"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const { timeline, coverage } = await loadFeedbackTimeline(path.resolve(args["trace-root"]), args["session-id"]);
  const candidates = candidateRecords(
    await readFile(path.resolve(args.candidates), "utf8"),
    args["session-id"],
  );
  const anchors = candidates.map((candidate) => resolveFeedbackAnchor(timeline, candidate));
  const result = {
    schemaVersion: "online-feedback-timeline-test-v1",
    sessionId: args["session-id"],
    turnCount: timeline.length,
    timelineCoverage: coverage,
    timeRange: timeline.length ? {
      startTime: timeline[0].startTime,
      endTime: timeline.at(-1).endTime,
    } : null,
    candidates: anchors.length,
    resolved: anchors.filter((item) => item.status === "resolved").length,
    ambiguous: anchors.filter((item) => item.status === "ambiguous").length,
    notFound: anchors.filter((item) => item.status === "not_found").length,
    matchMethods: Object.fromEntries(
      [...new Set(anchors.map((item) => item.matchMethod))]
        .map((method) => [method, anchors.filter((item) => item.matchMethod === method).length]),
    ),
    anchors,
  };
  if (args.output) await writeJsonAtomic(path.resolve(args.output), result);
  console.log(JSON.stringify({
    sessionId: result.sessionId,
    turnCount: result.turnCount,
    candidates: result.candidates,
    resolved: result.resolved,
    ambiguous: result.ambiguous,
    notFound: result.notFound,
    matchMethods: result.matchMethods,
    output: args.output ? path.resolve(args.output) : null,
  }, null, 2));
} catch (error) {
  console.error(`Feedback timeline test failed: ${error.message}`);
  process.exitCode = 1;
}
