# 架构说明

## 设计目标

ORIGO 将“模型提出调查动作”和“程序读取证据、判断完成条件”分离。模型不能直接修改 Trace、伪造 Evidence ID 或绕过确定性校验。

## 分层结构

```text
CLI / Local Web Console
          │
          ▼
Workflow orchestration
输入校验 · 满分过滤 · Session并发 · Case拆分 · Manifest
          │
     ┌────┴────┐
     ▼         ▼
Ingestion     RCA domain
分页采集       Scoring Gap · Trace只读工具 · Evidence Ledger
完整性审计     覆盖校验 · Checkpoint · 报告一致性校验
     │         │
     └────┬────┘
          ▼
Local artifacts / audit logs
```

## 模块边界

### `src/ingestion/sophon-trace`

负责 Sophon Session、Turn、Trace Tree 和 Span Detail 的确定性采集。输出不可变原始数据、索引和完整性报告，不调用模型。

### `src/providers`

隔离 Sophon、OpenAI 和 Anthropic 的鉴权与协议差异。密钥只存在于本地配置，不进入模型描述或浏览器。

### `src/rca`

核心领域层。接收一个 Case 与一份本地 Trace，通过只读工具登记证据，并在覆盖、引用和一致性全部通过后生成报告。

### `src/workflows/trace-rca`

应用编排层。把单 Session 或 CSV 输入解析为多个 Case，复用 Session Trace，控制批次并发并维护 Manifest。

### `src/web`

本地适配层。负责 HTTP、任务进程、输入快照和产物浏览，不复制 RCA 规则。内部继续按职责拆分：

```text
server.mjs          HTTP 路由与静态资源
job-store.mjs       持久化、子进程和任务生命周期
job-progress.mjs    无状态进度投影
report-tree.mjs     Batch → Session → GT 报告投影
retry-state.mjs     Attempt 合并与复跑选择
job-diagnostics.mjs Web 失败诊断
audit-logger.mjs    脱敏审计日志
```

## 核心数据流

1. 输入层读取六项业务字段或 CSV 行。
2. 工作流跳过满分项，并按 Session 分组。
3. 采集层获取或复用完整 Trace，执行完整性审计。
4. 工作流按未命中 GT 创建独立 Case。
5. RCA 层生成中立 Scoring Gap，并建立最低调查策略。
6. Agent 返回结构化只读动作，Orchestrator 执行动作并登记原始证据。
7. 覆盖完成且 Agent 明确结束后，生成结构化报告。
8. 引用、Hash、搜索重放和因果置信度校验通过后，写入最终报告。

## 依赖方向

```text
web ────────► workflows ────────► rca
                    │               │
                    └► ingestion    └► providers
```

领域层不依赖 Web；采集层不依赖模型；脚本只调用模块公开入口。新增能力时应保持这一方向，避免跨层读取内部文件。

## 失败与恢复

- Trace 不完整时先由采集完整性报告分类。
- 调查中断时保留 Evidence Ledger、校验快照和 Checkpoint。
- 未满足完成条件时不生成伪完成报告。
- Web 重跑创建新 Attempt，不覆盖历史产物。
- 批次失败相互隔离，除非显式启用单并发 `fail-fast`。

详细存储约定见 [`retry-and-storage.md`](retry-and-storage.md)。
