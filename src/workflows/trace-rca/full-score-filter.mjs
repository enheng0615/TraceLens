import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./csv-input.mjs";
import { isFullScore, parseStrictNumericScore } from "./score-utils.mjs";

export const DEFAULT_SCORE_COLUMNS = ["ida_结论报告评分", "score"];
export { isFullScore, parseStrictNumericScore } from "./score-utils.mjs";

function uniqueHeaders(header) {
  const seen = new Map();
  return header.map((value, index) => {
    const base = String(value ?? "").trim() || `__empty_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}__${count}`;
  });
}

function resolveScoreIndex(headers, configured) {
  const candidates = configured ? (Array.isArray(configured) ? configured : [configured]) : DEFAULT_SCORE_COLUMNS;
  const index = candidates.map((candidate) => headers.indexOf(candidate)).find((candidate) => candidate >= 0);
  if (index === undefined) throw new Error(`CSV is missing score column; expected one of: ${candidates.join(", ")}`);
  return index;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function splitFullScoreCsv(csvText, { scoreColumn } = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("CSV is empty");
  const headers = uniqueHeaders(rows[0]);
  const scoreIndex = resolveScoreIndex(headers, scoreColumn);
  const fullScoreRows = [];
  const rcaRows = [];
  const blankRows = [];
  const nonNumericRows = [];
  const outOfRangeRows = [];
  const scoreFrequency = {};

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every((value) => !String(value ?? "").trim())) {
      blankRows.push(index + 1);
      continue;
    }
    const rawScore = String(row[scoreIndex] ?? "").trim();
    scoreFrequency[rawScore] = (scoreFrequency[rawScore] ?? 0) + 1;
    const numericScore = parseStrictNumericScore(rawScore);
    if (numericScore === null) nonNumericRows.push({ rowNumber: index + 1, score: rawScore });
    else if (numericScore < 0 || numericScore > 1) outOfRangeRows.push({ rowNumber: index + 1, score: rawScore });
    if (numericScore === 1) fullScoreRows.push(row);
    else rcaRows.push(row);
  }

  return {
    headers: rows[0],
    scoreColumn: headers[scoreIndex],
    scoreIndex,
    fullScoreRows,
    rcaRows,
    summary: {
      schemaVersion: "trace-batch-full-score-filter-v1",
      rule: "strict_numeric_score_equals_1",
      scoreColumn: headers[scoreIndex],
      inputRows: fullScoreRows.length + rcaRows.length,
      fullScoreRows: fullScoreRows.length,
      rcaCandidateRows: rcaRows.length,
      blankRowsIgnored: blankRows.length,
      nonNumericScoreRows: nonNumericRows.length,
      outOfRangeScoreRows: outOfRangeRows.length,
      invalidScoreRows: nonNumericRows.length + outOfRangeRows.length,
      blankRowNumbers: blankRows,
      nonNumericScores: nonNumericRows,
      outOfRangeScores: outOfRangeRows,
      scoreFrequency,
    },
  };
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

export async function writeFullScoreSplit({ csvText, inputName = "batch.csv", outputDir, scoreColumn }) {
  if (!outputDir) throw new Error("outputDir is required");
  const result = splitFullScoreCsv(csvText, { scoreColumn });
  const parsed = path.parse(path.basename(inputName));
  const base = parsed.name || "batch";
  const resolvedOutput = path.resolve(outputDir);
  const fullScorePath = path.join(resolvedOutput, `${base}.full-score.csv`);
  const rcaPath = path.join(resolvedOutput, `${base}.rca.csv`);
  const summaryPath = path.join(resolvedOutput, `${base}.filter-summary.json`);
  await Promise.all([
    writeAtomic(fullScorePath, serializeCsv([result.headers, ...result.fullScoreRows])),
    writeAtomic(rcaPath, serializeCsv([result.headers, ...result.rcaRows])),
    writeAtomic(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`),
  ]);
  return { ...result, fullScorePath, rcaPath, summaryPath };
}
