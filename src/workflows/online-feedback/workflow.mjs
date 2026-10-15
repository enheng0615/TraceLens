import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadFeedbackTimeline } from "./timeline-snapshot.mjs";
import { resolveFeedbackAnchor } from "./feedback-anchor-resolver.mjs";
import { runOnlineFeedbackCase } from "../../rca/scenarios/online-feedback.mjs";
import { renderFeedbackReportMarkdown } from "../../rca/scenarios/feedback-report-renderer.mjs";
import { RunLogger } from "../../rca/run-logger.mjs";
import { PiJsonAgent } from "../../rca/pi-json-agent.mjs";
import { SophonCliClient } from "../../ingestion/sophon-trace/sophon-cli-client.mjs";
import { SophonSessionCollector } from "../../ingestion/sophon-trace/fetch-session.mjs";
import { fetchCursorPages } from "../../ingestion/sophon-trace/pagination.mjs";
import { collectFeedbackEpisode } from "../../ingestion/sophon-trace/fetch-feedback-episode.mjs";
import { writeJsonAtomic, writeTextAtomic } from "../../ingestion/sophon-trace/file-store.mjs";

async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

/** Acquire raw Turn pages only. Detailed Trace is fetched later for the selected episode. */
export async function prepareFeedbackTimeline({ sessionId, outputDir, client, agentId, agentType = "ida" }) {
  if (!new Set(["ida", "aide_solo", "aide_mix"]).has(agentType)) throw new Error("不支持的 agentType");
  const collector = new SophonSessionCollector({ client, outputRoot: outputDir });
  const lookup = await collector.lookupSession({ outputDirectory: outputDir, sessionId, agentType, agentIdHint: agentId, pageSize: 200, force: false, maxLookbackWindows: Infinity });
  const matches = lookup.payload?.data?.sessions?.filter((s) => String(s.sessionId) === sessionId) ?? [];
  if (matches.length !== 1 || !/^[A-Za-z0-9._:-]+$/.test(String(matches[0].agentId ?? ""))) throw new Error("未能确认 Session 的 Agent 路由");
  await fetchCursorPages({ client, directory: path.join(outputDir, "session/detail-pages"), itemKey: "turns", maxPages: Infinity,
    buildArgs: ({ pageSize, pageToken }) => ["session", "get", sessionId, "--agent-type", agentType, "--agent-id", String(matches[0].agentId), "--page-size", String(pageSize), ...(pageToken ? ["--page-token", pageToken] : [])] });
  const loaded = await loadFeedbackTimeline(outputDir, sessionId);
  if (loaded.coverage.identity.agentId !== String(matches[0].agentId) || loaded.coverage.identity.agentType !== agentType) throw new Error("Session历史与查询路由身份不一致");
  return loaded;
}

/** Shared CLI/Web workflow; feedback is investigated without an evaluation GT. */
export async function runFeedbackWorkflow({ input, workflowOutputRoot, traceOutputRoot, projectRoot = process.cwd(), maxRounds = 12,
  maxTurns = 24, ingestion = {}, agentFactory = (logger) => new PiJsonAgent({ logger }), client, runCase = runOnlineFeedbackCase, logger = console }) {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!/^\d+$/.test(sessionId) || !String(input.requestQuery ?? "").trim()) throw new Error("请提供数字 Session ID 和负向反馈原文");
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 200 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error("调查轮数或历史窗口上限无效");
  const workflowId = `feedback-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(workflowOutputRoot, workflowId);
  const manifestPath = path.join(outputDir, "workflow-manifest.json");
  const rcaOutputDir = path.join(outputDir, "sessions", `session-${sessionId}`, "feedback", "analysis");
  const item = { sessionId, criterionId: "反馈分析", scenario: "online-feedback", stage: "timeline", status: "running", rcaOutputDir };
  const manifest = { schemaVersion: "online-feedback-workflow-v1", workflowId, scenario: "online-feedback", startedAt: new Date().toISOString(), status: "running",
    configuration: { maxRounds, maxTurns }, counts: { criteria: 1, plannedCriteria: 1, totalWorkUnits: 1, completed: 0, failed: 0 }, items: [item] };
  await mkdir(outputDir, { recursive: true });
  const save = () => writeJsonAtomic(manifestPath, manifest);
  await save();
  try {
    logger.info?.("[1/4] 定位反馈与历史要求");
    const candidates = input.timelineRoot ? [path.resolve(input.timelineRoot)] : [
      path.resolve(projectRoot, "data/raw/sophon-session-turns", sessionId), path.resolve(traceOutputRoot, sessionId),
    ];
    let timelineRoot;
    for (const root of candidates) if (await exists(path.join(root, "session/detail-pages"))) { timelineRoot = root; break; }
    if (input.timelineRoot && !timelineRoot) throw new Error("指定的历史快照目录不存在");
    const sophon = client ?? new SophonCliClient({ ...ingestion, timeoutMs: null, retries: Infinity, logger });
    let loaded = timelineRoot ? await loadFeedbackTimeline(timelineRoot, sessionId) : await prepareFeedbackTimeline({ sessionId,
      outputDir: path.join(outputDir, "source"), client: sophon, agentId: input.agentId ?? ingestion.agentId, agentType: input.agentType ?? ingestion.agentType ?? "ida" });
    timelineRoot ??= path.join(outputDir, "source");
    const candidate = { sessionId, requestQuery: input.requestQuery, ...(input.requestIdList ? { requestIdList: input.requestIdList } : {}) };
    let anchor = resolveFeedbackAnchor(loaded.timeline, candidate);
    if (anchor.status === "not_found" && !input.timelineRoot && input.fetchMissing !== false && timelineRoot !== path.join(outputDir, "source")) {
      logger.info?.("[1/4] 本地历史未定位到反馈，刷新Session时间线");
      timelineRoot = path.join(outputDir, "source");
      loaded = await prepareFeedbackTimeline({ sessionId, outputDir: timelineRoot, client: sophon,
        agentId: input.agentId ?? loaded.coverage.identity.agentId, agentType: input.agentType ?? loaded.coverage.identity.agentType ?? "ida" });
      anchor = resolveFeedbackAnchor(loaded.timeline, candidate);
    }
    const { timeline, coverage } = loaded;
    const ordinal = anchor.feedbackAnchor?.ordinal;
    const traceCandidates = input.traceRoot ? [path.resolve(input.traceRoot)] : [
      path.resolve(traceOutputRoot, sessionId),
      path.resolve(projectRoot, "data/raw/sophon-selective", sessionId, `feedback-turn-${String(ordinal).padStart(4, "0")}`, "prior-up-to-8"),
    ];
    let traceRoot;
    for (const root of traceCandidates) if (await exists(path.join(root, "spans/details"))) { traceRoot = root; break; }
    if (input.traceRoot && !traceRoot) throw new Error("指定的本地 Trace 目录不存在或缺少 spans/details");
    traceRoot ??= path.join(outputDir, "missing-trace");
    manifest.source = { sessionId, timelineRoot, traceRoot, timelineCoverage: coverage };
    item.stage = "investigation"; await save();
    logger.info?.("[2/4] 核对工具参数、历史定义与下游证据");
    const runLogger = new RunLogger(rcaOutputDir);
    await runLogger.initialize({ runId: workflowId, sessionId, startedAt: manifest.startedAt });
    const collectEpisode = input.fetchMissing === false ? undefined : async (episode) => {
      if (!coverage.identity.agentId || !coverage.identity.agentType) throw new Error("补拉 Trace 需要历史快照中已核实的 agentId / agentType");
      return collectFeedbackEpisode({ episode, identity: coverage.identity, client: sophon,
        cacheRoot: path.resolve(projectRoot, "data/raw/sophon-feedback-cache") });
    };
    const result = await runCase({ candidate, timeline, timelineCoverage: coverage, traceRoot, outputDir: rcaOutputDir,
      agent: agentFactory(runLogger), maxRounds, maxTurns, collectEpisode });
    logger.info?.("[3/4] 生成结论并核验引用");
    item.stage = "complete";
    item.status = ["unresolved", "anchor_unresolved"].includes(result.status) ? "completed_with_evidence_gaps" : "completed";
    item.feedbackAssessment = result.report?.feedbackAssessment ?? "unresolved";
    item.causalInvestigationStatus = result.causalInvestigationStatus ?? "unresolved";
    item.problemClassification = result.report?.problemClassification ?? null;
    if (!result.report) {
      // An ambiguous/missing feedback anchor is an explicit report outcome, not a fake RCA.
      await mkdir(rcaOutputDir, { recursive: true });
      await writeTextAtomic(path.join(rcaOutputDir, "feedback-report.md"), renderFeedbackReportMarkdown({ ...result, report: {
        executiveSummary: `当前历史快照中无法唯一定位这条反馈（${result.anchor?.status ?? "unknown"}），尚未开展根因调查。请核对反馈原文，重复文本可提供请求关联ID。`,
        feedbackAssessment: "unresolved", problemClassification: { category: "反馈定位未完成", rationale: "未确认反馈轮次，无法建立反馈前的调查边界。" },
        evidenceBoundary: { confirmed: "已检查可用的历史时间线。", notProven: "尚未确认反馈目标及其原因。" },
      } }));
    }
    manifest.status = item.status; manifest.counts.completed = 1;
    manifest.finishedAt = new Date().toISOString(); await save();
    await writeTextAtomic(path.join(outputDir, "workflow-summary.md"), `# 负向反馈分析\n\nSession：${sessionId}\n\n${result.report?.executiveSummary ?? "反馈尚未定位，详见分析报告。"}\n`);
    logger.info?.("[4/4] 负向反馈报告已生成");
    return { ...manifest, outputDir, manifestPath };
  } catch (error) {
    item.status = "failed"; item.error = { code: error.code ?? "FEEDBACK_ANALYSIS_FAILED", message: error.message, remediation: "检查反馈原文、历史快照及 Sophon 访问配置，修复后重跑。" };
    manifest.status = "failed"; manifest.counts.failed = 1; manifest.finishedAt = new Date().toISOString();
    await save(); throw error;
  }
}
