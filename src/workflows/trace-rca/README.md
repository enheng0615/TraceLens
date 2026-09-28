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
- 同一 Session 的多行和多 GT 串行执行，并复用一份完整 Trace。
- 不同 Session 可受控并发，范围为 `1–16`。
- 每个未命中 GT 生成独立 Case 和输出目录。
- 输入与 Trace 无法确定性对齐时默认失败关闭；仅显式参数可绕过。
- 单项失败记录到 Manifest，不覆盖已成功项的产物。

输出目录、Retry 和 Resume 语义见 [`docs/retry-and-storage.md`](../../../docs/retry-and-storage.md)。
