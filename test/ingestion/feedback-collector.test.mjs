import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectFeedbackEpisode } from "../../src/ingestion/sophon-trace/fetch-feedback-episode.mjs";

const episode = { episodeId: "episode", sessionId: "1", feedbackReceivedAt: 30,
  traceIds: ["t"], selectedTurns: [{ turnId: "turn", businessTraceId: "t", startTime: 10, endTime: 20 }] };

test("selective collector fetches only selected trees/details and reuses immutable cached files", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "selective-feedback-"));
  const calls = [];
  const client = { tenant: "data", region: "cn", async fetchJson(file, args) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    calls.push(args);
    const payload = args[1] === "tree" ? { data: { id: "s", childs: [] } } : { data: { id: "s", traceId: "t", sessionId: "1", startTime: 10, endTime: 20, input: "{}", output: "{}" } };
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(payload)); return payload;
  } };
  try {
    const options = { client, episode, cacheRoot, identity: { agentId: "a", agentType: "ida" } };
    const first = await collectFeedbackEpisode(options);
    assert.equal(first.completion.downloadedSpanCount, 1);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["trace", "tree"], ["trace", "get"]]);
    assert.ok(calls[0].includes("--exclude-input-output"));
    await collectFeedbackEpisode(options);
    assert.equal(calls.length, 2);
    await assert.rejects(collectFeedbackEpisode({ ...options, episode: { ...episode, feedbackReceivedAt: 15 } }), /boundary/);
    await collectFeedbackEpisode(options); // Failed boundary checks release the lock.
  } finally { await rm(cacheRoot, { recursive: true, force: true }); }
});
