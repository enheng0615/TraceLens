# TraceLens Web Console

本地 Web 工作台是现有全链路模块的薄界面，不复制 RCA 业务逻辑：

```text
Browser
  -> src/web/server.mjs
  -> WebJobStore（任务目录、进程和产物索引）
  -> scripts/run-trace-rca-session.mjs / run-trace-rca-csv.mjs / run-feedback-workflow.mjs / run-feedback-batch-workflow.mjs
  -> ingestion + workflows + RCA
```

## 启动

在项目根目录运行：

```bash
npm run web
```

浏览器访问：

```text
http://127.0.0.1:4317
```

可选环境变量：

```text
TRACE_WEB_HOST=127.0.0.1
TRACE_WEB_PORT=4317
TRACE_WEB_OUTPUT_ROOT=outputs/web-console
TRACE_OUTPUT_ROOT=data/raw/sophon-sessions
```

默认只监听本机。当前版本没有登录和权限系统，不应直接绑定公网或公司共享地址；多人使用前应增加 SSO、RBAC、任务队列、并发上限和数据保留策略。

## 已支持

- 工作台分为负向反馈、离线题集两个通道；负向反馈可选单条或批量处理，离线题集可选单 Session 或批量 CSV；
- 负向反馈只需 Session ID 与用户反馈原文，不需要 GT 或机评结果；请求关联ID、历史窗口、数据目录放在高级选项；
- 批量反馈可上传候选 CSV，或指定本机五类原始反馈文件目录；每批最多 150 个唯一 Session，批次结束后可在详情页点击“继续下一批”，沿用上批输入快照并自动选取后续 Session；同一 Session 内串行，不同 Session 可并行，逐条保留状态与报告；
- 反馈任务默认复用本地历史与 Trace；未找到历史时查询 Sophon Session 分页，缺少详细执行记录时按反馈前的依赖选择性采集；
- 任务可筛选类型与状态；报告支持复制、下载以及 URL 深链接，刷新可回到当前任务；
- 单 Session 输入：Session ID、Query、GT、分数、机评结果、IDA 答案；
- CSV 上传，复用现有默认列映射；
- CSV 在 Trace 拉取前自动跳过评分数值严格等于 `1` 的满分题，并在 Manifest 中保留筛选记录；
- CSV 在 Trace 拉取前执行评测输入预检；无有效score、无GT、无未命中项或评分器错误会显示具体“评测输入问题”，不计为RCA失败，也不允许直接复跑原输入快照；
- Live/Offline 模式和 `maxRounds`；
- CSV 可配置 `1–16` 个 Session 并发（默认3）；不同 Session 并行，同一 Session 内串行；
- 复用本地完整 Trace，或显式选择重新拉取；
- 长任务后台运行，浏览器刷新不影响子进程；
- 提供独立“报告”入口，按批次时间 → Session → GT 展示阶段进度、Agent 审计事件、运行日志、失败摘要、验证文件和最终报告；
- 每个 Job 持久化 `web-job.jsonl`，记录创建、启动、stdout/stderr、退出、诊断、复跑和取消事件；服务级请求日志写入 `outputs/web-console/web-server.jsonl`；
- Web 会生成 `web-failure-summary.md` 和 `web-failure-diagnosis.json`，优先展示失败阶段、输入行号、错误码、影响和处理建议；
- 运行中任务可停止；
- Web 服务重启后读取历史 Job；中断任务会标记失败，已存在的 RCA Checkpoint 仍可按失败摘要通过 CLI 恢复；
- 批次支持“仅重跑失败项”“指定 Session 重跑”和“完整重跑”，每次创建独立 Attempt，不覆盖历史日志；
- 批次复跑可按 Session/GT 勾选失败项，并展示跨 Attempt 的有效结果汇总。

## 数据目录

```text
outputs/web-console/jobs/<job-id>/
├── job.json                            # Web任务状态、Attempt lineage，不含模型密钥
├── retry-plan.json                     # 仅复跑任务存在
├── input/                              # 本次不可变输入快照
└── workflows/
    └── batch-<ISO-time>-<id>/           # 一个批次/Attempt
        ├── workflow-manifest.json
        ├── workflow-summary.md
        └── sessions/
            └── session-<session-id>/
                ├── session-summary.json
                └── gt/
                    └── <criterion-id>-<case-hash>/
                        ├── case.json
                        ├── rca-report.md 或 failure-summary.md
                        ├── agent-run.md
                        ├── agent-run-summary.md
                        └── validation.json
```

每个复跑 Attempt 会创建新的 Job 和新的 `batch-*` 目录，不覆盖原批次。Web 同时兼容旧版扁平 `rca-runs` 目录，并将其投影为相同的 Session/GT 报告树。

`.env` 只由服务端进程读取，健康接口仅返回“是否已配置”，不会向浏览器返回 API Key。

Web日志只记录任务元数据和脱敏后的运行事件，不记录CSV正文、Query、GT、机评内容、IDA答案、JWT、API Key、Authorization或Cookie。

## 当前边界

这是本地可运行实例，不是最终多人平台：

- 任务状态保存在 JSON 文件，没有数据库；
- 单个CSV工作流已有Session级受控并发；Web层尚未实现跨多个Job共享配额的全局并发队列；
- 停止任务使用 `SIGTERM`，已生成的日志和 Checkpoint 保留；
- Web 提供新 Attempt 复跑；同一 Attempt 的 Checkpoint Resume 暂时仍使用失败摘要中的 CLI 命令；
- Markdown 报告采用安全的最小本地渲染，不加载第三方脚本。

完整的存储、失败处理、Retry/Resume 语义见 [`docs/retry-and-storage.md`](../../docs/retry-and-storage.md)。

## 负向反馈 API

```http
POST /api/jobs/feedback
Content-Type: application/json

{
  "sessionId": "32587255",
  "requestQuery": "用户当时发送的反馈原文",
  "maxRounds": 12,
  "maxTurns": 24,
  "fetchMissing": true
}
```

成功返回 HTTP 202 与 `{job}`。可选 `requestIdList` 用于重复原文消歧；`agentId` / `agentType` 用于Session路由；`timelineRoot` / `traceRoot` 可指定已有本地数据。默认本地历史目录为 `data/raw/sophon-session-turns/<id>` 或现有完整Trace缓存；自动下载的历史保存在本次工作流的 `source/`，选择性Trace缓存按路由隔离。Sophon配置来自服务端 `.env` 的 `SOPHON_INGESTION_REGION`、`SOPHON_INGESTION_TENANT` 和账号变量。

复用已有 `GET /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`、`POST /api/jobs/:id/retry` 和 `GET /api/jobs/:id/artifact?path=...`。单条反馈支持完整重跑及失败重跑，每次创建新目录并保留输入快照及父任务关联。反馈原文不进入任务列表和 Web 审计日志。

反馈报告归档于 `workflows/feedback-*/sessions/session-<id>/feedback/analysis/`，包含 `feedback-report.md`、`feedback-result.json`、`evidence-ledger.json`、校验文件及Agent日志。导航项称为“反馈分析”，不伪造评测GT。报告生成完成和根因确认是不同状态；`feedbackSummary` 返回反馈判断、根因调查状态与问题归类。无法唯一定位反馈也会生成明确的未决说明。

`feedback-report.md` 与 `rca-report.md` 采用同一套 [逐案分析报告模板](../../docs/analysis-report-template.md) 开头，随后分别解释反馈路径或评分差距的传播过程。

### 批量负向反馈

```http
POST /api/jobs/feedback-batch
Content-Type: application/json

{
  "fileName": "negative-feedback.csv",
  "csvText": "session_id,request_query,label\n32587255,回答不准确,negative",
  "sessionStart": 1,
  "sessionCount": 10,
  "concurrency": 3,
  "maxRounds": 12,
  "maxTurns": 24
}
```

也可传 `sourceDir` 指向 Web 服务所在机器的五类原始反馈 CSV 目录，服务端先筛选负向候选，并把筛选结果保存在 Job 的 `input/filtered/`；`sourceDir` 与 `csvText` 二选一。CSV 必需列为 `session_id,request_query`，可选 `label,request_id_list,task_id`；有 `label` 时只处理 `negative`、`负向`、`负面`。`task_id` 和 `request_id_list` 都参与候选去重，避免同文不同请求混组。

上传限制 20 MB，所选批次最多 500 条反馈；`sessionStart` 从 1 开始，按筛选器的文件排序和文件内行顺序编号，`sessionCount` 为 1–150，`concurrency` 为 1–16。响应为 HTTP 202 与 `{job}`，`job.inputSummary` 包含 `totalSessions`、`selectedSessions`、`candidates`、`nextSessionStart` 和本次运行参数；`nextSessionStart=null` 表示已到末尾。任务按所选 Session 分组并行，同一 Session 的反馈串行处理。进度和逐条报告由 `GET /api/jobs/:id` 的 `manifest` 与 `reportTree` 提供。批次支持完整重跑并可调整并行线程数，失败项复跑暂未开放。

当前批次结束后，调用 `POST /api/jobs/:id/next-feedback-batch`（请求体 `{}`），或在详情页点击“继续下一批”。服务端复用上一批的候选 CSV 快照，从 `nextSessionStart` 选取相同数量的后续唯一 Session；最后一批不足时只选剩余 Session。重复请求会返回已经创建的下一批，不会再次生成相同区间。续批会创建新的 Job 和 `batchSeries` 关联；完整重跑仍是原区间的新 Attempt，不会推进批次。可选请求字段为 `sessionCount`（1–150）、`concurrency`（1–16）和 `maxRounds`（1–200）；网页默认沿用上一批设置。这里的“不重复”指同一批次链、同一输入快照内的 Session 选取；失败或取消的 Session 也占用该区间，需要完整重跑原批才能重新分析。

离线题集的批量 CSV 入口继续处理评测 CSV，不会将负向反馈 CSV 作为评测数据。
