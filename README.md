<p align="center"><img src="src/web/public/assets/tracelens-logo.png" width="360" alt="TraceLens logo"></p>

<p align="center">
  沿 Agent Trace 核验证据，解释负向反馈与评测失分
</p>

# TraceLens

> 从“答错了”追到有证据支持的原因；证据不够时，明确停在未知处。

## 背景：为什么分析 Trace

Agent 的一次回答通常经过多轮决策、工具调用、数据读取和产物生成。最终答案、用户反馈或评分可以提示**结果可能存在偏差**，却很难单独说明偏差从哪里开始：是没有正确理解要求、调用工具时传错字段、工具返回了不符合预期的数据，还是后续计算和引用出了问题。Trace 记录了这些步骤及其先后关系，是把用户看到的结果追溯到具体调用、字段和原始内容的依据。

这个项目源于两类需要反复调查的问题：线上用户给出负向反馈，却未必指出了实际错误位置；离线评测标出未命中的要求，却未必解释了 Agent 如何走到这个结果。人工逐条翻阅长 Trace 容易遗漏上下文，也容易把时间相邻的现象误判为因果关系。因此我们做 TraceLens：先定位被评价的回答或交付物，再沿执行链查找最早有证据支持的偏差，核对它如何影响后续结果，并把无法验证的环节明确留作未决。

TraceLens 是一个面向 Agent 执行记录的本地调查工作台。它接受**线上负向反馈**或**离线评测结果**，定位对应 Session 和调查范围，沿模型输出、工具调用、字段与交付产物追溯偏差，生成附带原始证据位置、校验结果和未决边界的分析报告。支持单例调查、CSV 批量处理、断点恢复与失败项复跑。

模型负责提出调查动作，程序只执行白名单内的只读 Trace 操作，并检查覆盖、Evidence ID、原文位置与报告一致性。离线评测通道沿用已有评分和 Ground Truth，**不重新评分或改写 GT**；反馈通道不要求 GT，也不会把用户投诉直接当作已证实事实。

> 当前 Sophon 采集和模型联调依赖内部服务与已登录的 `sophon-cli`。离线测试、核心模块阅读和固定样例回归不需要真实凭证。

## 两类调查

| 来源 | 输入 | 调查单位 | 结果 |
|---|---|---|---|
| 线上负向反馈 | Session ID、反馈原文；重复文本可加请求关联 ID | 反馈前的相关历史与选择性 Trace | `feedback-report.md`，明确反馈是否得到支持、根因状态与证据缺口 |
| 离线评测 | 已有答案、GT、评分与机评结果，或评测 CSV | 每个明确未命中的 GT 项各建一个 Case | `rca-report.md`，解释评分差距及其可观察传播路径 |

两条通道共享 Sophon 采集、只读证据账本、模型适配、引用与报告校验，以及本地 Web 任务管理。详细调用链见 [架构与冗余审查](docs/architecture.md)。

## 核心能力

- **证据驱动**：每条结论引用真实 Trace Evidence ID，并复核原文偏移与 SHA-256。
- **按范围采集**：离线评测核对完整 Trace；反馈调查以反馈时间为边界，按依赖选择性补拉，并记录完整性缺口。
- **单 GT 调查**：每次 RCA 只处理一个官方未命中项，避免多个评分目标相互污染。
- **确定性护栏**：程序校验调查覆盖、引用、搜索重放、因果置信度和报告一致性。
- **批量编排**：支持 CSV、满分预过滤、Session 级并发、同 Session Trace 复用和失败隔离。
- **断点与复跑**：保留 Checkpoint、失败摘要与不可变 Attempt，不用伪完成报告掩盖失败。
- **本地工作台**：提供任务创建、进度、Batch → Session → 调查项报告浏览和选择性复跑。
- **多模型适配**：封装 Sophon、OpenAI 与 Anthropic Provider；当前正式 RCA 调查路径由 Sophon 结构化 JSON Action 驱动。

## 工作原理

```text
Web / CLI
  ├─ 负向反馈 → 时间线与反馈锚点 → 反馈前 Episode → 反馈调查 ┐
  └─ 离线评测 → 输入预检 → Session 完整 Trace → 按未命中 GT 调查 ┤
                                                           ↓
                                  Evidence Ledger → 确定性校验 → 报告与运行产物
```

更完整的依赖关系、两条调用链、冗余审查与运行边界见 [架构与冗余审查](docs/architecture.md)。正式逐案报告采用 [固定分析报告模板](docs/analysis-report-template.md)。

## 项目结构

```text
tracelens/
├── src/
│   ├── ingestion/sophon-trace/   # Session/Turn/Span 采集、索引、范围和完整性审计
│   ├── providers/                # 模型协议与凭证适配
│   ├── rca/                      # Case 调查、证据账本、校验、报告；scenarios/ 为反馈场景
│   ├── workflows/trace-rca/      # 离线评分差距：单 Session / CSV 编排
│   ├── workflows/online-feedback/ # 负向反馈：定位、选择性采集、单条/批次编排
│   └── web/                      # HTTP、Job/Attempt、报告树与静态工作台
├── scripts/                      # 正式 CLI 与诊断/重审工具
├── examples/                     # 输入模板和固定回归样例
├── skills/                       # 满分预过滤 Skill
├── test/                         # 离线回归测试
├── docs/                         # 架构、报告合同、存储与品牌规范
└── .github/workflows/            # CI
```

| 模块 | 稳定入口 | 说明 |
|---|---|---|
| Trace 采集 | `src/ingestion/sophon-trace/index.mjs` | [模块文档](src/ingestion/sophon-trace/README.md) |
| 模型 Provider | 各 Provider 的工厂函数 | [模块文档](src/providers/README.md) |
| RCA 领域层 | `src/rca/index.mjs` | [模块文档](src/rca/README.md) |
| 工作流 | `src/workflows/trace-rca/index.mjs` | [模块文档](src/workflows/trace-rca/README.md) |
| 负向反馈工作流 | `src/workflows/online-feedback/workflow.mjs` | [模块文档](src/workflows/online-feedback/README.md) |
| Web 工作台 | `src/web/server.mjs` | [模块文档](src/web/README.md) |

## 环境要求

- Node.js `>= 20`
- npm（建议使用 lockfile 对应版本）
- 真实 Trace 采集需要已登录且可用的 `sophon-cli`
- Live RCA 需要可访问的模型服务和对应凭证

## 快速开始

### 1. 安装

```bash
git clone https://github.com/enheng0615/tracelens.git
cd tracelens
npm ci
```

### 2. 配置

```bash
cp .env.example .env
```

至少配置实际使用的模型 Provider。不要把 `.env` 提交到 Git。常用变量：

| 变量 | 用途 | 必填条件 |
|---|---|---|
| `SOPHON_MODEL_API_KEY` | Sophon 模型网关凭证 | 使用 Sophon Live 模式 |
| `SOPHON_MODEL_ID` | Sophon 模型 ID | 使用 Sophon |
| `SOPHON_OPERATOR_EMAIL` | Sophon 操作人标识 | 使用 Sophon |
| `OPENAI_API_KEY` | OpenAI 凭证 | 使用 OpenAI Provider |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` | Anthropic 凭证 | 使用 Anthropic Provider |
| `RCA_MAX_MODEL_PROMPT_CHARS` | 模型 Prompt 字符上限 | 可选 |

全部字段与默认值见 [.env.example](.env.example)。

### 3. 验证安装

```bash
npm run check:pi
npm test
```

测试为离线测试，不需要真实 API Key。

## 使用方式

### 方式一：本地 Web 工作台

```bash
npm run web
```

工作台分为 **负向反馈** 与 **离线题集** 两个通道。负向反馈支持单条分析和批量处理（上传候选 CSV 或从本机原始反馈目录筛选）；离线题集支持单 Session 归因和批量评测 CSV。任务、进度与报告统一呈现。Web API 和参数见 [Web 模块文档](src/web/README.md)。

访问 <http://127.0.0.1:4317>。可以创建单 Session 或 CSV 任务、观察进度、查看报告，并对失败项或指定 Session 创建独立重跑 Attempt。

Web 默认仅监听本机，当前没有登录和权限系统，**不要直接暴露到公网或共享网络**。

### 负向反馈 CLI

单条反馈可使用 Web 或统一工作流 CLI。输入 JSON 至少包含 `sessionId` 和 `requestQuery`：

```bash
npm run workflow:feedback -- \
  --input <feedback.json> \
  --workflow-output-root outputs/feedback-workflows
```

批量反馈 CSV 至少包含 `session_id,request_query` 两列，可选 `label,request_id_list,task_id`：

```bash
npm run workflow:feedback-batch -- \
  --csv <negative-feedback.csv> \
  --workflow-output-root outputs/feedback-workflows \
  --session-count 10 --concurrency 3
```

已有本地历史与 Trace、需要手动限定输入或从 Checkpoint 恢复时，使用 `npm run feedback:analyze -- --help` 查看诊断入口。完整输入和结果约定见[反馈工作流文档](src/workflows/online-feedback/README.md)。

### 方式二：单 Session 全流程

复制并编辑输入模板：

```bash
cp examples/workflows/single-session.template.json /tmp/trace-rca-input.json
```

执行：

```bash
npm run workflow:session -- \
  --input /tmp/trace-rca-input.json \
  --max-rounds 20
```

输入包含六个字段：`sessionId`、`query`、`gt`、`score`、`machineGrading`、`idaAnswer`。

### 方式三：CSV 批量归因

```bash
npm run workflow:csv -- \
  --csv <input.csv> \
  --max-rounds 20 \
  --concurrency 3
```

默认列：

```text
问题, gt_attribution, ida_结论报告评分, ida_decompressed_data, ida_url, ida_答案
```

批处理规则：

- 分数严格解析为数值 `1` 时，在拉取 Trace 前跳过；
- `--concurrency` 表示并发 Session 数，范围 `1–16`，默认 `3`；
- 不同 Session 并行，同一 Session 的多行和多 GT 串行；
- `--fail-fast` 仅可与 `--concurrency 1` 一起使用。

只执行满分过滤：

```bash
npm run batch:filter-full-score -- \
  --input <input.csv> \
  --output-dir <output-directory>
```

### 方式四：分步执行

#### 拉取完整 Trace

```bash
npm run ingest:sophon -- --session-id <session-id>
```

默认保存到 `data/raw/sophon-sessions/<session-id>/`。采集参数和完整性定义见 [采集模块文档](src/ingestion/sophon-trace/README.md)。

#### 运行一个 RCA Case

```bash
npm run rca:run -- \
  --case <case.json> \
  --trace-root data/raw/sophon-sessions/<session-id>
```

常用参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--output-root` | `outputs/rca-runs` | RCA 输出根目录 |
| `--max-rounds` | `8` | 最大调查轮数 |
| `--mode` | `live` | `live` 或固定回归用 `offline` |
| `--resume` | — | 从已有运行目录的 Checkpoint 恢复 |

恢复示例：

```bash
npm run rca:run -- \
  --case <case.json> \
  --trace-root <trace-root> \
  --max-rounds 12 \
  --resume outputs/rca-runs/<run-id>
```

## 编程接口

RCA 调用方只应从公共入口导入：

```javascript
import { runRcaCase, validateRcaCase } from "./src/rca/index.mjs";

const result = await runRcaCase({
  casePath: "/absolute/path/case.json",
  traceRoot: "/absolute/path/full-trace",
  outputRoot: "/absolute/path/outputs/rca-runs",
  maxRounds: 8,
  mode: "live",
  env: process.env,
});
```

工作流接口：

```javascript
import {
  runCsvTraceRcaWorkflow,
  runSingleSessionTraceRcaWorkflow,
} from "./src/workflows/trace-rca/index.mjs";
```

## 输出与可审计性

单次成功运行通常包含：

```text
outputs/rca-runs/<run-id>/
├── scoring-gap-target.json  # 经校验的评分差距
├── evidence-ledger.json     # 原始证据与稳定 EV 编号
├── checkpoint.json          # 可恢复状态
├── agent-run.jsonl          # 机器可读审计日志
├── agent-run.md             # 人类可读逐轮日志
├── agent-run-summary.md     # 执行摘要
├── rca-report.json          # 结构化报告
├── rca-report.md            # 最终报告
└── validation.json          # 引用和一致性校验结果
```

运行失败时不会生成伪完成报告，会尽力保留：

```text
failure-summary.md
evidence-ledger.partial.json
validation.partial.json
checkpoint.json              # 已进入可恢复阶段时
```

批次目录、Attempt、Retry 和 Resume 的完整语义见 [存储与复跑设计](docs/retry-and-storage.md)。

## 质量边界

离线评测 RCA 的正式完成要求包括：调查覆盖完整、Agent 明确宣布可结束、Evidence ID 存在、原始证据 Hash 可复核、确定性搜索可重放、报告一致性校验通过。反馈通道另行校验反馈锚点、历史要求和因果闭合。两个通道都区分“报告生成”和“根因证实”；没有重放或干预证据时，因果置信度最高为 `medium`。

当前尚未覆盖：

- 完整的自然语言事实蕴含校验；
- 跨 Web Job 的全局资源队列；
- 多人部署所需的 SSO、RBAC 和数据库；
- 干预重放与跨案例根因聚类。

因此，重要报告仍应保留人工复核环节。

## 测试

```bash
npm test          # 全量离线测试
npm run test:web  # Web 模块专项测试
npm run check     # Pi 依赖检查 + 全量测试
```

固定样例仅用于回归：

```bash
npm run rca:test:29785869:offline
```

## 数据安全

`.gitignore` 已排除 `.env`、原始 Trace、输入数据和运行产物，但提交前仍应人工检查：

```bash
git status --short
git diff --check
git diff --cached
```

不要提交真实 API Key、JWT、Cookie、用户输入、内部 URL 参数、原始 Trace 或 RCA 输出。日志中的基础脱敏不能替代正式的数据治理。

## 参与开发

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。架构或输入输出契约变化时，需要同步更新根 README 与对应模块文档。
