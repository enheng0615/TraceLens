<p align="center">
  <img src="src/web/public/assets/logo-horizontal.svg" width="360" alt="Trace RCA">
</p>

<p align="center">
  基于执行 Trace 的证据驱动根因分析框架
</p>

<p align="center">
  <img alt="Node.js >= 20" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="ES Modules" src="https://img.shields.io/badge/modules-ESM-f7df1e?logo=javascript&logoColor=111">
  <img alt="Tests passing" src="https://img.shields.io/badge/tests-passing-brightgreen">
</p>

# Trace RCA Agent

Trace RCA Agent 面向 Agent 评测场景，在**不重新评分、不改写 Ground Truth** 的前提下，利用完整执行 Trace 调查答案为何遗漏指定评分项。它将模型的调查能力与确定性证据校验结合，输出可追溯、可恢复、可审计的 RCA 报告。

> 当前 Sophon 采集和模型联调依赖内部服务与已登录的 `sophon-cli`。离线测试、核心模块阅读和固定样例回归不需要真实凭证。

## 特性

- **证据驱动**：每条结论引用真实 Trace Evidence ID，并复核原文偏移与 SHA-256。
- **完整 Trace 采集**：显式遍历 Session、Turn、Span 和 Trace Tree 分页，生成完整性报告。
- **单 GT 调查**：每次 RCA 只处理一个官方未命中项，避免多个评分目标相互污染。
- **确定性护栏**：程序校验调查覆盖、引用、搜索重放、因果置信度和报告一致性。
- **批量编排**：支持 CSV、满分预过滤、Session 级并发、同 Session Trace 复用和失败隔离。
- **断点与复跑**：保留 Checkpoint、失败摘要与不可变 Attempt，不用伪完成报告掩盖失败。
- **本地工作台**：提供任务创建、进度、Batch → Session → GT 报告浏览和选择性复跑。
- **多模型适配**：封装 Sophon、OpenAI 与 Anthropic Provider。

## 工作原理

```text
业务输入 / CSV
      │
      ▼
工作流层：校验输入、过滤满分项、按 Session 分组、按未命中 GT 拆 Case
      │
      ├──────────────► 采集层：下载完整 Trace、建立索引、审计完整性
      │
      ▼
RCA 层：Scoring Gap → 只读 Trace 调查 → Evidence Ledger → 覆盖校验
      │
      ▼
报告层：引用校验、原文 Hash、搜索重放、一致性校验 → RCA 报告
```

更完整的依赖关系和数据流见 [架构说明](docs/architecture.md)。

## 项目结构

```text
trace_agent/
├── src/
│   ├── ingestion/sophon-trace/  # Trace 采集、索引和完整性审计
│   ├── providers/               # Sophon / OpenAI / Anthropic 适配
│   ├── rca/                     # 证据调查、覆盖校验和报告生成
│   ├── workflows/trace-rca/     # 单 Session / CSV 全链路编排
│   └── web/                     # 本地 Web API、任务状态和前端
├── scripts/                     # 轻量 CLI 入口
├── examples/                    # 脱敏输入模板和固定样例
├── skills/                      # 可独立调用的批处理 Skill
├── test/                        # Node.js 离线测试
└── docs/                        # 架构、存储和品牌文档
```

| 模块 | 稳定入口 | 说明 |
|---|---|---|
| Trace 采集 | `src/ingestion/sophon-trace/index.mjs` | [模块文档](src/ingestion/sophon-trace/README.md) |
| 模型 Provider | 各 Provider 的工厂函数 | [模块文档](src/providers/README.md) |
| RCA 领域层 | `src/rca/index.mjs` | [模块文档](src/rca/README.md) |
| 工作流 | `src/workflows/trace-rca/index.mjs` | [模块文档](src/workflows/trace-rca/README.md) |
| Web 工作台 | `src/web/server.mjs` | [模块文档](src/web/README.md) |

## 环境要求

- Node.js `>= 20`
- npm（建议使用 lockfile 对应版本）
- 真实 Trace 采集需要已登录且可用的 `sophon-cli`
- Live RCA 需要可访问的模型服务和对应凭证

## 快速开始

### 1. 安装

```bash
git clone https://github.com/enheng0615/trace_agent.git
cd trace_agent
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

访问 <http://127.0.0.1:4317>。可以创建单 Session 或 CSV 任务、观察进度、查看报告，并对失败项或指定 Session 创建独立重跑 Attempt。

Web 默认仅监听本机，当前没有登录和权限系统，**不要直接暴露到公网或共享网络**。

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

正式完成要求同时满足：调查覆盖完整、Agent 明确宣布可结束、Evidence ID 存在、原始证据 Hash 可复核、确定性搜索可重放、报告一致性校验通过。没有重放或干预证据时，因果置信度最高为 `medium`。

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
