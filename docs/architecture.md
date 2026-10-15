# TraceLens：项目结构

本文根据当前源码与入口整理。这里描述可从代码确认的结构；真实 Sophon 采集、模型判断质量和报告因果正确性仍取决于运行环境与逐案证据。

## 定位与边界

TraceLens 是本地运行的 Agent Trace 调查工具。线上负向反馈与离线评测失分分别进入不同工作流，最终都产出带原始证据位置、校验状态和未决问题的报告。模型提出结构化调查动作，应用执行只读 Trace 工具、记录 Evidence Ledger，并以程序规则约束完成条件。离线通道不重评答案；反馈通道不制造 GT。

## 完整目录地图

| 路径 | 职责与主要入口 |
|---|---|
| `src/ingestion/sophon-trace/` | Sophon CLI 客户端、Session/Turn/Tree/Span 分页采集，反馈 Episode 选择性补拉，完整性与截断判断；公开入口 `index.mjs`。 |
| `src/providers/` | Sophon、OpenAI、Anthropic 模型协议封装；是否可用于某条正式调查链由调用方决定。 |
| `src/rca/` | Case 合同、Scoring Gap、TraceRepository、只读 Tool、Evidence Ledger、调查状态、覆盖/因果/引用校验、Checkpoint 和报告；`index.mjs` 暴露正式入口。 |
| `src/rca/scenarios/` | 反馈专属的时间线语境、调查循环与报告渲染；复用 RCA 证据与校验组件。 |
| `src/workflows/trace-rca/` | 离线单 Session 和评测 CSV 的输入预检、答案解析、未命中 GT 拆分、Session 并发、Manifest 与失败隔离。 |
| `src/workflows/online-feedback/` | 负向反馈筛选、历史载入、反馈锚点、单条与分批工作流；按 Session 并行、同 Session 串行。 |
| `src/workflows/csv.mjs` | 两条工作流共用的 CSV 解析与序列化。原模块路径保留转发，避免改变现有导入方。 |
| `src/web/` | `server.mjs` 提供本地 HTTP/API；`job-store.mjs` 管理任务、子进程、输入快照和 Attempt；其余模块投影进度、诊断、报告树与复跑状态。`public/` 是静态工作台和 TraceLens 品牌资产。 |
| `scripts/` | Web 调用的正式 CLI、单独的采集/RCA 入口，以及诊断、重审与离线研究脚本；目录内脚本并非全部是产品入口。 |
| `skills/` | 可独立调用的满分预过滤 Skill。 |
| `examples/`、`test/` | 脱敏输入模板、固定回归样例和离线测试。 |
| `docs/`、`.github/workflows/` | 架构、报告合同、存储、品牌文档与 Node CI。 |
| `data/raw/`、`data/input/`、`outputs/`、`test_data/` | 本地采集、用户输入、运行产物和固定数据；由 `.gitignore` 排除，不属于发布源码。 |

## 端到端调用链

```text
本地 Web / CLI
  ├─ 反馈：server → WebJobStore → run-feedback-workflow CLI
  │         → online-feedback/workflow → 时间线/反馈锚点 → 选择性 Episode
  │         → rca/scenarios/online-feedback → Evidence Ledger → feedback-report
  │
  └─ 评测：server → WebJobStore → run-trace-rca-session/csv CLI
            → trace-rca/workflow → 输入预检/答案绑定/完整 Trace
            → 每个未命中 GT 的 runRcaCase → Evidence Ledger → rca-report
```

两个批量入口都以 Session 为并发单位，确保一个 Session 内的案例串行处理。Web Job 持久化输入快照、进度、日志和独立 Attempt；工作流持久化 Manifest；RCA 持久化证据账本与 Checkpoint。页面读这些产物，业务调查不在浏览器中执行。

### 反馈链的关键步骤

1. `negative-feedback-filter.mjs` 可从原始反馈 CSV 中筛负向候选；`feedback-batch.mjs` 也可直接读取候选 CSV。
2. `timeline-snapshot.mjs` 校验历史分页、身份和时间线；`feedback-anchor-resolver.mjs` 定位对应反馈，重复文本可用请求关联 ID 消歧。
3. `workflow.mjs` 复用本地历史与 Trace，必要时从 Sophon 取得缺失历史并按反馈前依赖补拉 Episode；`fetch-feedback-episode.mjs` 限定采集范围。
4. `runOnlineFeedbackCase` 只调查反馈前可观察的要求、工具和交付，验证原始引用与因果闭合，写 `feedback-report.md`。无法唯一定位反馈时输出明确的未决状态。

### 评测链的关键步骤

1. `csv-input.mjs` 与 `evaluation-input.mjs` 读取评测输入，分离满分项、源任务失败、评测输入问题和可归因项。
2. `session-trace.mjs` 取得或复用完整 Session Trace；`answer-resolver.mjs` 核对真正被评分的答案或发布产物。
3. `case-builder.mjs` 按每个明确未命中的 GT 建 Case；`orchestrator.mjs` 调用模型生成 Scoring Gap 和只读 JSON Actions，程序执行 Trace 工具。
4. 覆盖、EV 引用、原文 Hash、搜索重放、报告开头与因果置信度检查通过后写 `rca-report.md`；失败保留摘要和可用 Checkpoint。

## 状态与证据机制

- `TraceRepository` 将本地原始文件建立为可检索的只读证据视图；部分 Trace 会带范围与缺口，局部无命中不能推断整个 Session 没有该事实。
- `EvidenceLedger` 保存 EV 编号、Span/字段、原文偏移和摘要；报告引用必须能回到这份账本与原始数据。
- `checkpoint.mjs` 保留调查状态；`workflow-manifest.json` 记录每项处理结果；Web 的 Job/Attempt 只管理任务和产物，不替代 RCA 完成判断。
- 生成报告、证据校验通过和根因已证实是不同概念。仅定位症状或候选机制时，报告按[逐案模板](analysis-report-template.md)明确标记。

## 冗余审查与处理

| 发现 | 源码证据 | 本次处理 / 判断 |
|---|---|---|
| 两条工作流各有一份实质相同的 RFC 4180 CSV codec | 原 `trace-rca/csv-input.mjs` 与 `online-feedback/csv.mjs` | 合并到 `src/workflows/csv.mjs`，原导入路径转发；保留各自的业务列校验。 |
| ORIGO 仍占据活动 logo 文件名和说明，但 Web/README 已改用 TraceLens | `src/web/public/index.html`、`README.md` 与原 `assets/logo-*.svg` | 将旧资产与预览归档在 `legacy/origo-wordmark/`，活动品牌仅保留 TraceLens logo 与 mark。 |
| `styles.css` 与 `tracelens.css` 有层叠覆盖 | `src/web/public/index.html` 同时加载两张样式表 | 这是可维护性候选问题；本次未机械合并，需逐页视觉回归后再归并，避免覆盖规则改变页面。 |
| `feedback:analyze` 和 `workflow:feedback` 都可启动反馈调查 | `scripts/analyze-online-feedback.mjs`、`scripts/run-feedback-workflow.mjs` | 前者支持明确本地 Trace/历史与 Checkpoint Resume，后者负责自动准备和 Web 统一产物；用途不同，保留并在 README 区分。 |
| 两条工作流各有 Session 并发与 Manifest 代码 | `trace-rca/workflow.mjs`、`online-feedback/feedback-batch.mjs` | 共享调度抽象可能减少代码，但状态和失败语义不同；当前没有可证实的安全删除范围，留作后续重构。 |

本次只清理能够确定的重复实现和过期活动品牌文件。`legacy/` 是历史设计归档，不参与 Web 加载。

## 运行边界

Web 默认仅监听本机，没有用户登录、RBAC、数据库或跨 Job 全局配额。真实采集依赖 Sophon CLI 登录；Live RCA 依赖可用的模型服务。OpenAI/Anthropic Provider 存在于代码中，不代表正式调查链已对所有 Provider 做端到端联调。离线测试覆盖解析、编排和校验规则，不替代真实服务或因果结论验证。

部署、API 与复跑细节分别见 [`src/web/README.md`](../src/web/README.md)、[`src/workflows/trace-rca/README.md`](../src/workflows/trace-rca/README.md)、[`src/rca/README.md`](../src/rca/README.md) 和 [`retry-and-storage.md`](retry-and-storage.md)。
