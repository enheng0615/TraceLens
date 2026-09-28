import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAIProvider,
  loadOpenAIConfig,
} from "../src/providers/openai-model.mjs";

test("creates an OpenAI provider without storing its API key in the model", () => {
  const provider = createOpenAIProvider({
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_MODEL_ID: "gpt-5.4",
  });

  assert.equal(provider.model.provider, "openai");
  assert.equal(provider.getApiKey("openai"), "test-openai-key");
  assert.equal(JSON.stringify(provider.model).includes("test-openai-key"), false);
});

test("requires an OpenAI API key", () => {
  assert.throws(() => loadOpenAIConfig({}), /OPENAI_API_KEY/);
});

test("rejects an unknown OpenAI model ID", () => {
  assert.throws(
    () =>
      createOpenAIProvider({
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL_ID: "not-a-real-model",
      }),
    /Unknown OpenAI model ID/,
  );
});
