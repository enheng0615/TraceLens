# Trace RCA 运行、失败与复跑设计

## 1. 基本原则

1. **运行产物只追加，不覆盖**：每次首次运行或复跑都创建独立 Job 和独立 Workflow/RCA 目录。
2. **失败记录不删除**：失败摘要、日志、证据快照和 Checkpoint 是定位平台问题的审计证据。
3. **Trace 与分析结果分离**：完整 Trace 按 Session 缓存；RCA Attempt 只引用它。默认复跑不会重拉或删除 Trace。
4. **成功项不重复计算**：批次默认只重跑失败的 `rowNumber + sessionId + criterionId`。
5. **Retry 与 Resume 分开**：Retry 是新的可比较 Attempt；Resume 是同一 Attempt 的断点续跑。

## 2. 目录编排

```text
data/raw/sophon-sessions/
└── <session-id>/                         # Session级Trace缓存，跨Attempt复用
    ├── manifest.json
    ├── integrity-report.json
    ├── session/
    ├── spans/
    ├── traces/
    └── index/

outputs/web-console/jobs/
├── <root-job-id>/                        # Attempt 1
│   ├── job.json
│   ├── input/<original-input>
│   └── workflows/
│       └── batch-<ISO-time>-<id>/        # 一个批次，以批次启动时间命名
│           ├── workflow-manifest.json
│           ├── workflow-summary.md
│           └── sessions/
│               ├── session-<session-id>/
│               │   ├── session-summary.json
│               │   └── gt/
│               │       └── <criterion-id>-<case-hash>/
│               │           ├── case.json
│               │           ├── agent-run.jsonl
│               │           ├── agent-run.md
│               │           ├── agent-run-summary.md
│               │           ├── checkpoint.json
│               │           ├── validation.json
│               │           ├── rca-report.md        # 成功时
│               │           └── failure-summary.md   # 失败时
│               └── unresolved-row-<row>/            # Session ID 无法解析的输入错误
│                   └── session-summary.json
└── <retry-job-id>/                       # Attempt 2/3/...，独立新批次
    ├── job.json
    ├── retry-plan.json
    ├── input/<copied-input>
    └── workflows/batch-<new-time>-<id>/...
```

目录层级固定为 **批次时间 → Session → GT**。同一 Session 的不同 GT 不共享 RCA 输出目录；`case.json`、报告、Agent 日志、校验和失败产物都保存在对应 GT 目录。每次 Retry 都生成新 Job 和新 `batch-*` 目录，因此不需要、也不允许为了复跑删除旧报告。

Web 的“报告”页是这个物理目录的展示投影：先选批次，再展开 Session，最后选择 GT。批次级的 `workflow-summary.md`、Web 日志和失败诊断单独展示，不会混入某个 GT。旧版 `rca-runs/session-...-GT...` 目录保持只读兼容，Web 会从旧路径恢复同样的 Session/GT 树。

`job.json.lineage` 和 `workflow-manifest.json.lineage` 记录：

```json
{
  "rootJobId": "最初任务ID",
  "parentJobId": "直接父Attempt任务ID",
  "attempt": 2,
  "scope": "failed_only",
  "reason": "修复覆盖策略后复跑",
  "createdAt": "...",
  "sourceManifestPath": "...",
  "sourceStatus": "failed"
}
```

每个 Job 还保存不含密钥的 `runtime` 快照：代码 SHA-256、包版本、Node 版本、Provider 和模型 ID，用于比较修复前后的 Attempt。原始 API Key 不进入 Job 文件。

```json
{
  "codeSha256": "...",
  "packageVersion": "1.0.0",
  "nodeVersion": "v24.x",
  "provider": "sophon",
  "modelId": "DeepSeek-V4-Flash-Sophon"
}
```

## 3. 三种 Web 复跑方式

### 仅重跑失败项（默认、推荐）

适用：部分 Session/GT 已成功，少数项因模型、网络、校验或代码问题失败。

- Web 从父 Manifest 读取失败项；
- 用户可勾选全部或部分失败项；
- 选择键为 `rowNumber + sessionId + criterionId + caseId`；
- 新 Attempt 只建立这些 RCA Case；
- 完整 Trace 默认从 `data/raw/sophon-sessions/<session-id>` 复用；
- 已成功项不调用模型、不重复计费；
- 运行链汇总用新 Attempt 的结果覆盖同一逻辑项的旧状态，但不修改旧文件；
- 使用“首错停止”的批次，或旧任务中 `plannedCriteria > 已记录GT数` 时，可能存在未执行项，因此不提供“仅失败项复跑”，必须完整重跑以防遗漏；
- 新版单 Session 默认在某个 GT 失败后继续处理后续 GT，使失败清单完整。

### 完整重跑

适用：输入本身有误、准备逻辑变化、GT 解析逻辑变化，或希望完整做一次可对照回归。

- 复制原始输入；
- 重新执行所有行和所有未命中 GT；
- 默认仍复用通过完整性校验的 Trace；
- 产生新的完整 Workflow；
- 运行链汇总以这次完整重跑为新的结果基线。

### 指定 Session 重跑

适用：人工检查批次结果后，希望重新分析一个或多个明确指定的 Session，不限原状态是成功、失败还是“完成但Trace有缺口”。

- 在批次 Session 卡片上勾选一个或多个 Session；
- 选择身份由 `sessionId + 该Session对应CSV行号集合` 生成稳定摘要，不接受浏览器直接提交任意行号；
- 后端根据父 Attempt 的 Manifest 重新解析选择，过期或伪造的选择会被拒绝；
- 同一 Session 对应多行 CSV 时，勾选一次会包含这些行；
- 每个所选 CSV 行中的全部未命中 GT 都会重跑，而不是只重跑原失败 GT；
- 创建独立 `selected_sessions` Attempt，旧报告、失败日志和原始批次均保持不变；
- Trace 默认复用已通过可分析性检查的 Session 缓存，不自动执行 `force-ingestion`。

## 4. Retry 与 Resume

| 操作 | 新 Job | 新 RCA 目录 | 复用证据账本 | 适用情况 |
|---|---:|---:|---:|---|
| Retry | 是 | 是 | 否 | 修复代码、Prompt、模型配置或想获得独立可比较结果 |
| Resume | 否 | 否 | 是 | 临时网络中断、限流或同一执行需要继续增加轮次 |

Resume 会在写入同一 Attempt 前，把现有失败快照复制到：

```text
<rca-run>/resume-history/<timestamp>/
```

因此即便同一 Attempt 继续执行，之前的失败摘要和校验快照也不会丢失。

## 5. 批次失败处理流程

批次初跑和复跑都可以设置 `concurrency=1..16`。调度单位是 Session：不同 Session 可并行，同一 Session 的多行和多个 GT 串行，以避免重复采集及同 Session 证据链竞争。复跑默认继承父 Attempt 的并发数，也允许在 Web 弹窗中调整。`failFast` 与并发执行语义冲突，因此只允许并发数为 1。

```text
批次 Attempt 1
  ├── 成功项：保留为当前有效结果
  └── 失败项：进入失败清单
          ↓ 修复/排障
选择“仅重跑失败项”
          ↓
批次 Attempt 2（只运行所选失败项）
          ↓
运行链汇总
  ├── 原成功项 + 本次成功项 = 有效完成数
  └── 本次仍失败项 = 未解决数，可继续 Attempt 3
```

不要为了复跑删除原 Job、Workflow、RCA Run 或失败摘要。需要重新拉取 Trace 时，应作为独立的显式维护动作处理；当前 Web 复跑故意禁用 `force-ingestion`，避免复跑归因时破坏共享 Trace 缓存。

## 6. 不可归因源任务与截断 Tool Result

批量输入只有在以下四个条件**同时成立**时，才写为 `source_run_failed`，不计入 Trace RCA 失败，也不进入失败项复跑：

```text
Session ID 为空
score 为空
IDA 答案为空或 failed
机评为空或 {}
```

Manifest 保留逐项条件和固定说明：`Session ID 为空；score 为空；IDA 答案为空或 failed；机评为空或 {}`。Web 用琥珀色“源任务未运行”展示；需要先在上游重新运行 Agent，获得 Session 和评测结果后才能归因。只要四个条件中任一个不成立，仍按普通输入校验规则处理，不能误归类。

Trace 中若出现 `isResultTruncated=true` 且包含可信的 `fullResultDownloadUrl`，采集模块会：

1. 只允许固定内部 HTTPS 主机和路径；
2. 限制单个响应体大小；
3. 把完整结果写入 `expanded-tool-results/<span-id>.json`；
4. 在 Manifest 中只保存来源哈希，不保存原始下载 URL；
5. 重新进行完整性审计，并让 Trace Repository 优先索引补拉内容。

采集完整性会进一步投影为 RCA 证据边界：`complete`、`partial_analyzable` 和 `partial_critical`。主体结构完整但局部 Tool Result 补拉失败时可按 `partial_analyzable` 继续分析，报告必须标出具体 Tool/Span/字段及未知区间；分页、数量、Tree 或 Payload 等结构性缺口仍按 `partial_critical` 严格阻断。
