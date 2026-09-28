import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnthropicProvider,
  loadAnthropicConfig,
} from "../src/providers/anthropic-model.mjs";

test("creates an Anthropic provider without storing its API key in the model", () => {
  const provider = createAnthropicProvider({
    ANTHROPIC_API_KEY: "test-anthropic-key",
    ANTHROPIC_MODEL_ID: "claude-sonnet-4-6",
  });

  assert.equal(provider.model.provider, "anthropic");
  assert.equal(provider.getApiKey("anthropic"), "test-anthropic-key");
  assert.equal(JSON.stringify(provider.model).includes("test-anthropic-key"), false);
});

test("prefers the Anthropic OAuth token when both credentials exist", () => {
  const config = loadAnthropicConfig({
    ANTHROPIC_API_KEY: "api-key",
    ANTHROPIC_OAUTH_TOKEN: "oauth-token",
  });

  assert.equal(config.apiKey, "oauth-token");
  assert.equal(config.authType, "oauth");
});

test("requires an Anthropic credential", () => {
  assert.throws(
    () => loadAnthropicConfig({}),
    /ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN/,
  );
});

test("rejects an unknown Anthropic model ID", () => {
  assert.throws(
    () =>
      createAnthropicProvider({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_MODEL_ID: "not-a-real-model",
      }),
    /Unknown Anthropic model ID/,
  );
});
