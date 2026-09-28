import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { traceText } from "./trace-repository.mjs";

function markdownValue(value, maxChars = 8000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const shown = text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... <Markdown日志已截取；完整事件见agent-run.jsonl>`;
  return `\n\n\`\`\`json\n${shown}\n\`\`\``;
}

export class RunLogger {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.jsonlPath = path.join(outputDir, "agent-run.jsonl");
    this.markdownPath = path.join(outputDir, "agent-run.md");
    this.sequence = 0;
  }

  async initialize(meta) {
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(this.jsonlPath, "", "utf8");
    await writeFile(
      this.markdownPath,
      `# Trace RCA Agent 运行日志\n\n- Run ID: ${meta.runId}\n- Session: ${meta.sessionId}\n- Started: ${meta.startedAt}\n- Runtime: RCA Orchestrator + application-level Trace tools（具体模型模式见bootstrap事件）\n\n> 日志记录的是模型显式输出的调查摘要、行动请求与工具结果，不记录或声称暴露模型隐藏思维链。\n\n`,
      "utf8",
    );
  }

  async resume() {
    await mkdir(this.outputDir, { recursive: true });
    try {
      const text = await readFile(this.jsonlPath, "utf8");
      const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      this.sequence = Math.max(0, ...records.map((record) => record.sequence || 0));
    } catch {
      throw new Error(`Cannot resume run without readable log: ${this.jsonlPath}`);
    }
  }

  async event({ phase, actor, type, summary, data }) {
    this.sequence += 1;
    const record = {
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      phase,
      actor,
      type,
      summary: traceText.redact(summary),
      data: data === undefined ? undefined : JSON.parse(traceText.redact(JSON.stringify(data))),
    };
    await appendFile(this.jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
    const title = `${String(this.sequence).padStart(2, "0")} · ${phase} · ${actor} · ${type}`;
    await appendFile(
      this.markdownPath,
      `## ${title}\n\n${record.summary || ""}${record.data === undefined ? "" : markdownValue(record.data)}\n\n`,
      "utf8",
    );
    return record;
  }
}
