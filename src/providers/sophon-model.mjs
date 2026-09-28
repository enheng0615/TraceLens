import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const DEFAULT_ENDPOINT =
  "https://sophon-ai.bytedance.net/gateway/openapi/model/chatCompletion";

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required Sophon model setting: ${name}`);
  }
  return value;
}

function parseInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNumber(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

/**
 * Read Sophon model settings from environment variables.
 * Secrets stay in process.env and must never be committed to source control.
 */
export function loadSophonConfig(env = process.env) {
  return {
    endpoint: env.SOPHON_MODEL_ENDPOINT || DEFAULT_ENDPOINT,
    apiKey: required(env.SOPHON_MODEL_API_KEY, "SOPHON_MODEL_API_KEY"),
    modelId: required(env.SOPHON_MODEL_ID, "SOPHON_MODEL_ID"),
    operatorEmail: required(
      env.SOPHON_OPERATOR_EMAIL,
      "SOPHON_OPERATOR_EMAIL",
    ),
    sceneScope: env.SOPHON_SCENE_SCOPE || "1",
    sceneType: env.SOPHON_SCENE_TYPE || "1",
    isAgent: env.SOPHON_IS_AGENT || "2",
    temperature: parseNumber(
      env.SOPHON_TEMPERATURE,
      0.01,
      "SOPHON_TEMPERATURE",
    ),
    maxTokens: parseInteger(
      env.SOPHON_MAX_TOKENS,
      8192,
      "SOPHON_MAX_TOKENS",
    ),
    contextWindow: parseInteger(
      env.SOPHON_CONTEXT_WINDOW,
      128000,
      "SOPHON_CONTEXT_WINDOW",
    ),
  };
}

/**
 * Pi model descriptor. The custom stream function below performs the actual
 * Sophon request, so this API identifier does not need a pi-ai registry entry.
 */
export function createSophonModel(config) {
  return {
    id: config.modelId,
    name: `Sophon ${config.modelId}`,
    api: "sophon-chat-completion",
    provider: "sophon",
    baseUrl: config.endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return block.text;
      if (block?.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Convert Pi messages into the message shape shown by the Sophon curl sample. */
export function toSophonMessages(context) {
  const messages = [];

  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textFromBlocks(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: textFromBlocks(message.content),
      });
      continue;
    }

    // Sophon's tool-result protocol has not yet been provided. Preserve prior
    // results as plain context rather than pretending native tool-call support.
    if (message.role === "toolResult") {
      messages.push({
        role: "user",
        content: `[Tool result: ${message.toolName}]\n${textFromBlocks(message.content)}`,
      });
    }
  }

  return messages;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string");
}

/**
 * Accept several common chat-completion envelopes. Once Sophon's exact response
 * sample is available, keep the verified path and remove unnecessary fallbacks.
 */
export function extractSophonText(payload) {
  const text = firstString(
    payload?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.text,
    payload?.data?.choices?.[0]?.message?.content,
    payload?.data?.choices?.[0]?.text,
    payload?.data?.message?.content,
    payload?.data?.content,
    payload?.result?.message?.content,
    payload?.result?.content,
    payload?.message?.content,
    payload?.content,
    payload?.answer,
  );

  if (text === undefined) {
    throw new Error(
      "Unsupported Sophon response shape: no assistant text was found",
    );
  }
  return text;
}

function createMessage(model, content, stopReason, errorMessage) {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(EMPTY_USAGE),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function emitText(stream, model, text) {
  const partial = createMessage(model, "", "stop");
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial });

  const contentPartial = createMessage(model, text, "stop");
  if (text) {
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: contentPartial,
    });
  }
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: contentPartial,
  });

  const message = createMessage(model, text, "stop");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
}

function safeDiagnosticPart(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|access_token|jwt)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/[A-Z0-9._%+-]+@(?:bytedance|byteintl)\.com/gi, "<redacted-email>");
}

/** Preserve useful network causes without exposing request headers or secrets. */
export function formatSophonError(error) {
  if (!(error instanceof Error)) return safeDiagnosticPart(error) || "Unknown Sophon error";
  const cause = error.cause;
  const details = [
    safeDiagnosticPart(error.message),
    cause?.code ? `code=${safeDiagnosticPart(cause.code)}` : undefined,
    cause?.syscall ? `syscall=${safeDiagnosticPart(cause.syscall)}` : undefined,
    cause?.hostname ? `hostname=${safeDiagnosticPart(cause.hostname)}` : undefined,
    cause?.address ? `address=${safeDiagnosticPart(cause.address)}` : undefined,
    cause?.port ? `port=${safeDiagnosticPart(cause.port)}` : undefined,
    cause?.message && cause.message !== error.message
      ? `cause=${safeDiagnosticPart(cause.message)}`
      : undefined,
  ].filter(Boolean);
  return details.join("; ");
}

function emitError(stream, model, error, aborted = false) {
  const errorMessage = formatSophonError(error);
  const message = createMessage(
    model,
    "",
    aborted ? "aborted" : "error",
    errorMessage,
  );
  stream.push({
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: message,
  });
  stream.end(message);
}

/**
 * Create the Pi streamFn adapter for Sophon's non-streaming chatCompletion API.
 * The returned function follows Pi's event-stream contract.
 */
export function createSophonStreamFn(config, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required");
  }

  return (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      try {
        if (context.tools?.length) {
          throw new Error(
            "Sophon tool-calling protocol is not configured yet. Provide a verified request/response example before enabling Agent tools.",
          );
        }

        const response = await fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            "api-key": config.apiKey,
            "Content-Type": "application/json",
            "x-modelhub-scene-scope": config.sceneScope,
            "x-modelhub-scene-type": config.sceneType,
            "x-modelhub-is-agent": config.isAgent,
            "x-modelhub-operator-email": config.operatorEmail,
          },
          body: JSON.stringify({
            model: config.modelId,
            messages: toSophonMessages(context),
            temperature: config.temperature,
            n: 1,
            stream: false,
            cache: true,
          }),
          signal: options.signal,
        });

        const rawBody = await response.text();
        let payload;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          throw new Error(
            `Sophon returned non-JSON data (HTTP ${response.status}): ${rawBody.slice(0, 500)}`,
          );
        }

        if (!response.ok) {
          throw new Error(
            `Sophon request failed (HTTP ${response.status}): ${JSON.stringify(payload).slice(0, 1000)}`,
          );
        }

        emitText(stream, model, extractSophonText(payload));
      } catch (error) {
        emitError(stream, model, error, options.signal?.aborted === true);
      }
    })();

    return stream;
  };
}

/** Build everything Pi needs for the Sophon-backed Agent constructor. */
export function createSophonProvider(env = process.env, dependencies = {}) {
  const config = loadSophonConfig(env);
  return {
    config,
    model: createSophonModel(config),
    streamFn: createSophonStreamFn(config, dependencies),
  };
}
