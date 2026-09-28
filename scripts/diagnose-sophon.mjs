#!/usr/bin/env node
import dns from "node:dns/promises";
import { Agent } from "@mariozechner/pi-agent-core";
import { createSophonProvider } from "../src/providers/sophon-model.mjs";

function causeDetails(error) {
  const cause = error?.cause;
  return {
    name: error?.name,
    message: error?.message,
    code: cause?.code ?? error?.code,
    syscall: cause?.syscall,
    hostname: cause?.hostname,
    address: cause?.address,
    port: cause?.port,
    cause: cause?.message,
  };
}

const provider = createSophonProvider();
const endpoint = new URL(provider.config.endpoint);
console.log("Sophon safe configuration:");
console.log(JSON.stringify({
  protocol: endpoint.protocol,
  host: endpoint.host,
  path: endpoint.pathname,
  modelId: provider.model.id,
  apiKeyConfigured: Boolean(provider.config.apiKey),
  operatorEmailConfigured: Boolean(provider.config.operatorEmail),
  node: process.version,
  httpsProxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
  noProxyConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
}, null, 2));

try {
  const answer = await dns.lookup(endpoint.hostname);
  console.log("DNS lookup: OK", JSON.stringify({ family: answer.family }));
} catch (error) {
  console.error("DNS lookup: FAILED", JSON.stringify(causeDetails(error)));
}

console.log("Minimal Pi/Sophon request: starting");
const agent = new Agent({
  initialState: {
    systemPrompt: "只返回JSON，不要解释。",
    model: provider.model,
  },
  streamFn: provider.streamFn,
});
await agent.prompt('只返回 {"ok":true}');
if (agent.state.errorMessage) {
  console.error(`Minimal Pi/Sophon request: FAILED: ${agent.state.errorMessage}`);
  process.exitCode = 1;
} else {
  const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
  const text = message?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  console.log(`Minimal Pi/Sophon request: OK (${text.length} response chars)`);
}
