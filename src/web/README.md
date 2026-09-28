# Trace RCA Web Console

第一版 Web 工作台是现有全链路模块的薄界面，不复制 RCA 业务逻辑：

```text
Browser
  -> src/web/server.mjs
  -> WebJobStore（任务目录、进程和产物索引）
  -> scripts/run-trace-rca-session.mjs / run-trace-rca-csv.mjs
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

- 首页提供两个独立产品入口；单 Session 与批量 CSV 使用各自独立页面，不在同一提交窗口切换；
- 单 Session 输入：Session ID、Query、GT、分数、机评结果、IDA 答案；
- CSV 上传，复用现有默认列映射；
- CSV 在 Trace 拉取前自动跳过评分数值严格等于 `1` 的满分题，并在 Manifest 中保留筛选记录；
- Live/Offline 模式和 `maxRounds`；
- CSV 可配置 `1–16` 个 Session 并发（默认3）；不同 Session 并行，同一 Session 内串行；
- 复用本地完整 Trace，或显式选择重新拉取；
- 长任务后台运行，浏览器刷新不影响子进程；
- 提供独立“报告”入口，按批次时间 → Session → GT 展示阶段进度、Agent 审计事件、运行日志、失败摘要、验证文件和最终报告；
- 每个 Job 持久化 `web-job.jsonl`，记录创建、启动、stdout/stderr、退出、诊断、复跑和取消事件；服务级请求日志写入 `outputs/web-console/web-server.jsonl`；
- Web 会生成 `web-failure-summary.md` 和 `web-failure-diagnosis.json`，优先展示失败阶段、输入行号、错误码、影响和处理建议；
- 运行中任务可停止；
- Web 服务重启后读取历史 Job；中断任务会标记失败，已存在的 RCA Checkpoint 仍可按失败摘要通过 CLI 恢复；
- 失败任务支持“仅重跑失败项”和“完整重跑”，每次创建独立 Attempt，不覆盖历史日志；
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
