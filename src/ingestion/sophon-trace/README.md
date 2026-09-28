# Sophon Trace 全量采集模块

该模块负责根据一个 Sophon `session_id` 下载可用于 Agent Trace 归因的完整原始数据。它只做确定性数据采集和完整性检查，不调用大模型，也不执行根因分析。

## 采集范围

一次 Session 采集包括：

1. Session 摘要；
2. Session 全部 Turn，按 `nextPageToken` 逐页保存；
3. Session 聚合统计；
4. Session 时间窗口内的全部 Span，按 `nextPageToken` 逐页保存；
5. 每个唯一 Trace 的完整调用树；
6. 每个唯一 Span 的完整详情；
7. Trace、Span 和 Turn 索引；
8. 跨接口内容一致性与疑似截断检查；
9. 标准 `manifest.json`。

模块不使用 `--all --max-bytes` 聚合全量数据，而是显式跟随分页游标并将每页独立落盘，因此不会因为 CLI 聚合阈值提前停止。

## 使用方式

从项目根目录运行：

```bash
npm run ingest:sophon -- --session-id 29785869
```

也支持从包含 Session ID 的 URL 提取：

```bash
npm run ingest:sophon -- \
  --query-url 'https://example.test/path?session_id=29785869'
```

常用参数：

```text
--output-root <目录>   默认 data/raw/sophon-sessions
--tenant <名称>        默认 data
--agent-type <类型>    默认 ida
--region <cn|sg>
--user-email <邮箱>
--page-size <1-200>    默认 200
--padding-ms <毫秒>    默认 300000，即前后各 5 分钟
--timeout-ms <毫秒>    默认 120000
--retries <次数>       默认 2
--force                删除该 Session 的已有目录并重新下载
```

Session 摘要查询会先使用 Sophon 的近期默认窗口；若未命中目标 Session，采集器会按严格小于 30 天的窗口向历史逐段回溯（默认最多 12 段），以满足服务端“单次查询范围不能超过 30 天”的限制。空的旧查询缓存会自动刷新，不需要手工删除。

查看完整帮助：

```bash
npm run ingest:sophon -- --help
```

## 输出目录

默认输出：

```text
data/raw/sophon-sessions/<session-id>/
├── manifest.json
├── integrity-report.json
├── index/
│   ├── source.json
│   ├── trace-ids.txt
│   ├── spans.tsv
│   └── turns.json
├── session/
│   ├── list.json
│   ├── stats.json
│   └── detail-pages/
│       ├── page-0001.json
│       └── ...
├── spans/
│   ├── list-pages/
│   │   ├── page-0001.json
│   │   └── ...
│   └── details/
│       ├── <span-id>.json
│       └── ...
└── traces/
    └── trees/
        ├── <trace-id>.json
        └── ...
```

原始 Sophon JSON 按接口原样保存。索引、Manifest 和审计报告是本模块生成的派生文件。

## 断点续跑

默认情况下，已经存在且能够正常解析的 JSON 文件会被复用。命令中途失败后，可以直接重新运行相同命令：

```bash
npm run ingest:sophon -- --session-id 29785869
```

强制清理该 Session 并重新下载：

```bash
npm run ingest:sophon -- --session-id 29785869 --force
```

## 完整性判定

`integrity-report.json` 会检查：

- Session Turn 分页是否结束；
- Span List 分页是否结束；
- Session 声明的 Trace 数是否与实际 Trace 数一致；
- Span List、Trace Tree、Span Detail 的 Span ID 是否一致；
- 每个 Trace 是否有 Tree 文件；
- 每个 Span 是否有 Detail 文件；
- 同一 Span 的 `input/output` 在三个接口中 SHA-256 是否一致；
- 是否存在明确的截断相关字段或标记；
- 最大 input/output 字符数。

成功时：

```json
{
  "result": "complete_no_observed_truncation",
  "complete": true,
  "warnings": []
}
```

该结果证明 Sophon 各查询接口返回一致且分页完整，但不能恢复或独立证明数据在上报到 Sophon 之前没有被截断。

## 安全和数据治理

Trace 可能包含用户输入、模型输出、工具参数和业务数据：

- 原始数据目录不得提交 Git；
- 当前 `.gitignore` 已忽略 `test_data/` 和 `data/raw/`；
- 不要在 CI 日志中打印原始 Trace；
- 不要通过命令行传递 Sophon Token，优先使用本机 tenant profile；
- 分享数据前必须脱敏；
- 生产环境需要补充保留期、访问控制和审计策略。

## 代码结构

```text
src/ingestion/sophon-trace/
├── index.mjs                 # 公共导出
├── errors.mjs                # 结构化错误
├── file-store.mjs            # 原子写入、JSON 校验、哈希
├── sophon-cli-client.mjs     # sophon-cli 进程适配器
├── pagination.mjs            # 游标分页
├── session-id.mjs            # 从 query URL 提取 Session ID
├── fetch-session.mjs         # Session 全量采集编排
├── integrity.mjs             # 完整性和截断审计
└── README.md
```

## 当前边界

当前模块输入是一个 `session_id` 或一个包含 Session ID 的 URL。CSV/飞书表导入尚未实现；等真实 CSV 表头和一行脱敏样例确认后，再在本模块上层增加批量 Case Importer。

## 截断 Tool Result 补拉

当 Span 输出明确带有 `isResultTruncated=true` 和 `fullResultDownloadUrl` 时，采集器会从固定的内部 `ida.bytedance.net/dataAgent/llm/api/v2/deepresearch/images` 路径补拉完整结果，写入：

```text
<session>/expanded-tool-results/<span-id>.json
```

原始 URL 不进入 Manifest、Agent 上下文或报告；仅保留文件路径哈希、内容哈希、字符数与恢复状态。Trace Repository 会把补拉内容作为该 Span 的扩展输出纳入确定性搜索和原始证据校验。下载失败时完整性为 `partial_recoverable`，不会静默忽略。
