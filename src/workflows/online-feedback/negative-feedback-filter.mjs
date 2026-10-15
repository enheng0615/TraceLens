import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCsv, serializeCsv } from "./csv.mjs";

const REQUIRED_HEADERS = ["session_id", "request_query", "label"];
const SOURCE_ROW_HEADERS = [
  "source_record_id",
  "session_id",
  "request_query",
  "label",
  "category",
  "source_file",
  "source_row_number",
  "task_id", "request_id_list", "raw_record_json", "source_sha256",
];
const CANDIDATE_HEADERS = [
  "feedback_candidate_id",
  "session_id",
  "request_query",
  "label",
  "categories",
  "source_occurrences",
  "source_files",
  "source_row_references",
  "task_id", "request_id_list",
];

function stableId(prefix, parts) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}-${digest}`;
}

function stableSourceRecordId({ category, sessionId, query, sourceFile, sourceRowNumber, sourceSha256 }) {
  return stableId("NFR", [category, sessionId, query, sourceFile, sourceRowNumber, sourceSha256]);
}

function stableCandidateId({ sessionId, query, taskId, requestIdList }) {
  return stableId("NFC", [sessionId, query, taskId, requestIdList]);
}

function categoryFromFile(fileName) {
  return path.parse(fileName).name.replace(/_labeled$/i, "");
}

function safeOutputPart(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || "unknown";
}

function resolveHeaders(header, fileName) {
  const normalized = header.map((value) => String(value ?? "").trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${fileName} has duplicate column names`);
  const indexes = Object.fromEntries(
    REQUIRED_HEADERS.map((name) => [name, normalized.indexOf(name)]),
  );
  const missing = REQUIRED_HEADERS.filter((name) => indexes[name] < 0);
  if (missing.length) {
    throw new Error(`${fileName} is missing required columns: ${missing.join(", ")}`);
  }
  return { normalized, indexes };
}

function sourceSummary({ fileName, category, rows, events, labelCounts, blankRowsIgnored }) {
  const sessionCounts = new Map();
  for (const event of events) {
    sessionCounts.set(event.sessionId, (sessionCounts.get(event.sessionId) ?? 0) + 1);
  }
  return {
    fileName,
    category,
    inputRows: rows,
    negativeRows: events.length,
    uniqueNegativeSessions: sessionCounts.size,
    sessionsWithMultipleNegativeEvents: [...sessionCounts.values()].filter((count) => count > 1).length,
    maxNegativeEventsPerSession: Math.max(0, ...sessionCounts.values()),
    blankRowsIgnored,
    labelCounts: Object.fromEntries([...labelCounts].sort(([left], [right]) => left.localeCompare(right))),
  };
}

/** Extract event-level negative feedback records without collapsing repeated Sessions. */
export function extractNegativeFeedbackCsv(csvText, {
  sourceFile = "input.csv",
  category = categoryFromFile(sourceFile),
  negativeLabel = "negative",
} = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error(`${sourceFile} is empty`);
  const { normalized: headers, indexes } = resolveHeaders(rows[0], sourceFile);
  const events = [];
  const sourceSha256 = createHash("sha256").update(csvText).digest("hex");
  const labelCounts = new Map();
  let inputRows = 0;
  let blankRowsIgnored = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every((value) => !String(value ?? "").trim())) {
      blankRowsIgnored += 1;
      continue;
    }
    inputRows += 1;
    if (row.length !== headers.length) {
      throw new Error(
        `${sourceFile} row ${rowIndex + 1} has ${row.length} columns; expected ${headers.length}`,
      );
    }
    const sessionId = String(row[indexes.session_id] ?? "").trim();
    const query = String(row[indexes.request_query] ?? "");
    const label = String(row[indexes.label] ?? "").trim().toLocaleLowerCase();
    labelCounts.set(label || "<blank>", (labelCounts.get(label || "<blank>") ?? 0) + 1);
    if (label !== negativeLabel.toLocaleLowerCase()) continue;
    if (!sessionId) throw new Error(`${sourceFile} row ${rowIndex + 1} has an empty session_id`);
    if (!/^\d+$/.test(sessionId)) {
      throw new Error(`${sourceFile} row ${rowIndex + 1} has a non-numeric session_id`);
    }
    if (!query.trim()) throw new Error(`${sourceFile} row ${rowIndex + 1} has an empty request_query`);
    events.push({
      sourceRecordId: stableSourceRecordId({
        category,
        sessionId,
        query,
        sourceFile,
        sourceRowNumber: rowIndex + 1,
        sourceSha256,
      }),
      sessionId,
      requestQuery: query,
      label,
      category,
      sourceFile,
      sourceRowNumber: rowIndex + 1,
      taskId: String(row[headers.indexOf("task_id")] ?? "").trim(),
      requestIdList: String(row[headers.indexOf("request_id_list")] ?? "").trim(),
      rawRecord: Object.fromEntries(headers.map((name, index) => [name, row[index]])),
      sourceSha256,
    });
  }

  return {
    headers,
    events,
    summary: sourceSummary({
      fileName: sourceFile,
      category,
      rows: inputRows,
      events,
      labelCounts,
      blankRowsIgnored,
    }),
  };
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function eventRows(events) {
  return [
    SOURCE_ROW_HEADERS,
    ...events.map((event) => [
      event.sourceRecordId,
      event.sessionId,
      event.requestQuery,
      event.label,
      event.category,
      event.sourceFile,
      event.sourceRowNumber,
      event.taskId, event.requestIdList, JSON.stringify(event.rawRecord), event.sourceSha256,
    ]),
  ];
}

function buildCandidates(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.sessionId, event.requestQuery, event.taskId, event.requestIdList]);
    let group = groups.get(key);
    if (!group) {
      group = {
        feedbackCandidateId: stableCandidateId({
          sessionId: event.sessionId,
          query: event.requestQuery,
          taskId: event.taskId, requestIdList: event.requestIdList,
        }),
        sessionId: event.sessionId,
        requestQuery: event.requestQuery,
        taskId: event.taskId, requestIdList: event.requestIdList,
        label: "negative",
        categories: new Set(),
        sourceFiles: new Set(),
        sourceRows: [],
      };
      groups.set(key, group);
    }
    group.categories.add(event.category);
    group.sourceFiles.add(event.sourceFile);
    group.sourceRows.push(`${event.sourceFile}:${event.sourceRowNumber}`);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    categories: [...group.categories].sort((left, right) => left.localeCompare(right, "zh-CN")),
    sourceFiles: [...group.sourceFiles].sort((left, right) => left.localeCompare(right, "zh-CN")),
    sourceRows: [...group.sourceRows].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })),
  }));
}

function candidateRows(candidates) {
  return [
    CANDIDATE_HEADERS,
    ...candidates.map((candidate) => [
      candidate.feedbackCandidateId,
      candidate.sessionId,
      candidate.requestQuery,
      candidate.label,
      candidate.categories.join("|"),
      candidate.sourceRows.length,
      candidate.sourceFiles.join("|"),
      candidate.sourceRows.join("|"),
      candidate.taskId, candidate.requestIdList,
    ]),
  ];
}

function buildSessions(events, candidates) {
  const sessions = new Map();
  for (const event of events) {
    let session = sessions.get(event.sessionId);
    if (!session) {
      session = { sessionId: event.sessionId, sourceRows: 0, candidates: 0, categories: new Set() };
      sessions.set(event.sessionId, session);
    }
    session.sourceRows += 1;
    session.categories.add(event.category);
  }
  for (const candidate of candidates) sessions.get(candidate.sessionId).candidates += 1;
  return [...sessions.values()]
    .map((session) => ({
      ...session,
      categories: [...session.categories].sort((left, right) => left.localeCompare(right, "zh-CN")),
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId, "en", { numeric: true }));
}

function buildOverallSummary(sourceSummaries, events, candidates, sessions) {
  const sessionCounts = new Map();
  for (const event of events) {
    sessionCounts.set(event.sessionId, (sessionCounts.get(event.sessionId) ?? 0) + 1);
  }
  return {
    schemaVersion: "online-negative-feedback-filter-v2",
    rule: "case_insensitive_trimmed_label_equals_negative",
    selectedColumns: {
      source: ["session_id", "request_query", "label", "task_id", "request_id_list", "all_original_columns"],
      sourceRowOutput: SOURCE_ROW_HEADERS,
      candidateOutput: CANDIDATE_HEADERS,
    },
    deduplication: {
      rawRowsPreserved: true,
      candidateKey: ["session_id", "request_query", "task_id", "request_id_list"],
      note: "Request associations are preserved, but candidate groups are not proven feedback event identities until anchored to a Turn.",
    },
    sourceFiles: sourceSummaries.length,
    inputRows: sourceSummaries.reduce((total, item) => total + item.inputRows, 0),
    negativeSourceRows: events.length,
    feedbackCandidates: candidates.length,
    candidateGroupsWithMultipleSourceRows: candidates.filter((item) => item.sourceRows.length > 1).length,
    sourceRowsCollapsedInCandidateView: events.length - candidates.length,
    uniqueNegativeSessions: sessions.length,
    sessionsWithMultipleNegativeEvents: [...sessionCounts.values()].filter((count) => count > 1).length,
    maxNegativeEventsPerSession: Math.max(0, ...sessionCounts.values()),
    countSemantics: "Legacy negative-event counters count source rows, not proven distinct user feedback events.",
    sessionsWithMultipleCandidateGroups: sessions.filter((session) => session.candidates > 1).length,
    sources: sourceSummaries,
  };
}

/**
 * Process every CSV in a directory and write category, merged-event and
 * unique-Session outputs. Event rows are intentionally not deduplicated.
 */
export async function filterNegativeFeedbackDirectory({
  inputDir,
  outputDir,
  negativeLabel = "negative",
} = {}) {
  if (!inputDir) throw new Error("inputDir is required");
  if (!outputDir) throw new Error("outputDir is required");
  const resolvedInput = path.resolve(inputDir);
  const resolvedOutput = path.resolve(outputDir);
  if (resolvedInput === resolvedOutput) throw new Error("Input and output directories must differ");
  const entries = (await readdir(resolvedInput, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".csv"))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  if (!entries.length) throw new Error(`No CSV files found in ${resolvedInput}`);

  const allEvents = [];
  const sourceSummaries = [];
  const categoryOutputs = [];
  for (const entry of entries) {
    const result = extractNegativeFeedbackCsv(
      await readFile(path.join(resolvedInput, entry.name), "utf8"),
      {
        sourceFile: entry.name,
        category: categoryFromFile(entry.name),
        negativeLabel,
      },
    );
    allEvents.push(...result.events);
    sourceSummaries.push(result.summary);
    const outputPath = path.join(
      resolvedOutput,
      "by-category",
      `${safeOutputPart(result.summary.category)}.negative.csv`,
    );
    await writeAtomic(outputPath, serializeCsv(eventRows(result.events)));
    categoryOutputs.push({
      category: result.summary.category,
      outputPath,
      negativeRows: result.events.length,
    });
  }

  const candidates = buildCandidates(allEvents);
  const sessions = buildSessions(allEvents, candidates);
  const sourceRowsPath = path.join(resolvedOutput, "negative-feedback-source-rows.csv");
  const candidatesPath = path.join(resolvedOutput, "negative-feedback-candidates.csv");
  const sessionsPath = path.join(resolvedOutput, "negative-session-ids.csv");
  const summaryPath = path.join(resolvedOutput, "negative-feedback-summary.json");
  const summary = buildOverallSummary(sourceSummaries, allEvents, candidates, sessions);
  await Promise.all([
    writeAtomic(sourceRowsPath, serializeCsv(eventRows(allEvents))),
    writeAtomic(candidatesPath, serializeCsv(candidateRows(candidates))),
    writeAtomic(sessionsPath, serializeCsv([
      ["session_id", "feedback_candidate_count", "negative_source_row_count", "categories"],
      ...sessions.map((session) => [
        session.sessionId,
        session.candidates,
        session.sourceRows,
        session.categories.join("|"),
      ]),
    ])),
  ]);
  await writeAtomic(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return {
    inputDir: resolvedInput,
    outputDir: resolvedOutput,
    sourceRowsPath,
    candidatesPath,
    sessionsPath,
    summaryPath,
    categoryOutputs,
    summary,
  };
}
