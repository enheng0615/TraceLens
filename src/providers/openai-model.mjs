import { getModel, getModels } from "@mariozechner/pi-ai";

const DEFAULT_MODEL_ID = "gpt-5.4";

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required OpenAI model setting: ${name}`);
  }
  return value;
}

function findModel(modelId) {
  const model = getModels("openai").find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(
      `Unknown OpenAI model ID for the installed pi-ai version: ${modelId}`,
    );
  }
  return getModel("openai", model.id);
}

/** Read OpenAI settings without copying the secret into the model descriptor. */
export function loadOpenAIConfig(env = process.env) {
  return {
    apiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    modelId: env.OPENAI_MODEL_ID || DEFAULT_MODEL_ID,
  };
}

/**
 * Create the OpenAI Provider values consumed by Pi Agent Core.
 * pi-ai supplies the built-in stream implementation, so no custom streamFn is needed.
 */
export function createOpenAIProvider(env = process.env) {
  const config = loadOpenAIConfig(env);
  return {
    config,
    model: findModel(config.modelId),
    getApiKey(provider) {
      return provider === "openai" ? config.apiKey : undefined;
    },
  };
}
