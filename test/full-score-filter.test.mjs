import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isFullScore,
  parseStrictNumericScore,
  splitFullScoreCsv,
  writeFullScoreSplit,
} from "../src/workflows/trace-rca/full-score-filter.mjs";
import { parseCsv } from "../src/workflows/trace-rca/csv-input.mjs";

test("full score uses strict numeric equality to one", () => {
  for (const value of ["1", "1.0", "1.00", " 1 ", 1]) assert.equal(isFullScore(value), true, String(value));
  for (const value of ["", "1.00（1/1）", "100%", "0.999", "2", -1, null, undefined]) assert.equal(isFullScore(value), false, String(value));
  assert.equal(parseStrictNumericScore(".5"), 0.5);
  assert.equal(parseStrictNumericScore("not-a-score"), null);
});

test("CSV split preserves RFC4180 content and original row order", async () => {
  const csv = [
    "问题,ida_结论报告评分,ida_答案",
    '"q,one",1,"line 1\nline 2"',
    "q2,0.5,a2",
    "q3,1.00,a3",
    "q4,,a4",
    "q5,2,a5",
  ].join("\n");
  const result = splitFullScoreCsv(csv);
  assert.equal(result.summary.fullScoreRows, 2);
  assert.equal(result.summary.rcaCandidateRows, 3);
  assert.equal(result.summary.nonNumericScoreRows, 1);
  assert.deepEqual(result.fullScoreRows.map((row) => row[0]), ["q,one", "q3"]);
  assert.deepEqual(result.rcaRows.map((row) => row[0]), ["q2", "q4", "q5"]);

  const output = await mkdtemp(path.join(os.tmpdir(), "full-score-filter-"));
  const written = await writeFullScoreSplit({ csvText: csv, inputName: "input.csv", outputDir: output });
  const fullRows = parseCsv(await readFile(written.fullScorePath, "utf8"));
  const rcaRows = parseCsv(await readFile(written.rcaPath, "utf8"));
  assert.deepEqual(fullRows, [result.headers, ...result.fullScoreRows]);
  assert.deepEqual(rcaRows, [result.headers, ...result.rcaRows]);
});
