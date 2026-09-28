<p align="center">
  <img src="src/web/public/assets/logo-horizontal.svg" width="306" alt="Trace RCA — Trace-based Root Cause Analysis">
</p>

# Trace RCA Agent

公司内部评测场景的 Trace 根因分析框架。Pi Agent Core 作为底层 Agent Runtime；业务层负责 Sophon Trace 采集、证据驱动调查、确定性校验、审计日志和报告输出。

## 当前正式模块

```text
src/
├── ingestion/sophon-trace/  # Session/Trace/Span全量采集与完整性审计
├── providers/               # Sophon、OpenAI、Anthropic模型适配
├── rca/                     # 单Session、单未命中评分项的Trace RCA
└── workflows/trace-rca/     # 单Session和CSV全链路编排
```

RCA正式公共入口：

```javascript
import { runRcaCase, validateRcaCase } from "./src/rca/index.mjs";
```

## 环境

- Node.js >= 20
- `sophon-cli` 已登录并可用（仅采集时需要）
- 复制 `.env.example` 为 `.env`，配置模型凭证
- 不要提交 `.env`、原始Trace或RCA输出

安装依赖：

```bash
npm install
npm run check:pi
```

## 1. 拉取完整Trace

```bash
npm run ingest:sophon -- --session-id <session-id>
```

默认输出：

```text
data/raw/sophon-sessions/<session-id>/
```

完整参数和数据边界见：

```text
src/ingestion/sophon-trace/README.md
```

## 2. 准备RCA案例

从模板复制：

```text
examples/rca/case.template.json
```

正式契约当前要求：

- 每次运行只分析一个官方未命中项；多GT由上层拆成多次运行；
- 官方评分结论是权威输入，不重新评分；
- 框架从已校验的Scoring Gap自动派生最低调查覆盖；高级适配器可选传入`investigationPolicy`覆盖；
- `idaAnswer` 和官方评分文本必须保留原文。

## 3. 运行RCA

```bash
npm run rca:run -- \
  --case <case.json> \
  --trace-root data/raw/sophon-sessions/<session-id>
```

可选参数：

```text
--output-root <dir>   默认 outputs/rca-runs
--max-rounds <n>      默认 8
--mode live|offline   正式结果必须使用 live
--resume <run-dir>    从Checkpoint恢复
```

恢复示例：

```bash
npm run rca:run -- \
  --case <case.json> \
  --trace-root data/raw/sophon-sessions/<session-id> \
  --max-rounds 12 \
  --resume outputs/rca-runs/<run-id>
```

达到 `max-rounds` 但 Agent 未明确返回 `readyForConclusion=true` 时，正式模块会保留Checkpoint并失败，不会生成伪完成报告。

## 4. 批量 CSV 归因

```bash
npm run workflow:csv -- \
  --csv <input.csv> \
  --max-rounds 20 \
  --concurrency 3
```

- `--concurrency` 是同时运行的 **Session 数**，范围 `1–16`，默认 `3`；
- 批处理会先按评分列筛选：数值严格等于 `1` 的满分题直接记为 `skipped/full_score`，不拉取 Trace、不调用模型、不执行 RCA；
- 不同 Session 并行，同一 Session 的多行和多个未命中 GT 保持串行；
- 完整 Trace 仍按 Session 缓存并复用；Manifest/摘要会记录实际并发配置；
- `--fail-fast` 只支持 `--concurrency 1`，不指定并发时会自动使用 `1`。

如需在运行前单独查看筛选结果，可调用项目 Skill：

```bash
npm run batch:filter-full-score -- \
  --input <input.csv> \
  --output-dir <output-directory>
```

它不会改写原 CSV，会分别输出满分题、待归因题和筛选统计。Skill 说明见 `skills/trace-batch-full-score-filter/SKILL.md`。

## Web 工作台（本地实例）

```bash
npm run web
```

打开 `http://127.0.0.1:4317`，可创建单 Session 或 CSV 归因任务；“报告”页按批次时间 → Session → GT 展示阶段进度、Agent 审计日志、失败摘要和最终报告。失败后可创建独立 Attempt，仅重跑所选失败 Session/GT，或完整重跑；历史产物不会被覆盖。默认仅监听本机，不会把 `.env` 密钥发送到浏览器。详细说明见 `src/web/README.md`，复跑与目录规范见 `docs/retry-and-storage.md`。

## 固定回归样例

Session `29785869` 仅作为已知样例回归，不是正式入口的默认数据：

```bash
npm run rca:test:29785869:offline
npm run rca:test:29785869
```

## 输出

每次运行创建：

```text
outputs/rca-runs/<run-id>/
├── agent-run.jsonl
├── agent-run.md
├── agent-run-summary.md
├── checkpoint.json
├── scoring-gap-target.json
├── evidence-ledger.json
├── rca-report.json
├── rca-report.md
└── validation.json
```

若运行未通过覆盖或验证，框架不会生成伪完成报告，而会尽力写入：

```text
failure-summary.md
├── 失败阶段、覆盖缺口和恢复命令
evidence-ledger.partial.json
└── validation.partial.json
```

上层工作流会把RCA输出目录和失败摘要路径写入`workflow-manifest.json`。

## 质量边界

当前正式模块已覆盖单Session和CSV入口、按未命中GT拆分、Trace复用，以及单个CSV工作流内部的Session级受控并发。尚未包括飞书在线导入、跨Web Job的全局资源队列、干预重放和跨案例聚类。没有重放或干预证据时，报告因果置信度最高为 `medium`。

详细设计见：

```text
src/rca/README.md
src/providers/README.md
```

## 测试

```bash
npm test
```
