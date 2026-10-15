import { Agent } from "@mariozechner/pi-agent-core";
import { parseJsonWithRepair } from "@mariozechner/pi-ai";
import { createSophonProvider } from "../providers/sophon-model.mjs";

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function extractAgentJson(text) {
  const trimmed = text.trim();
  // JSON values may themselves contain Markdown fences copied from Trace.
  // Prefer the actual object before considering an outer Markdown wrapper.
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```\s*$/i)?.[1];
  const candidate = trimmed.startsWith("{") ? trimmed : fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Model response did not contain a JSON object");
  const value = parseJsonWithRepair(candidate);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model response must be a JSON object");
  return value;
}

function isTransientTransportError(message) {
  return /UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|EAI_AGAIN|other side closed/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PiJsonAgent {
  constructor({ env = process.env, logger } = {}) {
    this.provider = createSophonProvider(env);
    this.logger = logger;
    this.transportRetries = Number.parseInt(env.SOPHON_TRANSPORT_RETRIES || "2", 10);
    this.maxPromptChars = Number.parseInt(env.RCA_MAX_MODEL_PROMPT_CHARS || "65000", 10);
  }

  modelInfo() {
    return {
      runtime: "@mariozechner/pi-agent-core",
      provider: this.provider.model.provider,
      modelId: this.provider.model.id,
      nativeToolCalling: false,
      toolMode: "application-level structured actions",
    };
  }

  async invoke({ phase, systemPrompt, prompt, retryInstruction }) {
    if (prompt.length > this.maxPromptChars) {
      throw new Error(
        `Model prompt exceeds RCA_MAX_MODEL_PROMPT_CHARS: ${prompt.length} > ${this.maxPromptChars}`,
      );
    }
    let previousText = "";
    for (let formatAttempt = 1; formatAttempt <= 2; formatAttempt += 1) {
      let input =
        formatAttempt === 1
          ? prompt
          : `${prompt}\n\n上一次输出无法通过JSON或业务校验。请只返回一个合法JSON对象，不要Markdown。修正要求：${retryInstruction ?? "严格遵循输出结构"}\n上一次输出：\n${previousText.slice(0, 5000)}`;
      if (input.length > this.maxPromptChars) {
        const fixed = `${prompt}\n\n上一次输出无法通过JSON或业务校验。请只返回一个合法JSON对象，不要Markdown。修正要求：${retryInstruction ?? "严格遵循输出结构"}\n上一次输出（按预算截断）：\n`;
        input = `${fixed}${previousText.slice(0, Math.max(0, this.maxPromptChars - fixed.length))}`;
      }
      if (input.length > this.maxPromptChars) {
        const error = new Error(`Model retry prompt exceeds RCA_MAX_MODEL_PROMPT_CHARS after deterministic compaction: ${input.length} > ${this.maxPromptChars}`);
        error.code = "RCA_CONTEXT_BUDGET_EXHAUSTED";
        throw error;
      }

      let text;
      for (let transportAttempt = 1; transportAttempt <= this.transportRetries + 1; transportAttempt += 1) {
        const agent = new Agent({
          initialState: { systemPrompt, model: this.provider.model },
          streamFn: this.provider.streamFn,
        });
        await this.logger?.event({
          phase,
          actor: "orchestrator",
          type: "model_request",
          summary: `调用 Pi/Sophon（格式尝试 ${formatAttempt}，网络尝试 ${transportAttempt}）`,
          data: {
            model: this.modelInfo(),
            promptChars: input.length,
            maxPromptChars: this.maxPromptChars,
          },
        });
        await agent.prompt(input);
        if (!agent.state.errorMessage) {
          const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
          text = assistantText(message);
          break;
        }

        const transient = isTransientTransportError(agent.state.errorMessage);
        await this.logger?.event({
          phase,
          actor: "pi_sophon",
          type: "model_request_failed",
          summary: agent.state.errorMessage,
          data: { model: this.modelInfo(), formatAttempt, transportAttempt, transient },
        });
        if (!transient || transportAttempt > this.transportRetries) {
          throw new Error(agent.state.errorMessage);
        }
        const delayMs = 1000 * 2 ** (transportAttempt - 1);
        await this.logger?.event({
          phase,
          actor: "orchestrator",
          type: "model_request_retry_scheduled",
          summary: `临时网络错误，${delayMs}ms后重试同一请求`,
          data: { delayMs, transportAttempt },
        });
        await sleep(delayMs);
      }

      previousText = text ?? "";
      try {
        const parsed = extractAgentJson(previousText);
        await this.logger?.event({
          phase,
          actor: "rca_agent",
          type: "model_response",
          summary: "模型返回了可解析的结构化结果",
          data: parsed,
        });
        return parsed;
      } catch (error) {
        await this.logger?.event({
          phase,
          actor: "validator",
          type: "model_response_rejected",
          summary: error.message,
          data: { responsePreview: previousText.slice(0, 3000) },
        });
        if (formatAttempt === 2) throw error;
      }
    }
    throw new Error("Unreachable");
  }
}
