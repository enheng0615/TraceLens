import { TERMINAL_JOB_STATUSES } from "./job-model.mjs";

const RCA_PROGRESS_START = 30;
const RCA_PROGRESS_END = 95;

function eventPhaseProgress(event, maxRounds = 20) {
  const phase = String(event?.phase ?? "");
  if (phase === "scoring_gap") return 0.06;
  if (phase === "trace_map") return 0.14;
  const round = Number.parseInt(phase.match(/investigation_round_(\d+)/)?.[1] ?? "0", 10);
  if (round > 0) return Math.min(0.92, 0.16 + (round / Math.max(1, maxRounds)) * 0.74);
  if (phase === "final_rca") return 0.97;
  if (phase === "feedback_final") return 0.97;
  const feedbackRound = Number.parseInt(phase.match(/feedback_investigation_(\d+)/)?.[1] ?? "0", 10);
  if (feedbackRound > 0) return Math.min(0.92, 0.16 + (feedbackRound / Math.max(1, maxRounds)) * 0.74);
  if (/complete/.test(phase)) return 1;
  return 0;
}

/**
 * Calculate progress across the complete workflow, not just the current RCA round.
 * Trace collection owns 0-30%; all missed-GT RCA cases share 30-95%; terminal
 * completion owns 100%. `previous` keeps polling updates monotonic.
 */
export function calculateWorkflowProgress({ job, manifest, events = [], previous = 0 } = {}) {
  if (TERMINAL_JOB_STATUSES.has(job?.status)) {
    return {
      percent: 100,
      stage: job.status,
      label: job.status === "completed" ? (job.type === "feedback-batch" ? "反馈报告已生成" : "归因报告已生成") : job.status === "completed_with_evidence_gaps" ? (["feedback", "feedback-batch"].includes(job.type) ? "反馈报告已生成，仍有未决事项" : "归因完成，Trace局部不完整") : job.status === "completed_with_failures" ? (job.type === "feedback-batch" ? "反馈分析完成，部分条目失败" : "归因完成，部分GT失败") : job.status === "completed_no_action" ? "没有需要归因的GT" : job.status === "cancelled" ? "任务已取消" : "任务失败",
    };
  }
  if (job?.status !== "running" || !manifest) return job?.progress;

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const terminalItems = items.filter((item) => ["completed", "completed_with_evidence_gaps", "failed", "skipped", "source_run_failed", "evaluation_input_issue"].includes(item.status)).length;
  const discovered = Number(manifest.counts?.criteria) || items.length;
  const planned = Number(manifest.counts?.totalWorkUnits) || Number(manifest.counts?.plannedCriteria) || discovered;
  const total = Math.max(1, planned, discovered, terminalItems);
  const activeItems = items.filter((item) => item.status === "running");
  const maxRounds = job.inputSummary?.maxRounds || manifest.configuration?.maxRounds || 20;
  const activeFractions = activeItems.map((item) => {
    const relevant = events.filter((event) =>
      (!event.criterionId || event.criterionId === item.criterionId) &&
      (!event.sessionId || event.sessionId === String(item.sessionId)),
    );
    const latest = relevant.at(-1);
    return { item, latest, fraction: eventPhaseProgress(latest, maxRounds) };
  });
  const fraction = activeFractions.reduce((sum, entry) => sum + entry.fraction, 0);
  const calculated = Math.round(RCA_PROGRESS_START + ((terminalItems + fraction) / total) * (RCA_PROGRESS_END - RCA_PROGRESS_START));
  const percent = Math.min(RCA_PROGRESS_END, Math.max(RCA_PROGRESS_START, Number(previous) || 0, calculated));
  const representative = activeFractions.reduce((best, entry) => !best || entry.fraction > best.fraction ? entry : best, null);
  const activeItem = representative?.item;
  const latest = representative?.latest;
  const activeCriterion = activeItem?.criterionId ?? null;
  const round = Number.parseInt(String(latest?.phase ?? "").match(/(?:investigation_round_|feedback_investigation_)(\d+)/)?.[1] ?? "0", 10);
  const criterionLabel = activeCriterion ? `${activeCriterion} · ` : "";
  const parallelLabel = activeItems.length > 1 ? `${activeItems.length}${job.type === "feedback-batch" ? "条反馈" : "个GT"}并行 · ` : criterionLabel;
  let stage = "preparation";
  let label = planned > 0 ? `准备归因 · ${terminalItems}/${total}项完成` : "准备归因";
  if (latest?.phase === "scoring_gap") { stage = "gap"; label = `${parallelLabel}定义评分差距`; }
  else if (latest?.phase === "trace_map") { stage = "trace_map"; label = `${parallelLabel}构建执行地图`; }
  else if (round > 0) { stage = "investigation"; label = `${parallelLabel}Trace证据调查 · ${terminalItems}/${total}项完成`; }
  else if (["final_rca", "feedback_final"].includes(latest?.phase)) { stage = "report"; label = `${parallelLabel}生成并校验报告`; }
  return { percent, stage, label };
}
