import test from "node:test";
import assert from "node:assert/strict";
import { extractAgentJson } from "../../src/rca/pi-json-agent.mjs";

test("does not mistake Markdown source quotes inside JSON for an outer response fence", () => {
  const value = { quote: "```text\n取数图表：客户AI期间消耗明细\n```", actions: [] };
  assert.deepEqual(extractAgentJson(JSON.stringify(value)), value);
  assert.deepEqual(extractAgentJson(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), value);
  assert.deepEqual(extractAgentJson(`Result:\n${JSON.stringify(value)}`), value);
  assert.throws(() => extractAgentJson("plain text"), /JSON object/);
});
