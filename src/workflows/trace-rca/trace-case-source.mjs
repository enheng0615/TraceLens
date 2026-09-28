import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TraceRepository } from "../../rca/trace-repository.mjs";
import { compareEvaluatedQuery, markdownDisplayExact, normalizePlainText } from "./content-alignment.mjs";

async function turnsFromPages(traceRoot) {
  const directory = path.join(traceRoot, "session", "detail-pages");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const turns = [];
    for (const file of files) {
      const payload = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      turns.push(...(payload?.data?.turns ?? payload?.turns ?? []));
    }
    return turns;
  } catch {
    return [];
  }
}

export async function extractSessionExchange(traceRoot, { sessionId, expectedQuery, expectedAnswer } = {}) {
  let candidates = (await turnsFromPages(traceRoot)).filter(
    (turn) => (!sessionId || String(turn.sessionId) === String(sessionId)) && turn.input && turn.output,
  );
  if (!candidates.length) {
    const repository = await TraceRepository.open(traceRoot);
    candidates = repository.spans.filter((span) => span.spanType === "AGENT" && span.input && span.output)
      .map((span) => ({ sessionId: span.sessionId, spanId: span.id, input: span.input, output: span.output, startTime: span.startTime }));
  }
  if (!candidates.length) throw new Error(`No complete AGENT exchange found in Trace: ${traceRoot}`);
  candidates.sort((a, b) => Number(a.startTime ?? 0) - Number(b.startTime ?? 0));
  const normalize = normalizePlainText;
  const query = expectedQuery ? normalize(expectedQuery) : "";
  const answer = expectedAnswer ? normalize(expectedAnswer) : "";
  const exactBoth = candidates.filter(
    (item) => (!query || compareEvaluatedQuery(query, item.input).matches)
      && (!answer || normalize(item.output) === answer || markdownDisplayExact(answer, item.output)),
  );
  const exactQuery = query ? candidates.filter((item) => compareEvaluatedQuery(query, item.input).matches) : [];
  const exactAnswer = answer ? candidates.filter(
    (item) => normalize(item.output) === answer || markdownDisplayExact(answer, item.output),
  ) : [];
  const selected = exactBoth.at(-1) ?? exactQuery.at(-1) ?? exactAnswer.at(-1) ?? candidates.at(-1);
  return {
    query: String(selected.input),
    idaAnswer: String(selected.output),
    spanId: selected.spanId,
    exchangeCount: candidates.length,
  };
}
