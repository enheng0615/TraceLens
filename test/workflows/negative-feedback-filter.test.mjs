import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCsv } from "../../src/workflows/online-feedback/csv.mjs";
import {
  extractNegativeFeedbackCsv,
  filterNegativeFeedbackDirectory,
} from "../../src/workflows/online-feedback/negative-feedback-filter.mjs";

test("extracts only negative A/D/E records and preserves multiline queries", () => {
  const csv = [
    "session_id,task_id,request_id_list,request_query,label",
    '101,t1,r1,"not right, try again",negative',
    '102,t2,r2,"line one\nline two",neutral',
    "101,t3,r3,still wrong,Negative",
  ].join("\n");
  const result = extractNegativeFeedbackCsv(csv, {
    sourceFile: "文档撰写_labeled.csv",
  });

  assert.equal(result.summary.inputRows, 3);
  assert.equal(result.summary.negativeRows, 2);
  assert.equal(result.summary.uniqueNegativeSessions, 1);
  assert.deepEqual(result.events.map((item) => item.sessionId), ["101", "101"]);
  assert.deepEqual(result.events.map((item) => item.requestQuery), [
    "not right, try again",
    "still wrong",
  ]);
  assert.equal(result.events[0].category, "文档撰写");
  assert.equal(result.events[0].sourceRowNumber, 2);
  assert.match(result.events[0].sourceRecordId, /^NFR-[a-f0-9]{20}$/);
});

test("directory filter writes category, merged, Session and summary outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "negative-feedback-filter-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  await mkdir(input);
  await writeFile(
    path.join(input, "类别A_labeled.csv"),
    [
      "session_id,task_id,request_id_list,request_query,label",
      "10,t1,r1,q1,negative",
      "11,t2,r2,q2,neutral",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(input, "类别B_labeled.csv"),
    [
      "session_id,task_id,request_id_list,request_query,label",
      "10,t3,r3,q1,negative",
      "12,t4,r4,q4,negative",
    ].join("\n"),
    "utf8",
  );

  const result = await filterNegativeFeedbackDirectory({ inputDir: input, outputDir: output });
  assert.equal(result.summary.sourceFiles, 2);
  assert.equal(result.summary.inputRows, 4);
  assert.equal(result.summary.negativeSourceRows, 3);
  assert.equal(result.summary.feedbackCandidates, 3);
  assert.equal(result.summary.sourceRowsCollapsedInCandidateView, 0);
  assert.equal(result.summary.uniqueNegativeSessions, 2);

  const merged = parseCsv(await readFile(result.sourceRowsPath, "utf8"));
  assert.deepEqual(merged[0], [
    "source_record_id", "session_id", "request_query", "label",
    "category", "source_file", "source_row_number",
    "task_id", "request_id_list", "raw_record_json", "source_sha256",
  ]);
  assert.deepEqual(merged.slice(1).map((row) => row[1]), ["10", "10", "12"]);

  const candidates = parseCsv(await readFile(result.candidatesPath, "utf8"));
  assert.equal(candidates.length, 4);
  assert.match(candidates[1][0], /^NFC-[a-f0-9]{20}$/);
  assert.equal(candidates[1][5], "1");
  assert.equal(merged[1][7], "t1");
  assert.equal(merged[1][8], "r1");
  assert.equal(JSON.parse(merged[1][9]).task_id, "t1");

  const sessions = parseCsv(await readFile(result.sessionsPath, "utf8"));
  assert.deepEqual(sessions, [
    ["session_id", "feedback_candidate_count", "negative_source_row_count", "categories"],
    ["10", "2", "2", "类别A|类别B"],
    ["12", "1", "1", "类别B"],
  ]);
  const summary = JSON.parse(await readFile(result.summaryPath, "utf8"));
  assert.equal(summary.rule, "case_insensitive_trimmed_label_equals_negative");
});

test("fails closed when the required source columns are absent", () => {
  assert.throws(
    () => extractNegativeFeedbackCsv("a,b,c,d,e\n1,2,3,q,negative\n"),
    /missing required columns/,
  );
});
