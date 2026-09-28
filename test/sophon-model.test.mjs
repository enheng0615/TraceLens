import assert from "node:assert/strict";
import test from "node:test";
import {
  createSophonModel,
  createSophonStreamFn,
  extractSophonText,
  loadSophonConfig,
  formatSophonError,
} from "../src/providers/sophon-model.mjs";

const env = {
  SOPHON_MODEL_API_KEY: "test-key",
  SOPHON_MODEL_ID: "test-model",
  SOPHON_OPERATOR_EMAIL: "tester@example.com",
};

test("loads config without exposing secrets in the model descriptor", () => {
  const config = loadSophonConfig(env);
  const model = createSophonModel(config);
  assert.equal(model.id, "test-model");
  assert.equal(model.provider, "sophon");
  assert.equal(JSON.stringify(model).includes("test-key"), false);
});

test("extracts OpenAI-style and wrapped Sophon response text", () => {
  assert.equal(
    extractSophonText({ choices: [{ message: { content: "hello" } }] }),
    "hello",
  );
  assert.equal(
    extractSophonText({ data: { choices: [{ message: { content: "world" } }] } }),
    "world",
  );
});

test("adapts a Sophon response to Pi assistant events", async () => {
  const config = loadSophonConfig(env);
  let capturedRequest;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, init };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "mock answer" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const streamFn = createSophonStreamFn(config, { fetchImpl });
  const model = createSophonModel(config);
  const stream = streamFn(model, {
    systemPrompt: "system instruction",
    messages: [{ role: "user", content: "question", timestamp: Date.now() }],
  });
  const message = await stream.result();

  assert.equal(capturedRequest.url, config.endpoint);
  assert.equal(capturedRequest.init.headers["api-key"], "test-key");
  assert.deepEqual(JSON.parse(capturedRequest.init.body).messages, [
    { role: "system", content: "system instruction" },
    { role: "user", content: "question" },
  ]);
  assert.equal(message.content[0].text, "mock answer");
  assert.equal(message.stopReason, "stop");
});


test("preserves safe nested network diagnostics", () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND sophon-ai.bytedance.net"), {
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "sophon-ai.bytedance.net",
  });
  const error = new TypeError("fetch failed", { cause });
  assert.equal(
    formatSophonError(error),
    "fetch failed; code=ENOTFOUND; syscall=getaddrinfo; hostname=sophon-ai.bytedance.net; cause=getaddrinfo ENOTFOUND sophon-ai.bytedance.net",
  );
});
