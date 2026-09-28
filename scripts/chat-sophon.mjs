import { Agent } from "@mariozechner/pi-agent-core";
import { createSophonProvider } from "../src/providers/sophon-model.mjs";

const { model, streamFn } = createSophonProvider();
const prompt = process.argv.slice(2).join(" ") || "请用一句话介绍你自己。";

const agent = new Agent({
  initialState: {
    systemPrompt: "你是 Trace 根因分析助手。回答必须简洁、准确。",
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

  if (event.type === "agent_end") {
    process.stdout.write("\n");
  }
});

await agent.prompt(prompt);

if (agent.state.errorMessage) {
  console.error(`Sophon model call failed: ${agent.state.errorMessage}`);
  process.exitCode = 1;
}
