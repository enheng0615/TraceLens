# 模型 Provider

本目录封装 Trace Agent 使用的模型接入逻辑。目标是让上层 Agent 只依赖统一的模型能力，不直接处理不同供应商的鉴权、模型选择和 HTTP 协议。

## 目录结构

```text
src/providers/
├── README.md
├── sophon-model.mjs
├── openai-model.mjs
└── anthropic-model.mjs
```

| Provider | 工厂函数 | 请求实现 | 当前状态 |
|---|---|---|---|
| Sophon 内部网关 | `createSophonProvider()` | 自定义 Pi `streamFn` | 普通文本已适配，Tool Calling 待确认 |
| OpenAI | `createOpenAIProvider()` | `pi-ai` 内置 Provider | 支持 Pi 原生消息与工具协议 |
| Anthropic | `createAnthropicProvider()` | `pi-ai` 内置 Provider | 支持 Pi 原生消息与工具协议 |

## 快速开始

### 1. 准备配置

在项目根目录执行：

```bash
cp .env.example .env
```

只填写准备使用的 Provider，其他 Provider 的字段可以留空。

### 2. 验证 Provider 代码

```bash
npm test
```

这是离线测试，不会调用真实模型服务，也不需要真实 API Key。

### 3. 联调 Sophon

当前项目已经提供 Sophon 联调脚本：

```bash
npm run test:model
```

传入自定义问题：

```bash
npm run test:model -- "请解释什么是分布式 Trace"
```

`test:model` 当前只测试 Sophon，执行入口为：

```text
scripts/chat-sophon.mjs
```

## 通用 Agent 事件输出

无论使用哪个 Provider，Pi Agent 的文本事件监听方式相同：

```javascript
function printAgentText(agent) {
  return agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }

    if (event.type === "agent_end") {
      process.stdout.write("\n");
    }
  });
}
```

---

## Sophon

### 环境变量

```dotenv
SOPHON_MODEL_API_KEY=填写真实API密钥
SOPHON_MODEL_ID=DeepSeek-V4-Flash-Sophon
SOPHON_OPERATOR_EMAIL=your.name@bytedance.com
SOPHON_MODEL_ENDPOINT=https://sophon-ai.bytedance.net/gateway/openapi/model/chatCompletion

SOPHON_SCENE_SCOPE=1
SOPHON_SCENE_TYPE=1
SOPHON_IS_AGENT=2
SOPHON_TEMPERATURE=0.01

# 下面两个值是提供给 Pi 的本地模型元数据
SOPHON_CONTEXT_WINDOW=128000
SOPHON_MAX_TOKENS=8192
```

### 创建 Agent

```javascript
import { Agent } from "@mariozechner/pi-agent-core";
import { createSophonProvider } from "./src/providers/sophon-model.mjs";

const { model, streamFn } = createSophonProvider();

const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个 Trace 根因分析助手。",
    model,
  },
  streamFn,
});

agent.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("请分析这个问题");
```

### Provider 返回值

```javascript
const {
  config,   // 环境配置，包含密钥，不要打印或持久化
  model,    // Pi 模型描述，不包含 API Key
  streamFn, // Sophon HTTP 协议到 Pi 事件流的适配器
} = createSophonProvider();
```

### 请求映射

当前适配器按照以下形式请求 Sophon：

```json
{
  "model": "DeepSeek-V4-Flash-Sophon",
  "messages": [
    {
      "role": "user",
      "content": "用户问题"
    }
  ],
  "temperature": 0.01,
  "n": 1,
  "stream": false,
  "cache": true
}
```

适配器自动添加：

```text
api-key
Content-Type: application/json
x-modelhub-scene-scope
x-modelhub-scene-type
x-modelhub-is-agent
x-modelhub-operator-email
```

### 当前限制

目前拿到的 Sophon 示例只覆盖普通文本问答，尚未确认 Tool Calling 协议。因此：

- 支持普通文本请求和回答；
- 当前固定使用非流式请求 `stream: false`；
- Provider 会把最终文本封装成 Pi 事件流；
- Pi 上下文中存在 Tools 时，Provider 会明确报错；
- 不会在未验证前假设 Sophon 兼容 OpenAI Tool Calling。

接入 Trace Tool 前，需要确认：

1. 请求中的 `tools` 和 `tool_choice` 格式；
2. 响应中的 Tool Call 格式；
3. Tool Result 回传格式；
4. 是否支持连续多轮 Tool Calling；
5. 流式 Tool Call 的事件格式。

---

## OpenAI

OpenAI 使用 `pi-ai` 的内置 Provider，不需要自行实现 HTTP 请求或传入 `streamFn`。

### 环境变量

```dotenv
OPENAI_API_KEY=填写真实API密钥
OPENAI_MODEL_ID=gpt-5.4
```

`OPENAI_MODEL_ID` 必须存在于当前安装版本的 `pi-ai` 模型目录中。未知模型会在创建 Provider 时直接报错。

### 创建 Agent

```javascript
import { Agent } from "@mariozechner/pi-agent-core";
import { createOpenAIProvider } from "./src/providers/openai-model.mjs";

const { model, getApiKey } = createOpenAIProvider();

const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个 Trace 根因分析助手。",
    model,
    thinkingLevel: "medium",
  },
  getApiKey,
});

await agent.prompt("请分析这个问题");
```

### Provider 返回值

```javascript
const {
  config,    // OpenAI 配置，包含密钥，不要打印或持久化
  model,     // pi-ai 内置 OpenAI 模型描述
  getApiKey, // Pi 调用模型时按 Provider 获取密钥
} = createOpenAIProvider();
```

注意：OpenAI 使用 `pi-ai` 内置请求实现，创建 `Agent` 时不要传 Sophon 的 `streamFn`。

---

## Anthropic

Anthropic 同样使用 `pi-ai` 的内置 Provider，不需要自行实现 HTTP 请求或传入 `streamFn`。

### 使用 API Key

```dotenv
ANTHROPIC_API_KEY=填写真实API密钥
ANTHROPIC_MODEL_ID=claude-sonnet-4-6
```

### 使用 OAuth Token

```dotenv
ANTHROPIC_OAUTH_TOKEN=填写OAuth Token
ANTHROPIC_MODEL_ID=claude-sonnet-4-6
```

如果同时配置 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`，OAuth Token 优先。

### 创建 Agent

```javascript
import { Agent } from "@mariozechner/pi-agent-core";
import { createAnthropicProvider } from "./src/providers/anthropic-model.mjs";

const { model, getApiKey } = createAnthropicProvider();

const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个 Trace 根因分析助手。",
    model,
    thinkingLevel: "medium",
  },
  getApiKey,
});

await agent.prompt("请分析这个问题");
```

### Provider 返回值

```javascript
const {
  config,    // Anthropic 配置，包含凭证，不要打印或持久化
  model,     // pi-ai 内置 Anthropic 模型描述
  getApiKey, // Pi 调用模型时按 Provider 获取凭证
} = createAnthropicProvider();
```

---

## 查看当前支持的模型

模型 ID 列表由当前锁定的 `pi-ai` 版本提供。升级依赖后，可用列表可能变化。

### OpenAI

```bash
node --input-type=module -e \
  "import { getModels } from '@mariozechner/pi-ai'; console.log(getModels('openai').map(m => m.id).join('\\n'))"
```

### Anthropic

```bash
node --input-type=module -e \
  "import { getModels } from '@mariozechner/pi-ai'; console.log(getModels('anthropic').map(m => m.id).join('\\n'))"
```

---

## 配置安全

必须遵守以下约束：

- 真实密钥只放在本地 `.env` 或部署环境的 Secret 管理系统；
- 不要把密钥写进 JavaScript、测试数据、文档或 Git 历史；
- 不要打印完整 `config`，因为其中包含密钥；
- 不要记录完整鉴权 Header；
- `model` 对象不包含密钥，可以用于非敏感的模型信息日志；
- 生产环境应由运行平台注入环境变量，而不是随制品分发 `.env`。

当前 `.gitignore` 已包含：

```text
.env
```

提交前仍建议检查：

```bash
git status --short
```

---

## 测试

运行全部 Provider 离线测试：

```bash
npm test
```

测试文件：

```text
test/sophon-model.test.mjs
test/openai-model.test.mjs
test/anthropic-model.test.mjs
```

当前测试覆盖：

- 必填配置检查；
- 模型 ID 校验；
- 密钥不进入 `model` 描述；
- Anthropic OAuth Token 优先级；
- Sophon 请求 Header 和消息转换；
- Sophon 常见响应结构解析；
- Sophon 响应到 Pi 事件流的转换。

离线测试使用假密钥和 Mock HTTP 响应，不会访问真实模型服务。

---

## 常见问题

### `Missing required ... API_KEY`

对应 Provider 的密钥没有设置。确认使用 `--env-file=.env` 启动，或者已在当前 Shell 中导出环境变量。

### `Unknown ... model ID`

配置的模型 ID 不在当前 `pi-ai` 模型目录中。使用上面的 `getModels()` 命令查看支持列表。

### Sophon 返回 `Unsupported Sophon response shape`

Sophon 实际响应格式不在当前解析范围内。请保留一份脱敏后的成功响应 JSON，再更新 `extractSophonText()`；不要把 API Key 一并保存。

### Sophon 提示 Tool Calling 未配置

这是当前预期行为。需要先拿到 Sophon 的工具调用协议，再扩展 `sophon-model.mjs`。

### 模型请求失败，但离线测试通过

离线测试只验证本地适配逻辑。继续检查：

- 网络是否能访问目标服务；
- API Key 或 OAuth Token 是否有效；
- 模型 ID 是否有权限；
- Sophon 场景 Header 和操作者邮箱是否正确；
- 网关是否返回了非 2xx 状态码。

---

## 新增 Provider 的约定

新增模型服务时，在本目录创建独立文件：

```text
src/providers/<provider-name>-model.mjs
```

建议至少导出：

```javascript
export function loadProviderConfig(env = process.env) {}
export function createProvider(env = process.env) {}
```

### `pi-ai` 已内置协议

优先复用内置 Provider，返回：

```javascript
{
  config,
  model,
  getApiKey,
}
```

### 非标准模型协议

实现自定义 Pi `streamFn`，返回：

```javascript
{
  config,
  model,
  streamFn,
}
```

同时补充：

1. `.env.example` 配置项；
2. 本文档中的配置和使用示例；
3. `test/<provider-name>-model.test.mjs` 离线测试；
4. 错误处理和密钥防泄漏验证。

模型协议适配必须留在 Provider 层，不应进入 Trace RCA 领域代码。

## Sophon 连通性诊断

如果模型调用只显示 `fetch failed`，运行：

```bash
npm run diagnose:sophon
```

该命令只显示安全配置状态、DNS结果和一次最小模型请求结果，不打印 API Key 或完整邮箱。常见错误：

- `ENOTFOUND`：当前网络/DNS不能解析内部域名，先连接公司网络或VPN；
- `CERT_*` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`：Node未信任公司证书链；不要使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，应配置受信任CA；
- `ECONNREFUSED`：目标或代理拒绝连接；
- `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT`：路由、VPN或代理不可达；
- HTTP 401/403：网络已经连通，但 API Key、操作人或权限配置不正确。
