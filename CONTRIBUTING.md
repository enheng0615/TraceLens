# Contributing

感谢参与 TraceLens。提交改动前请遵循以下约定。

## 本地开发

```bash
git clone <repository-url>
cd tracelens
npm ci
cp .env.example .env  # 只有真实联调时才需要填写
npm test
```

离线测试不需要 API Key，也不会访问真实模型服务。

## 代码组织

- 采集协议与完整性规则放在 `src/ingestion/sophon-trace/`。
- Provider 鉴权与协议适配放在 `src/providers/`。
- RCA 领域规则放在 `src/rca/`。
- 输入和批次编排放在 `src/workflows/trace-rca/`。
- Web 只做本地交互、任务管理和结果投影。
- CLI 文件保持轻量，只解析参数并调用模块公开入口。

请优先从各模块的 `index.mjs` 导入，避免依赖内部实现文件。

## 编码约定

- 使用 ESM 和 `.mjs`，Node.js 版本不低于 20。
- 函数尽量单一职责；无状态计算优先写成可独立测试的纯函数。
- 注释解释约束和原因，不逐行复述代码。
- 文件写入需要考虑原子性；失败不能覆盖最初错误。
- 证据、评分和完成条件使用确定性程序校验，不把关键约束只写在 Prompt 中。

## 测试

```bash
npm test          # 全量离线测试
npm run test:web  # Web 专项测试
npm run check     # 依赖检查 + 全量测试
```

新增或修复行为时需要补充对应测试。测试数据必须使用虚构凭证和脱敏内容。

## 安全检查

提交前运行：

```bash
git status --short
git diff --check
git diff --cached
```

不要提交以下内容：

- `.env`、API Key、OAuth Token、Cookie、JWT；
- 原始 Trace、用户输入、真实 CSV；
- `outputs/`、`data/raw/`、`test_data/`；
- 能够定位个人或内部任务的 URL、邮箱和 Session 数据。

## Pull Request

PR 描述应说明：问题、方案、模块边界变化、验证命令和潜在风险。架构或输入输出契约变化时，同时更新 README 和模块文档。
