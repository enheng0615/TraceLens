import { getModel, getModels } from "@mariozechner/pi-ai";

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required Anthropic model setting: ${name}`);
  }
  return value;
}

function findModel(modelId) {
  const model = getModels("anthropic").find(
    (candidate) => candidate.id === modelId,
  );
  if (!model) {
    throw new Error(
      `Unknown Anthropic model ID for the installed pi-ai version: ${modelId}`,
    );
  }
  return getModel("anthropic", model.id);
}

/**
 * Anthropic supports either a regular API key or an OAuth token. OAuth takes
 * precedence, matching pi-ai's built-in environment-variable behavior.
 */
export function loadAnthropicConfig(env = process.env) {
  const credential = env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
  return {
    apiKey: required(
      credential,
      "ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN",
    ),
    authType: env.ANTHROPIC_OAUTH_TOKEN ? "oauth" : "api-key",
    modelId: env.ANTHROPIC_MODEL_ID || DEFAULT_MODEL_ID,
  };
}

/**
 * Create the Anthropic Provider values consumed by Pi Agent Core.
 * pi-ai supplies the built-in stream implementation, so no custom streamFn is needed.
 */
export function createAnthropicProvider(env = process.env) {
  const config = loadAnthropicConfig(env);
  return {
    config,
    model: findModel(config.modelId),
    getApiKey(provider) {
      return provider === "anthropic" ? config.apiKey : undefined;
    },
  };
}
