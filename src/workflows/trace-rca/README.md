# Trace RCA 工作流模块

该模块连接输入、Trace 采集和 RCA 领域层，负责把单 Session 或 CSV 批次转换为可审计的 RCA Case。工作流只做编排，不在此处实现 Trace 下载协议或 RCA 推理规则。

## 稳定入口

调用方应只从 `index.mjs` 导入：

```javascript
import {
  runCsvTraceRcaWorkflow,
  runSingleSessionTraceRcaWorkflow,
} from "./src/workflows/trace-rca/index.mjs";
```

命令行入口：

```bash
npm run workflow:session -- --input <input.json>
npm run workflow:csv -- --csv <input.csv>
```

## 内部职责

| 文件 | 职责 |
|---|---|
| `csv-input.mjs` | RFC 4180 CSV 解析、列映射和源任务状态分类 |
| `evaluation-input.mjs` | 评测输入可归因性预检；区分未命中GT、评测缺失和评分器错误 |
| `grading-parser.mjs` | 从机评和 GT 中提取未命中项 |
| `content-alignment.mjs` | Query/答案的确定性对齐规则 |
| `answer-resolver.mjs` | 确认实际被评分的答案或发布产物 |
| `session-trace.mjs` | Trace 缓存检查与按 Session 复用 |
| `case-builder.mjs` | 将每个未命中 GT 转换为独立 RCA Case |
| `workflow.mjs` | 单 Session、批次并发和失败隔离编排 |
| `full-score-filter.mjs` | 在采集前跳过严格数值满分项 |
| `workflow-summary.mjs` | 生成人类可读的批次摘要 |

## 关键不变量

- 满分只按分数字段的严格数值 `1` 判断，不从机评文本推断。
- CSV 只有在机评中存在明确未命中GT时才进入Trace归因；score缺失/无效、GT缺失、空评分数组或评分器错误写为 `evaluation_input_issue`，不拉Trace、不调用模型、不计为RCA失败。
- 同一 Session 的多行和多 GT 串行执行，并复用一份完整 Trace。
- 不同 Session 可受控并发，范围为 `1–16`。
- 每个未命中 GT 生成独立 Case 和输出目录。
- 输入与 Trace 无法确定性对齐时默认失败关闭；仅显式参数可绕过。
- 单项失败记录到 Manifest，不覆盖已成功项的产物。

## Tool / Skill 审计证据

每个成功的 GT 报告都会生成：

- `rca-report.md`：展开本次调查实际读取过的 Tool/Skill 名称、Span ID、调用参数或代码、返回值、截断状态和原始字段区间；最终报告引用的长返回值命中片段会单独展示。
- `key-execution-evidence.json`：上述执行交换的结构化版本。
- `evidence-ledger.json`：完整证据账本和原始 Span 引用。

标准 `TOOL` Span 和名称包含 `skill` 的 Skill 执行 Span 都可通过统一的执行交换读取。若最终 RCA 引用的搜索命中来自 Tool/Skill Span，而模型没有主动读取交换，编排器会在报告落盘前确定性补读。正文单段最多展示 12,000 字符，超长返回值必须同时标记总字符数、截断状态及 `span.field[offset:end]` 定位。

`rca-report.md` 的开头与在线反馈报告共用 [固定分析报告模板](../../../docs/analysis-report-template.md)：先写根因及成因、问题类别，再说明从最早偏差到最终答案的传递路径。完整 Tool/Skill 审计继续保留在后文。

## Session 索引与局部 Trace

- CSV 会从 IDA URL 提取非敏感的 `agentId`，但不会保存 JWT。
- `session list` 的近期 `SESSION_INDEX` 未命中时，采集器优先使用 `session get <sessionId> --agent-id <agentId>` 恢复 Session 时间范围，不再先盲目回溯到 ES 保留期之外。
- Tree 少量辅助 `SPAN` 但相同 Span Detail 完整存在时，分类为 `partial_analyzable`；报告逐项列出 Tree 节点缺口和截断 Tool Result，同时禁止完整 Trace 的否定性断言。

输出目录、Retry 和 Resume 语义见 [`docs/retry-and-storage.md`](../../../docs/retry-and-storage.md)。
