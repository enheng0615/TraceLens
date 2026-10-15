import assert from "node:assert/strict";
import test from "node:test";
import { resolveEvaluatedAnswer } from "../../src/workflows/trace-rca/answer-resolver.mjs";

function tool({ id, name, input, output = "", startTime }) {
  return { id, spanType: "TOOL", name, input: JSON.stringify({ tool_name: name, arguments: input }), output, startTime };
}

const url = "https://bytedance.larkoffice.com/docx/example";

test("resolves a published lark document to its preceding write_file body", async () => {
  const repository = { spans: [
    tool({ id: "write", name: "write_file", input: { file_path: "output/report.lark.md", content: "# complete report" }, startTime: 1 }),
    tool({ id: "publish", name: "lark_doc", input: { file_path: "/home/ida/session/output/report.lark.md" }, output: url, startTime: 2 }),
  ] };
  const result = await resolveEvaluatedAnswer({
    traceRoot: "/unused",
    suppliedAnswer: `[报告](${url})\npartial\n[内容过长，已截断]`,
    traceExchange: { idaAnswer: "delivery summary", spanId: "agent" },
    repository,
  });
  assert.equal(result.content, "# complete report");
  assert.equal(result.resolution, "published_artifact_from_trace");
  assert.deepEqual(result.provenance, {
    artifactToolSpanId: "write",
    publishToolSpanId: "publish",
    artifactPath: "output/report.lark.md",
    publishedPath: "/home/ida/session/output/report.lark.md",
    publishedUrl: url,
    deliveryAgentSpanId: "agent",
  });
});

test("fails closed when the same published URL maps to multiple publish spans", async () => {
  const repository = { spans: [
    tool({ id: "publish-1", name: "lark_doc", input: { file_path: "output/a.md" }, output: url, startTime: 1 }),
    tool({ id: "publish-2", name: "lark_doc", input: { file_path: "output/b.md" }, output: url, startTime: 2 }),
  ] };
  await assert.rejects(
    resolveEvaluatedAnswer({ suppliedAnswer: url, traceExchange: { idaAnswer: "summary" }, repository }),
    (error) => error.code === "AMBIGUOUS_PUBLISHED_ARTIFACT",
  );
});

test("uses complete AGENT output only for a truncated non-artifact answer", async () => {
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer: "partial\n[内容过长，已截断]",
    traceExchange: { idaAnswer: "complete AGENT answer", spanId: "agent" },
  });
  assert.equal(result.resolution, "explicitly_truncated_input_replaced_with_trace_output");
  assert.equal(result.content, "complete AGENT answer");
});

test("accepts a long exact Trace answer suffix while preserving the scored supplied answer", async () => {
  const traceAnswer = `Final answer: ${"evidence ".repeat(30)}`.trim();
  const suppliedAnswer = `I need to look this up first. ${traceAnswer}`;
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer,
    traceExchange: { idaAnswer: traceAnswer, spanId: "agent" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.content, suppliedAnswer);
  assert.equal(result.resolution, "trace_answer_exact_suffix_of_supplied_answer");
  assert.equal(result.provenance.alignment.method, "exact_suffix");
  assert.equal(result.provenance.alignment.suppliedPrefixChars, suppliedAnswer.length - traceAnswer.length);
});

test("rejects short or non-dominant suffix matches instead of using fuzzy alignment", async () => {
  const short = await resolveEvaluatedAnswer({
    suppliedAnswer: `wrapper ${"x".repeat(100)}`,
    traceExchange: { idaAnswer: "x".repeat(100), spanId: "agent" },
  });
  assert.equal(short.accepted, false);
  const nonDominant = await resolveEvaluatedAnswer({
    suppliedAnswer: `${"prefix ".repeat(100)}${"z".repeat(220)}`,
    traceExchange: { idaAnswer: "z".repeat(220), spanId: "agent" },
  });
  assert.equal(nonDominant.accepted, false);
});

test("accepts only an exact rendered-Markdown match when export rewrites link targets", async () => {
  const supplied = "正文\n\n[^1]: [员工手册](员工手册 )";
  const trace = "正文\n\n[^1]: [员工手册](https://bytedance.larkoffice.com/wiki/abc)";
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer: supplied,
    traceExchange: { idaAnswer: trace, spanId: "agent" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.content, supplied);
  assert.equal(result.resolution, "markdown_link_target_normalized_exact_match");
  assert.equal(result.provenance.alignment.method, "markdown_link_target_normalized_exact");
});

test("does not hide changed prose behind Markdown link normalization", async () => {
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer: "错误正文 [文档](文档)",
    traceExchange: { idaAnswer: "正确正文 [文档](https://example.com)", spanId: "agent" },
  });
  assert.equal(result.accepted, false);
});

test("accepts an exact Trace answer prefix followed by delivered attachment bodies", async () => {
  const traceAnswer = `# 分析报告\n${"正文证据。".repeat(50)}`;
  const suppliedAnswer = `${traceAnswer}\n\n---\n\n## 附件内容：analysis.csv\na,b\n1,2`;
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer, traceExchange: { idaAnswer: traceAnswer, spanId: "agent" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.content, suppliedAnswer);
  assert.equal(result.resolution, "trace_answer_exact_prefix_with_delivered_artifacts");
  assert.equal(result.provenance.alignment.appendedArtifactChars > 0, true);
});

test("accepts Markdown answers differing only by redundant blank lines", async () => {
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer: "截图如下\n\n正文\n",
    traceExchange: { idaAnswer: "截图如下\n\n\n\n正文", spanId: "agent" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.resolution, "markdown_link_target_normalized_exact_match");
});

test("accepts rendered-Markdown exact answer body followed by delivered attachments", async () => {
  const traceAnswer = "# 分析报告\n\n\n\n| 指标 | 值 |\n|---|---:|\n| 主板 | -0.01 |\n\n" + "正文。".repeat(80);
  const suppliedAnswer = "# 分析报告\n\n| 指标 | 值 |\n|---|---:|\n| 主板 | -0.01 |\n\n" + "正文。".repeat(80) + "\n\n---\n\n## 附件内容：output.csv\n主板,-0.01";
  const result = await resolveEvaluatedAnswer({
    suppliedAnswer, traceExchange: { idaAnswer: traceAnswer, spanId: "agent-54" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.content, suppliedAnswer);
  assert.equal(result.resolution, "trace_answer_markdown_exact_with_delivered_artifacts");
  assert.equal(result.provenance.alignment.appendedArtifactChars > 0, true);
});
