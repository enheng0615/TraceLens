import { readFile } from "node:fs/promises";
import { extractSessionId } from "../../ingestion/sophon-trace/index.mjs";
import { isFullScore } from "./score-utils.mjs";


function isBlank(value) {
  return !String(value ?? "").trim();
}

function isEmptyMachineGrading(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
  } catch {
    return false;
  }
}

/**
 * Rows satisfying all four conditions describe an upstream run that never
 * produced an evaluable Session, not a Trace-RCA execution failure.
 */
export function classifySourceRunStatus({ sessionId, score, idaAnswer, machineGrading } = {}) {
  const conditions = {
    sessionIdEmpty: isBlank(sessionId),
    scoreEmpty: isBlank(score),
    idaAnswerEmptyOrFailed: isBlank(idaAnswer) || String(idaAnswer).trim().toLocaleLowerCase() === "failed",
    machineGradingEmptyOrEmptyObject: isEmptyMachineGrading(machineGrading),
  };
  if (!Object.values(conditions).every(Boolean)) return null;
  return {
    code: "SOURCE_RUN_FAILED",
    status: "source_run_failed",
    label: "源任务未成功运行",
    detail: "Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}",
    conditions,
  };
}

export const DEFAULT_CSV_COLUMNS = {
  query: ["问题", "query", "Query"],
  groundTruth: ["gt_attribution", "ground_truth", "gt"],
  score: ["ida_结论报告评分", "score"],
  machineGrading: ["ida_decompressed_data", "machine_grading", "机评细则"],
  sessionId: ["session_id", "sessionId"],
  sessionUrl: ["ida_url", "query_url", "url"],
  idaAnswer: ["ida_答案", "ida_answer", "answer"],
};

/** RFC4180-compatible parser for quoted commas, quotes, and embedded newlines. */
export function parseCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function uniqueHeaders(header) {
  const seen = new Map();
  return header.map((value, index) => {
    const base = String(value ?? "").trim() || `__empty_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}__${count}`;
  });
}

function resolveColumn(headers, configured, logicalName) {
  const candidates = Array.isArray(configured) ? configured : [configured];
  const found = candidates.find((candidate) => headers.includes(candidate));
  if (!found) throw new Error(`CSV is missing ${logicalName}; expected one of: ${candidates.join(", ")}`);
  return found;
}

export async function readRcaCsv(filePath, { columns = {} } = {}) {
  const rows = parseCsv(await readFile(filePath, "utf8"));
  if (!rows.length) throw new Error("CSV is empty");
  const headers = uniqueHeaders(rows[0]);
  const merged = { ...DEFAULT_CSV_COLUMNS, ...columns };
  const required = ["query", "groundTruth", "score", "machineGrading", "idaAnswer"];
  const resolved = {};
  for (const name of required) resolved[name] = resolveColumn(headers, merged[name], name);
  const directSession = (Array.isArray(merged.sessionId) ? merged.sessionId : [merged.sessionId]).find((item) => headers.includes(item));
  const sessionUrl = (Array.isArray(merged.sessionUrl) ? merged.sessionUrl : [merged.sessionUrl]).find((item) => headers.includes(item));
  if (!directSession && !sessionUrl) throw new Error("CSV must contain a session ID column or a session URL column");

  const records = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (values.every((value) => !String(value ?? "").trim())) continue;
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const rawSession = directSession ? String(record[directSession] ?? "").trim() : "";
    let sessionId = /^\d+$/.test(rawSession) ? rawSession : "";
    let inputError;
    if (!sessionId) {
      const sessionSource = rawSession || String(record[sessionUrl] ?? "");
      try { sessionId = extractSessionId(sessionSource); }
      catch (error) {
        // Full-score rows are filtered before Trace collection and therefore do
        // not need a Session ID. An actionable row becomes an isolated workflow
        // failure instead of preventing every other CSV row from starting.
        if (!isFullScore(record[resolved.score])) {
          const sourceField = rawSession ? directSession : (sessionUrl || directSession || "session_id/ida_url");
          const sourceValue = sessionSource.trim();
          inputError = {
            code: sourceValue ? "SESSION_ID_INVALID" : "SESSION_ID_MISSING",
            field: sourceField,
            rowNumber: rowIndex + 1,
            message: sourceValue
              ? `CSV第${rowIndex + 1}行无法从${sourceField}提取Session ID`
              : `CSV第${rowIndex + 1}行的${sourceField}为空，无法进行Trace归因`,
            remediation: `请修复源CSV第${rowIndex + 1}行的Session ID或URL后重新上传批次；当前Attempt输入快照不会被改写`,
            causeCode: error?.code,
          };
        }
      }
    }
    const score = record[resolved.score];
    const machineGrading = record[resolved.machineGrading];
    const idaAnswer = record[resolved.idaAnswer];
    const sourceRunStatus = classifySourceRunStatus({ sessionId, score, idaAnswer, machineGrading });
    records.push({
      rowNumber: rowIndex + 1,
      sessionId,
      query: record[resolved.query],
      groundTruth: record[resolved.groundTruth],
      score,
      machineGrading,
      idaAnswer,
      ...(sourceRunStatus ? { sourceRunStatus } : inputError ? { inputError } : {}),
    });
  }
  return { headers, columns: { ...resolved, sessionId: directSession, sessionUrl }, records };
}
