import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CHECKPOINT_FILE = "checkpoint.json";

export async function writeCheckpoint(outputDir, state) {
  const target = path.join(outputDir, CHECKPOINT_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify({ schemaVersion: "rca-checkpoint-v1", updatedAt: new Date().toISOString(), ...state }, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}

async function readJsonl(file) {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Recover old live runs created before checkpoint support from their audit log. */
export async function recoverCheckpoint(outputDir) {
  try {
    return JSON.parse(await readFile(path.join(outputDir, CHECKPOINT_FILE), "utf8"));
  } catch {
    // Fall through to event-log recovery.
  }
  const events = await readJsonl(path.join(outputDir, "agent-run.jsonl"));
  const bootstrap = events.find((event) => event.type === "run_started");
  const gapResponses = events.filter(
    (event) => event.phase === "scoring_gap" && event.type === "model_response",
  );
  const target = gapResponses.at(-1)?.data;
  const mapEvent = events.find((event) => event.type === "initial_context_loaded");
  if (!bootstrap || !target || !mapEvent) {
    throw new Error("Run cannot be resumed: bootstrap, validated scoring gap, or trace map is missing");
  }

  const ledgerEntries = [
    {
      evidenceId: "EV-001",
      source: "program",
      tool: "get_trace_overview",
      arguments: {},
      purpose: "建立无偏Trace全局地图",
      result: mapEvent.data.overview,
      rawRefs: [],
    },
    {
      evidenceId: "EV-002",
      source: "program",
      tool: "list_execution_steps",
      arguments: { maxSummaryChars: 260 },
      purpose: "建立客观主执行链",
      result: mapEvent.data.executionSteps,
      rawRefs: (mapEvent.data.executionSteps ?? []).map((item) => item.evidenceRef).filter(Boolean),
    },
    ...events.filter((event) => event.type === "trace_tool_result").map((event) => event.data),
  ];
  const decisions = [];
  for (const event of events.filter((item) => item.type === "explicit_investigation_decision")) {
    const round = Number.parseInt(event.phase.match(/investigation_round_(\d+)/)?.[1] ?? "0", 10);
    const coverageEvent = events.find(
      (item) => item.phase === event.phase && ["coverage_complete", "coverage_incomplete"].includes(item.type),
    );
    decisions.push({ round, decision: event.data, coverage: coverageEvent?.data ?? null });
  }
  const executedActions = events
    .filter((event) => event.type === "trace_tool_requested")
    .map((event) => JSON.stringify([event.data.tool, event.data.arguments]));
  return {
    runId: path.basename(outputDir),
    mode: bootstrap.data.mode,
    target,
    overview: mapEvent.data.overview,
    executionSteps: mapEvent.data.executionSteps,
    ledgerEntries,
    decisions,
    executedActions,
    nextRound: Math.max(0, ...decisions.map((item) => item.round)) + 1,
    recoveredFromEventLog: true,
  };
}
