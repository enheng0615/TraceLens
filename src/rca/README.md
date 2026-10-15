# Trace RCA 正式模块

`src/rca` 是框架内的证据驱动 RCA 领域模块。它接收一个已校验案例和一份不可变的本地 Trace，在官方评分结论不变的前提下，调查 IDA 为什么丢失该评分项。

## 公共接口

只从 `src/rca/index.mjs` 导入：

```javascript
import { runRcaCase, validateRcaCase } from "./src/rca/index.mjs";
```

```javascript
const result = await runRcaCase({
  casePath: "/absolute/path/case.json",
  traceRoot: "/absolute/path/full-trace",
  outputRoot: "/absolute/path/outputs/rca-runs",
  maxRounds: 8,
  mode: "live",
  env: process.env,
});
```

CLI入口为 `scripts/run-rca-case.mjs`，`--case` 和 `--trace-root` 均为必填参数。

## 模块边界

```text
case-schema.mjs                   正式输入契约
orchestrator.mjs                  生命周期与状态机
pi-json-agent.mjs                 Pi/Sophon结构化调用、重试与上下文上限
scoring-gap.mjs                   Trace前中立事实差距及来源校验
trace-repository.mjs              不可变Trace索引、搜索和原文读取
trace-tools.mjs                   Agent可请求的只读工具白名单
evidence-ledger.mjs               完整证据、EV编号、offset与SHA-256
fact-evidence.mjs                 IDA事实引文的结构化锚点与同源证据匹配
coverage-validator.mjs            案例声明的最低调查覆盖
report-consistency-validator.mjs  确定性矛盾和置信度上限检查
checkpoint.mjs                    原子Checkpoint与恢复
run-logger.mjs                    JSONL/Markdown审计日志
run-summary.mjs                   成功运行的人类可读逐轮摘要
failure-summary.mjs               失败运行摘要、缺口与恢复指令
report-renderer.mjs               Markdown报告
report-template.mjs               在线反馈与评分差距逐案报告的共用开头及字段校验
prompts.mjs                       调查和报告输出合同
offline-simulation-agent.mjs      仅用于固定回归的确定性模拟Agent
```

## 生命周期

```text
Case验证
  -> Pi/Sophon生成中立Scoring Gap
  -> 确定性校验GT原文和IDA引用
  -> 加载完整Trace与客观执行地图
  -> Sophon逐轮返回JSON actions
  -> Orchestrator执行本地只读Trace Tool
  -> Evidence Ledger登记原始证据
  -> 案例调查覆盖校验
  -> Agent显式readyForConclusion
  -> Sophon生成结构化RCA
  -> 引用、确定性语义、Hash和搜索重放校验
  -> 输出报告与审计日志
```

## Case调查策略

`investigationPolicy` 是案例级最低证据合同，不是根因标签。普通调用方无需提供；框架会从已校验Scoring Gap自动派生。固定回归或领域适配器可显式覆盖：

```json
{
  "allTraceSearches": ["缺失事实的原值或字段名"],
  "factChainTerms": ["兼容旧策略的人类可读事实描述"],
  "factEvidenceGroups": [
    {
      "id": "answer-fact-1",
      "sourceQuote": "| **短期借款** | 为492.29亿元 |",
      "anchors": ["短期借款", "492.29亿元"]
    }
  ],
  "requireToolInventory": true,
  "requireToolQueryInventory": false,
  "schemaToolNames": [],
  "executionToolNames": [],
  "requireAnyExecutionTool": true,
  "executionToolCandidates": ["python_executor", "bash", "read_file"],
  "artifactToolSpanIds": ["write-file-span", "publish-span"],
  "requireFinalGenerationOutput": true
}
```

默认策略会读取Trace实际工具清单后动态生成：只有Trace中确实存在`aeolus_data_set_insight`或`aeolus_sql_query`时，才要求对应Schema、SQL交换与`list_tool_queries`；Python、Bash等任务不会被错误套用SQL覆盖合同。若评分对象是发布文档，还会要求读取确定性关联的`write_file -> lark_doc`产物链。

对于IDA答案中“已经写出的事实”，默认策略不再要求模型用整段Markdown原文作为搜索词。框架把精确引文转换成结构化`factEvidenceGroups`：表格行通常取字段标签和一个带单位的关键数值；同一条`search_trace`命中、`get_span_content`内容或`get_tool_exchange`交换必须同时包含该组全部锚点才算覆盖。不同搜索命中不能拼接，搜索参数本身也不算证据。匹配只忽略Markdown展示符号和空白，不做模糊语义推断。`factChainTerms`仅保留给旧Case和旧Checkpoint兼容。

它只定义“至少查完什么”，不预设“原因是什么”。CSV与单Session工作流均从每个GT的事实差距和实际Trace生成策略；领域适配器仍可显式覆盖并接受人工审核。


## 被评分答案解析

工作流不会默认把最后一条AGENT短回复当成评分对象。解析顺序为：

1. 输入与Trace AGENT输出完全一致时，使用AGENT输出；
2. 输入包含飞书文档URL时，通过URL关联`lark_doc`，再按规范化文件路径回溯前序`write_file.arguments.content`；
3. 输入有明确截断标记且没有可关联产物时，才回退到完整AGENT输出；
4. 多个发布候选或无法解释的不一致会失败关闭，不静默猜选。

Case的`inputProvenance`会记录答案解析方式、产物与发布Span、文件路径、发布URL和交付AGENT Span。

## Trace工具

- `get_trace_overview`
- `list_execution_steps`
- `search_trace`
- `get_span_content`
- `get_tool_exchange`：只接受 `TOOL` Span
- `list_tool_queries`
- `get_span_relations`

Sophon原生Tool Calling协议尚未验证，因此当前使用应用层结构化Action循环。所有工具只读，并由Orchestrator执行白名单校验。

## 完成条件

正式完成必须同时满足：

```text
coverage.complete === true
&& decision.readyForConclusion === true
&& citationValidation.valid === true
&& evidenceConsistencyValidation.valid === true
&& evidenceConsistencyValidation.reportOpening.valid === true
&& rawEvidenceValidation.valid === true
```

最大轮数到达但Agent未宣布结束时，运行失败并保留Checkpoint。调用方应检查开放问题，必要时增加轮数后恢复，不能把它当成完成报告。

失败不会生成伪造的`rca-report.md`，但从运行目录建立后开始，框架会尽力保留以下诊断产物：

```text
failure-summary.md               失败阶段、覆盖缺口、最后状态和恢复命令
evidence-ledger.partial.json     失败时已经登记的完整证据
validation.partial.json          原始错误、覆盖和策略快照
checkpoint.json                  已到达可恢复状态时存在
```

失败产物采用best-effort写入；即使诊断写入自身失败，也不会覆盖最初的RCA异常。工作流Manifest会记录`rcaOutputDir`和`failureSummaryPath`，CLI也会直接打印这些路径。

## 自动校验边界

已经实现：

- GT和官方判定不可改写；
- IDA引用精确或唯一展示归一化对齐；
- 禁止Trace前因果分类；
- Evidence ID必须真实存在；
- 新报告必须提供一句根因及成因、具体问题类别和归类依据，使用[固定模板](../../docs/analysis-report-template.md)；
- 搜索有非零命中时，报告不能宣称对应词在全Trace中零命中；
- 没有重放/干预证据时，因果置信度不得为`high`；
- 原始Span SHA-256复核；
- 确定性搜索全量重放。

尚未实现完整自然语言事实蕴含校验，因此最终报告仍应进入人工复核或后续更强的验证层。

## 数据与安全

- 原始Trace、Evidence Ledger和报告可能含用户或业务数据；
- 原始数据与输出目录均被 `.gitignore` 排除；
- 日志做基础Token、Key和邮箱脱敏，但不能代替正式数据治理；
- 生产部署仍需补充权限、保留期、审计、加密和任务隔离。
