import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SophonSessionCollector } from "../../src/ingestion/sophon-trace/fetch-session.mjs";
import { writeJsonAtomic } from "../../src/ingestion/sophon-trace/file-store.mjs";

const SESSION_ID = "session-1";
const TRACE_ID = "trace-1";
const SPANS = [
  { id: "span-root", traceId: TRACE_ID, input: "question", output: "answer" },
  { id: "span-model", traceId: TRACE_ID, input: { prompt: "p" }, output: { text: "a" } },
  { id: "span-tool", traceId: TRACE_ID, input: { query: "q" }, output: { rows: [1] } },
];

class FakeSophonClient {
  constructor() {
    this.tenant = "test";
    this.calls = [];
  }

  async fetchJson(outputPath, args) {
    this.calls.push(args);
    const command = args.slice(0, 2).join(" ");
    const tokenIndex = args.indexOf("--page-token");
    const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
    let payload;

    if (command === "session list") {
      payload = {
        success: true,
        data: {
          sessions: [{
            sessionId: SESSION_ID,
            agentId: "agent-1",
            startTime: 1_000_000,
            endTime: 1_100_000,
            traceCount: 1,
            latestTraceId: TRACE_ID,
          }],
          hasMore: false,
        },
      };
    } else if (command === "session get") {
      payload = token
        ? {
            success: true,
            data: {
              turns: [{ businessTraceId: TRACE_ID, turnId: "turn-2" }],
              hasMore: false,
            },
          }
        : {
            success: true,
            data: {
              turns: [{ businessTraceId: TRACE_ID, turnId: "turn-1" }],
              hasMore: true,
              nextPageToken: "turn-page-2",
            },
          };
    } else if (command === "session stats") {
      payload = { success: true, data: { sessionId: SESSION_ID } };
    } else if (command === "trace list") {
      payload = token
        ? { success: true, data: { spans: SPANS.slice(2), hasMore: false } }
        : {
            success: true,
            data: {
              spans: SPANS.slice(0, 2),
              hasMore: true,
              nextPageToken: "span-page-2",
            },
          };
    } else if (command === "trace tree") {
      payload = {
        success: true,
        data: {
          ...SPANS[0],
          childs: [
            { ...SPANS[1], childs: [] },
            { ...SPANS[2], childs: [] },
          ],
        },
      };
    } else if (command === "trace get") {
      const spanId = args[2];
      payload = { success: true, data: SPANS.find((span) => span.id === spanId) };
    } else {
      throw new Error(`Unexpected fake command: ${args.join(" ")}`);
    }

    await writeJsonAtomic(outputPath, payload);
    return payload;
  }
}

test("collects every page, tree, and span detail into a verified artifact", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sophon-collector-"));
  try {
    const client = new FakeSophonClient();
    const collector = new SophonSessionCollector({
      client,
      outputRoot: temp,
      logger: { info() {}, warn() {} },
      clock: () => "2026-09-21T00:00:00.000Z",
    });
    const result = await collector.collect({
      sessionId: SESSION_ID,
      pageSize: 2,
      paddingMs: 500,
    });

    assert.equal(result.manifest.status, "completed");
    assert.equal(result.integrity.complete, true);
    assert.deepEqual(result.integrity.counts, {
      turns: 2,
      traces: 1,
      spans: 3,
      uniqueSpanIds: 3,
      treeSpanIds: 3,
      spanDetails: 3,
    });
    assert.equal(result.integrity.pagination.sessionDetailPages.length, 2);
    assert.equal(result.integrity.pagination.spanListPages.length, 2);
    assert.equal(result.integrity.payloads.explicitTruncationMarkersFound, 0);
    assert.equal(
      result.integrity.crossSourceComparisons["output:spanList:spanDetail"].mismatches,
      0,
    );

    const manifest = JSON.parse(
      await readFile(path.join(temp, SESSION_ID, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.source.querySince, 999_500);
    assert.equal(manifest.source.queryUntil, 1_100_500);
    assert.equal(client.calls.filter((args) => args[0] === "trace" && args[1] === "get").length, 3);
    const traceListCall = client.calls.find(
      (args) => args[0] === "trace" && args[1] === "list",
    );
    assert.equal(
      traceListCall[traceListCall.indexOf("--filter") + 1],
      `session_id="${SESSION_ID}"`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("refreshes an empty cache and finds historical Sessions in bounded 30-day windows", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sophon-empty-session-cache-"));
  try {
    const base = new FakeSophonClient();
    const calls = [];
    const recentStart = 10_000_000_000;
    const client = {
      tenant: base.tenant,
      async fetchJson(outputPath, args, options = {}) {
        if (args[0] === "session" && args[1] === "list") {
          calls.push({ args, force: options.force === true });
          const hasWindow = args.includes("--since");
          const payload = hasWindow
            ? {
                success: true,
                data: {
                  sessions: [{
                    sessionId: SESSION_ID,
                    agentId: "agent-1",
                    startTime: 1_000_000,
                    endTime: 1_100_000,
                    traceCount: 1,
                    latestTraceId: TRACE_ID,
                  }],
                  hasMore: false,
                },
              }
            : { success: true, data: { total: 0, sessions: [], hasMore: false, startTime: recentStart } };
          await writeJsonAtomic(outputPath, payload);
          return payload;
        }
        return base.fetchJson(outputPath, args, options);
      },
    };
    await writeJsonAtomic(path.join(temp, SESSION_ID, "session/list.json"), {
      success: true,
      data: { total: 0, sessions: [], hasMore: false },
    });
    const collector = new SophonSessionCollector({
      client,
      outputRoot: temp,
      logger: { info() {}, warn() {} },
      clock: () => "2026-09-23T00:00:00.000Z",
      nowMs: () => recentStart + 1,
    });

    const result = await collector.collect({ sessionId: SESSION_ID, pageSize: 2, paddingMs: 500 });
    assert.equal(result.manifest.status, "completed");
    assert.equal(result.manifest.source.sessionLookup.strategy, "historical_window");
    assert.equal(result.manifest.source.sessionLookup.windowsQueried, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes("--since"), false);
    assert.equal(calls[0].force, true);
    const since = Number(calls[1].args[calls[1].args.indexOf("--since") + 1]);
    const until = Number(calls[1].args[calls[1].args.indexOf("--until") + 1]);
    assert.ok(Number.isFinite(since) && Number.isFinite(until));
    assert.ok(until > since);
    assert.ok(until - since < 30 * 24 * 60 * 60 * 1_000);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

class TruncatedSophonClient extends FakeSophonClient {
  constructor(downloadUrl) {
    super();
    this.downloadUrl = downloadUrl;
  }

  async fetchJson(outputPath, args) {
    const payload = await super.fetchJson(outputPath, args);
    const truncatedOutput = JSON.stringify({
      tool_name: "bash",
      output: "partial...[truncated]",
      results: [{
        isResultTruncated: true,
        originalResultChars: 50000,
        fullResultDownloadUrl: this.downloadUrl,
      }],
    });
    const patch = (span) => span?.id === "span-tool" ? { ...span, output: truncatedOutput } : span;
    const command = args.slice(0, 2).join(" ");
    if (command === "trace list") payload.data.spans = payload.data.spans.map(patch);
    if (command === "trace get" && payload.data?.id === "span-tool") payload.data = patch(payload.data);
    if (command === "trace tree") {
      payload.data = patch(payload.data);
      payload.data.childs = payload.data.childs.map(patch);
    }
    await writeJsonAtomic(outputPath, payload);
    return payload;
  }
}

test("recovers truncated Tool Results and makes the enriched content searchable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sophon-expanded-result-"));
  try {
    const downloadUrl = "https://ida.bytedance.net/dataAgent/llm/api/v2/deepresearch/images?file_path=safe-result.md";
    const fetchCalls = [];
    const collector = new SophonSessionCollector({
      client: new TruncatedSophonClient(downloadUrl),
      outputRoot: temp,
      logger: { info() {}, warn() {} },
      clock: () => "2026-09-24T00:00:00.000Z",
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return new Response("complete recovered evidence: needle-from-full-result", { status: 200, headers: { "content-type": "text/markdown" } });
      },
    });
    const result = await collector.collect({ sessionId: SESSION_ID, pageSize: 2, paddingMs: 500 });
    assert.equal(result.integrity.complete, true);
    assert.equal(result.integrity.payloads.explicitTruncationMarkersFound, 2);
    assert.equal(result.integrity.payloads.unresolvedTruncationMarkers, 0);
    assert.deepEqual(result.integrity.expandedToolResults.recoveredSpanIds, ["span-tool"]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], downloadUrl);
    const artifact = JSON.parse(await readFile(path.join(temp, SESSION_ID, "expanded-tool-results", "span-tool.json"), "utf8"));
    assert.match(artifact.data.output, /needle-from-full-result/);
    assert.equal(JSON.stringify(result.integrity).includes(downloadUrl), false);

    const { TraceRepository } = await import("../../src/rca/trace-repository.mjs");
    const repository = await TraceRepository.open(path.join(temp, SESSION_ID));
    const search = repository.search({ query: "needle-from-full-result", scope: "all" });
    assert.equal(search.totalMatches, 1);
    assert.equal(repository.byId.get("span-tool").expandedToolResult, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("keeps a failed full-result recovery as partial_recoverable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sophon-expanded-result-failed-"));
  try {
    const collector = new SophonSessionCollector({
      client: new TruncatedSophonClient("https://ida.bytedance.net/dataAgent/llm/api/v2/deepresearch/images?file_path=safe-result.md"),
      outputRoot: temp,
      logger: { info() {}, warn() {} },
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    const result = await collector.collect({ sessionId: SESSION_ID, pageSize: 2, paddingMs: 500 });
    assert.equal(result.integrity.complete, false);
    assert.equal(result.integrity.completeness, "partial_recoverable");
    assert.equal(result.integrity.expandedToolResults.attempts[0].status, "failed");
    assert.equal(result.integrity.expandedToolResults.unresolvedSpanIds[0], "span-tool");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
