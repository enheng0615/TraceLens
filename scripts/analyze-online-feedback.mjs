#!/usr/bin/env node
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { PiJsonAgent } from "../src/rca/pi-json-agent.mjs";
import { RunLogger } from "../src/rca/run-logger.mjs";
import { loadFeedbackTimeline } from "../src/workflows/online-feedback/timeline-snapshot.mjs";
import { runOnlineFeedbackCase } from "../src/rca/scenarios/online-feedback.mjs";
import { collectFeedbackEpisode } from "../src/ingestion/sophon-trace/fetch-feedback-episode.mjs";
import { SophonCliClient } from "../src/ingestion/sophon-trace/sophon-cli-client.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === "--resume") args.resume = true;
  else if (key === "--fetch-missing") args.fetchMissing = true;
  else if (key === "--help") args.help = true;
  else if (["--session-id", "--query", "--candidate", "--timeline-root", "--trace-root", "--output-dir", "--max-rounds", "--max-turns", "--region", "--cache-root", "--max-trace-mib"].includes(key) && process.argv[i + 1]) args[key.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${key}`);
}
if (args.help) {
  console.log("Usage: npm run feedback:analyze -- --session-id <id> (--query <negative query> | --candidate <candidate.json>) --timeline-root <Turn snapshot> --trace-root <local raw Trace> --output-dir <new run directory> [--max-rounds 12] [--max-turns 24] [--resume] [--fetch-missing --region <region> --cache-root <directory> --max-trace-mib 512]");
} else {
  for (const key of ["session-id", "timeline-root", "trace-root", "output-dir"]) if (!args[key]) throw new Error(`--${key} is required`);
  if (!args.query && !args.candidate) throw new Error("--query or --candidate is required");
  const outputDir = path.resolve(args["output-dir"]);
  if (!args.resume) {
    let existing = [];
    try { existing = await readdir(outputDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing.length) throw new Error("Output directory is nonempty; use a new directory or --resume");
  }
  const candidate = args.candidate ? JSON.parse(await readFile(args.candidate, "utf8")) : { sessionId: args["session-id"], requestQuery: args.query };
  if (String(candidate.sessionId ?? candidate.session_id) !== args["session-id"]) throw new Error("Candidate Session mismatch");
  const logger = new RunLogger(outputDir);
  if (args.resume) await logger.resume();
  else await logger.initialize({ runId: path.basename(outputDir), sessionId: args["session-id"], startedAt: new Date().toISOString() });
  const { timeline, coverage } = await loadFeedbackTimeline(path.resolve(args["timeline-root"]), args["session-id"]);
  if (args.fetchMissing && (!args.region || !coverage.identity.agentId || !coverage.identity.agentType)) throw new Error("--fetch-missing requires --region and verified agentId/agentType in the Turn snapshot");
  const collectEpisode = args.fetchMissing ? (episode) => collectFeedbackEpisode({
    episode, identity: coverage.identity, cacheRoot: args["cache-root"] ?? "data/raw/sophon-feedback-cache",
    maxBytes: Number(args["max-trace-mib"] ?? 512) * 1024 * 1024,
    client: new SophonCliClient({ region: args.region, tenant: process.env.SOPHON_INGESTION_TENANT ?? "data", userEmail: process.env.SOPHON_INGESTION_USER_EMAIL ?? process.env.SOPHON_OPERATOR_EMAIL }),
  }) : undefined;
  const result = await runOnlineFeedbackCase({ candidate, timeline, timelineCoverage: coverage,
    traceRoot: path.resolve(args["trace-root"]), outputDir, agent: new PiJsonAgent({ logger }),
    maxRounds: Number(args["max-rounds"] ?? 12), maxTurns: Number(args["max-turns"] ?? 24), resume: args.resume, collectEpisode });
  console.log(JSON.stringify({ outputDir, status: result.status, causalInvestigationStatus: result.causalInvestigationStatus }, null, 2));
}
