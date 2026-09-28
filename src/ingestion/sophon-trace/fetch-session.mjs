import { stat } from "node:fs/promises";
import path from "node:path";
import { TraceIngestionError } from "./errors.mjs";
import {
  ensureDirectory,
  isValidJsonFile,
  readJson,
  removePath,
  safeFileName,
  writeJsonAtomic,
  writeTextAtomic,
} from "./file-store.mjs";
import { auditCollection } from "./integrity.mjs";
import { recoverExpandedToolResults } from "./expanded-tool-results.mjs";
import { fetchCursorPages } from "./pagination.mjs";

function nowIso() {
  return new Date().toISOString();
}

const AGENT_TYPES = new Set(["ida", "aide_solo", "aide_mix"]);
const DAY_MS = 24 * 60 * 60 * 1_000;
// Sophon rejects Session list windows greater than 30 days. Stay one second
// below the boundary so inclusive endpoint handling cannot exceed the limit.
const SESSION_LOOKUP_WINDOW_MS = 30 * DAY_MS - 1_000;
const SESSION_LOOKBACK_WINDOWS = 12;

function assertIdentifier(value, name) {
  const text = String(value ?? "").trim();
  if (!text || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new TraceIngestionError(`${name} 格式非法`, {
      code: "INVALID_IDENTIFIER",
      details: { name },
    });
  }
  return text;
}

function selectSession(payload, sessionId) {
  const sessions = payload?.data?.sessions;
  if (!Array.isArray(sessions)) {
    throw new TraceIngestionError("Session list 响应缺少 data.sessions", {
      code: "INVALID_SESSION_RESPONSE",
    });
  }
  const matches = sessions.filter(
    (session) => String(session.sessionId) === sessionId,
  );
  if (matches.length !== 1) {
    throw new TraceIngestionError(
      `期望找到 1 个 Session，实际找到 ${matches.length} 个`,
      {
        code: matches.length ? "AMBIGUOUS_SESSION" : "SESSION_NOT_FOUND",
        details: { sessionId, count: matches.length },
      },
    );
  }
  return matches[0];
}

function matchingSessions(payload, sessionId) {
  const sessions = payload?.data?.sessions;
  if (!Array.isArray(sessions)) {
    throw new TraceIngestionError("Session list 响应缺少 data.sessions", {
      code: "INVALID_SESSION_RESPONSE",
    });
  }
  return sessions.filter((session) => String(session.sessionId) === sessionId);
}

async function totalBytes(directory) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(itemPath);
      else if (entry.isFile()) total += (await stat(itemPath)).size;
    }
  }
  await walk(directory);
  return total;
}

export class SophonSessionCollector {
  constructor({ client, outputRoot, logger = console, clock = nowIso, nowMs = Date.now, fetchImpl = globalThis.fetch } = {}) {
    if (!client) throw new TypeError("SophonSessionCollector requires a client");
    if (!outputRoot) throw new TypeError("SophonSessionCollector requires outputRoot");
    this.client = client;
    this.outputRoot = path.resolve(outputRoot);
    this.logger = logger;
    this.clock = clock;
    this.nowMs = nowMs;
    this.fetchImpl = fetchImpl;
  }

  async lookupSession({ outputDirectory, sessionId, agentType, pageSize, force }) {
    const sessionListPath = path.join(outputDirectory, "session/list.json");
    if (!force && (await isValidJsonFile(sessionListPath))) {
      const cached = await readJson(sessionListPath);
      if (matchingSessions(cached, sessionId).length === 1) {
        this.logger.info?.(`复用已下载文件: ${sessionListPath}`);
        return { payload: cached, strategy: "cache", windowsQueried: 0 };
      }
      this.logger.warn?.(`Session ${sessionId} 的摘要缓存未命中目标，重新查询`);
    }

    const baseArgs = [
      "session",
      "list",
      "--agent-type",
      agentType,
      "--session-id",
      sessionId,
      "--page-size",
      String(pageSize),
    ];
    const lookupDirectory = path.join(outputDirectory, "session/lookup");
    await ensureDirectory(lookupDirectory);

    // The server's default window is the cheapest path and is sufficient for
    // normal evaluation batches. Force refresh because an earlier release may
    // have cached a negative lookup under different time-window semantics.
    const recentPath = path.join(lookupDirectory, "recent.json");
    const recent = await this.client.fetchJson(recentPath, baseArgs, { force: true });
    if (matchingSessions(recent, sessionId).length === 1) {
      await writeJsonAtomic(sessionListPath, recent);
      return { payload: recent, strategy: "recent", windowsQueried: 1 };
    }

    const serverRecentStart = Number(recent?.data?.startTime);
    let previousStart = Number.isFinite(serverRecentStart) && serverRecentStart > 0
      ? serverRecentStart
      : this.nowMs() - SESSION_LOOKUP_WINDOW_MS;

    for (let index = 1; index <= SESSION_LOOKBACK_WINDOWS && previousStart > 0; index += 1) {
      const until = Math.max(0, previousStart - 1);
      const since = Math.max(0, until - SESSION_LOOKUP_WINDOW_MS);
      this.logger.info?.(`Session ${sessionId} 未在近期窗口命中，回溯窗口 ${index}/${SESSION_LOOKBACK_WINDOWS}`);
      const windowPath = path.join(lookupDirectory, `window-${String(index).padStart(3, "0")}.json`);
      const payload = await this.client.fetchJson(
        windowPath,
        [...baseArgs, "--since", String(since), "--until", String(until)],
        { force: true },
      );
      if (matchingSessions(payload, sessionId).length === 1) {
        await writeJsonAtomic(sessionListPath, payload);
        return { payload, strategy: "historical_window", windowsQueried: index + 1, since, until };
      }
      previousStart = since;
    }

    throw new TraceIngestionError(
      `在近期及${SESSION_LOOKBACK_WINDOWS}个历史窗口中未找到 Session ${sessionId}`,
      {
        code: "SESSION_NOT_FOUND",
        details: {
          sessionId,
          windowsQueried: SESSION_LOOKBACK_WINDOWS + 1,
          windowLimitDays: 30,
          maximumLookbackDays: SESSION_LOOKBACK_WINDOWS * 30,
        },
      },
    );
  }

  async collect({
    sessionId,
    agentType = "ida",
    pageSize = 200,
    paddingMs = 300_000,
    force = false,
  }) {
    const normalizedSessionId = assertIdentifier(sessionId, "sessionId");
    const normalizedAgentType = assertIdentifier(agentType, "agentType");
    if (!AGENT_TYPES.has(normalizedAgentType)) {
      throw new TraceIngestionError(
        "agentType 必须是 ida、aide_solo 或 aide_mix",
        { code: "INVALID_AGENT_TYPE" },
      );
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new TraceIngestionError("pageSize 必须为 1 到 200 的整数", {
        code: "INVALID_PAGE_SIZE",
      });
    }
    if (!Number.isInteger(paddingMs) || paddingMs < 0) {
      throw new TraceIngestionError("paddingMs 必须为非负整数", {
        code: "INVALID_PADDING",
      });
    }

    const outputDirectory = path.join(this.outputRoot, normalizedSessionId);
    if (force) await removePath(outputDirectory);
    await this.prepareDirectories(outputDirectory);

    const sourcePath = path.join(outputDirectory, "index/source.json");
    if (!force && (await isValidJsonFile(sourcePath))) {
      const previous = await readJson(sourcePath);
      const requested = {
        tenant: this.client.tenant ?? null,
        region: this.client.region ?? null,
        agentType: normalizedAgentType,
        pageSize,
        paddingMs,
      };
      const changed = Object.entries(requested).filter(
        ([key, value]) => (previous[key] ?? null) !== value,
      );
      if (changed.length) {
        throw new TraceIngestionError(
          "采集参数与已有断点不一致，请使用 --force 重新采集",
          {
            code: "RESUME_CONFIG_MISMATCH",
            details: {
              changed: changed.map(([key]) => key),
              sourcePath,
            },
          },
        );
      }
    }

    const manifestPath = path.join(outputDirectory, "manifest.json");
    const startedAt = this.clock();
    await writeJsonAtomic(manifestPath, {
      schemaVersion: "1.0",
      status: "running",
      sessionId: normalizedSessionId,
      startedAt,
    });

    try {
      this.logger.info?.(`[1/7] 查询 Session ${normalizedSessionId}`);
      const sessionLookup = await this.lookupSession({
        outputDirectory,
        sessionId: normalizedSessionId,
        agentType: normalizedAgentType,
        pageSize,
        force,
      });
      const sessionList = sessionLookup.payload;
      const session = selectSession(sessionList, normalizedSessionId);
      const agentId = assertIdentifier(session.agentId, "agentId");
      const startTime = Number(session.startTime);
      const endTime = Number(session.endTime);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
        throw new TraceIngestionError("Session 时间范围非法", {
          code: "INVALID_SESSION_TIME_RANGE",
        });
      }
      const since = Math.max(0, startTime - paddingMs);
      const until = endTime + paddingMs;

      const source = {
        sessionId: normalizedSessionId,
        tenant: this.client.tenant ?? null,
        region: this.client.region ?? null,
        agentType: normalizedAgentType,
        agentId,
        sessionStartTime: startTime,
        sessionEndTime: endTime,
        querySince: since,
        queryUntil: until,
        paddingMs,
        pageSize,
        sessionLookup: {
          strategy: sessionLookup.strategy,
          windowsQueried: sessionLookup.windowsQueried,
          ...(sessionLookup.since !== undefined ? { since: sessionLookup.since, until: sessionLookup.until } : {}),
        },
      };
      await writeJsonAtomic(sourcePath, source);

      this.logger.info?.("[2/7] 逐页下载 Session Turn");
      const turnResult = await fetchCursorPages({
        client: this.client,
        directory: path.join(outputDirectory, "session/detail-pages"),
        itemKey: "turns",
        pageSize,
        force,
        buildArgs: ({ pageSize: size, pageToken }) => [
          "session",
          "get",
          normalizedSessionId,
          "--agent-type",
          normalizedAgentType,
          "--agent-id",
          agentId,
          "--page-size",
          String(size),
          ...(pageToken ? ["--page-token", pageToken] : []),
        ],
      });

      this.logger.info?.("[3/7] 下载 Session 统计");
      await this.client.fetchJson(
        path.join(outputDirectory, "session/stats.json"),
        [
          "session",
          "stats",
          normalizedSessionId,
          "--agent-type",
          normalizedAgentType,
          "--agent-id",
          agentId,
        ],
        { force },
      );

      this.logger.info?.("[4/7] 逐页下载全部 Span");
      const spanResult = await fetchCursorPages({
        client: this.client,
        directory: path.join(outputDirectory, "spans/list-pages"),
        itemKey: "spans",
        pageSize,
        force,
        buildArgs: ({ pageSize: size, pageToken }) => [
          "trace",
          "list",
          "--agent-type",
          normalizedAgentType,
          "--agent-id",
          agentId,
          "--since",
          String(since),
          "--until",
          String(until),
          "--all-spans",
          "--filter",
          `session_id=${JSON.stringify(normalizedSessionId)}`,
          "--page-size",
          String(size),
          ...(pageToken ? ["--page-token", pageToken] : []),
        ],
      });

      this.logger.info?.("[5/7] 构建 Trace/Span 索引");
      const traceIds = new Set();
      for (const turn of turnResult.items) {
        if (turn?.businessTraceId) traceIds.add(String(turn.businessTraceId));
      }
      if (session.latestTraceId) traceIds.add(String(session.latestTraceId));

      const spanIndex = new Map();
      for (const span of spanResult.items) {
        if (span?.traceId) traceIds.add(String(span.traceId));
        if (span?.id && span?.traceId) {
          spanIndex.set(String(span.id), String(span.traceId));
        }
      }

      await writeJsonAtomic(
        path.join(outputDirectory, "index/turns.json"),
        turnResult.items,
      );
      await writeTextAtomic(
        path.join(outputDirectory, "index/trace-ids.txt"),
        [...traceIds].sort().map((id) => `${id}\n`).join(""),
      );
      await writeTextAtomic(
        path.join(outputDirectory, "index/spans.tsv"),
        [...spanIndex.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([spanId, traceId]) => `${spanId}\t${traceId}\n`)
          .join(""),
      );

      this.logger.info?.(`[6/7] 下载 ${traceIds.size} 个 Trace Tree`);
      const traceTreeFiles = new Map();
      for (const traceId of [...traceIds].sort()) {
        const filePath = path.join(
          outputDirectory,
          "traces/trees",
          `${safeFileName(traceId)}.json`,
        );
        await this.client.fetchJson(
          filePath,
          [
            "trace",
            "tree",
            traceId,
            "--agent-type",
            normalizedAgentType,
            "--agent-id",
            agentId,
            "--since",
            String(since),
            "--until",
            String(until),
            "--include-input-output",
          ],
          { force },
        );
        traceTreeFiles.set(traceId, filePath);
      }

      this.logger.info?.(`[7/7] 下载 ${spanIndex.size} 个 Span Detail`);
      const spanDetailFiles = new Map();
      for (const [spanId, traceId] of [...spanIndex.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const filePath = path.join(
          outputDirectory,
          "spans/details",
          `${safeFileName(spanId)}.json`,
        );
        await this.client.fetchJson(
          filePath,
          [
            "trace",
            "get",
            spanId,
            "--trace-id",
            traceId,
            "--agent-type",
            normalizedAgentType,
            "--agent-id",
            agentId,
            "--since",
            String(since),
            "--until",
            String(until),
          ],
          { force },
        );
        spanDetailFiles.set(spanId, filePath);
      }

      const expandedToolResults = await recoverExpandedToolResults({
        outputDirectory,
        spanDetailFiles,
        fetchImpl: this.fetchImpl,
        force,
        logger: this.logger,
      });

      const integrity = await auditCollection({
        outputDirectory,
        expandedToolResults,

        sessionSummary: session,
        turns: turnResult.items,
        turnPages: turnResult.pages,
        spans: spanResult.items,
        spanPages: spanResult.pages,
        traceTreeFiles,
        spanDetailFiles,
      });
      integrity.createdAt = this.clock();
      await writeJsonAtomic(
        path.join(outputDirectory, "integrity-report.json"),
        integrity,
      );

      const completedAt = this.clock();
      const manifest = {
        schemaVersion: "1.0",
        status: integrity.complete ? "completed" : "completed_with_warnings",
        sessionId: normalizedSessionId,
        agentType: normalizedAgentType,
        agentId,
        startedAt,
        completedAt,
        source,
        counts: integrity.counts,
        integrity: {
          result: integrity.result,
          complete: integrity.complete,
          warnings: integrity.warnings,
          reportPath: "integrity-report.json",
        },
        artifacts: {
          sessionList: "session/list.json",
          sessionDetailPages: "session/detail-pages/",
          sessionStats: "session/stats.json",
          spanListPages: "spans/list-pages/",
          spanDetails: "spans/details/",
          traceTrees: "traces/trees/",
          traceIndex: "index/trace-ids.txt",
          spanIndex: "index/spans.tsv",
          turnIndex: "index/turns.json",
        },
        bytes: { total: await totalBytes(outputDirectory) },
      };
      await writeJsonAtomic(manifestPath, manifest);
      return { outputDirectory, manifest, integrity };
    } catch (error) {
      await writeJsonAtomic(manifestPath, {
        schemaVersion: "1.0",
        status: "failed",
        sessionId: normalizedSessionId,
        startedAt,
        failedAt: this.clock(),
        error: {
          name: error.name,
          code: error.code ?? "UNKNOWN_ERROR",
          message: error.message,
          details: error.details,
        },
      });
      throw error;
    }
  }

  async prepareDirectories(outputDirectory) {
    for (const relativePath of [
      "session/detail-pages",
      "session/lookup",
      "spans/list-pages",
      "spans/details",
      "traces/trees",
      "expanded-tool-results",
      "index",
    ]) {
      await ensureDirectory(path.join(outputDirectory, relativePath));
    }
  }
}
