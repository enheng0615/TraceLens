# 负向反馈工作流

该目录把用户负向反馈转换为有时间边界的 Trace 调查。反馈原文是待核验的主张，不是 GT；工作流只读取反馈发生前相关的历史与执行证据。

## 入口

| 入口 | 用途 |
|---|---|
| `workflow.mjs` / `runFeedbackWorkflow` | 单条反馈：准备时间线、定位反馈、复用或选择性采集 Trace、调用调查场景、持久化 Manifest。 |
| `feedback-batch.mjs` / `runFeedbackBatchWorkflow` | CSV 批次：按 Session 分组并行，同 Session 内串行，逐条记录结果和失败。 |
| `negative-feedback-filter.mjs` | 从原始标注文件筛选负向事件，保留源行和候选关联。 |
| `timeline-snapshot.mjs` | 校验 Session 历史分页、身份与时间线。 |
| `feedback-anchor-resolver.mjs` | 稳定转发反馈定位能力，供工作流与现有调用方使用。 |
| `episode-planner.mjs` | 划定反馈前的相关 Turn 与 Trace 范围。 |
| `csv.mjs` | 兼容导入路径，实际 CSV codec 在 `../csv.mjs`。 |

Web 经 `src/web/job-store.mjs` 调用 `scripts/run-feedback-workflow.mjs` 或 `scripts/run-feedback-batch-workflow.mjs`。CLI 与 Web 共用上述业务入口。

## 输入与结果

单条输入至少需要数字形式的 `sessionId` 与非空 `requestQuery`。重复原文可附 `requestIdList`。可指定 `timelineRoot`、`traceRoot` 或 `fetchMissing=false` 限制读取范围。批量 CSV 至少需要 `session_id,request_query`，可包含 `label,request_id_list,task_id`。

单条结果在 `workflows/feedback-*/sessions/session-<id>/feedback/analysis/` 下保留 `feedback-report.md`、结构化结果、Evidence Ledger、校验与 Agent 日志。批量结果另有 `workflow-manifest.json`，每条反馈保留独立状态。未能唯一定位反馈或证据不足时，报告明确标记未决，不补造 GT 或根因。

## 与离线评测的关系

反馈工作流复用 `src/rca/` 的 TraceRepository、Evidence Ledger、Checkpoint 与报告校验。离线评测工作流需要现成评分、GT 和明确未命中项，且通常核对完整 Session Trace；反馈工作流以反馈时间限定观察窗口，并按需补拉选定 Episode。因此两者共享证据底座，但输入合同、调查范围和结果状态不同。
