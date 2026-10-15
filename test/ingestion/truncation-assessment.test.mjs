import assert from "node:assert/strict";
import test from "node:test";
import { assessEmbeddedResultTruncation } from "../../src/ingestion/sophon-trace/truncation-assessment.mjs";

test("classifies a shortened resource copy as available when a sibling output has the full payload", () => {
  const full = "x".repeat(23_518);
  const wrapper = JSON.stringify({
    output: full,
    resources: [{
      result: `${full.slice(0, 9_986)}...[truncated]`,
      isResultTruncated: true,
      originalResultChars: 23_530,
      fullResultDownloadUrl: "https://ida.bytedance.net/dataAgent/llm/api/v2/deepresearch/images?file_path=a.md",
    }],
  });
  const result = assessEmbeddedResultTruncation(wrapper, "$.data.output");
  assert.equal(result.length, 1);
  assert.equal(result[0].classification, "display_copy_truncated_payload_available");
  assert.equal(result[0].alternatePayload.path, "$.data.output.output");
  assert.equal(result[0].alternatePayload.chars, 23_518);
});

test("classifies a shortened result without an alternate full payload as missing", () => {
  const wrapper = JSON.stringify({
    output: "persisted-output://pointer",
    resources: [{
      result: `${"x".repeat(9_986)}...[truncated]`,
      isResultTruncated: true,
      originalResultChars: 99_178,
      fullResultDownloadUrl: "https://ida.bytedance.net/dataAgent/llm/api/v2/deepresearch/images?file_path=a.md",
    }],
  });
  const result = assessEmbeddedResultTruncation(wrapper, "$.data.output");
  assert.equal(result.length, 1);
  assert.equal(result[0].classification, "source_payload_missing");
  assert.equal(result[0].alternatePayload, null);
});

test("does not accept an unrelated sibling merely because its length matches", () => {
  const wrapper = JSON.stringify({
    output: "y".repeat(23_518),
    resources: [{
      result: `${"x".repeat(9_986)}...[truncated]`,
      isResultTruncated: true,
      originalResultChars: 23_530,
    }],
  });
  const [result] = assessEmbeddedResultTruncation(wrapper, "$.data.output");
  assert.equal(result.classification, "source_payload_missing");
});

test("matches a fenced display preview to the saved body", () => {
  const full = "record 123\n".repeat(1_500);
  const wrapper = JSON.stringify({
    output: full,
    resources: [{
      result: `\`\`\`text\n${full.slice(0, 9_976)}\n...[truncated]`,
      isResultTruncated: true,
      originalResultChars: full.length + 12,
    }],
  });
  const [result] = assessEmbeddedResultTruncation(wrapper, "$.data.output");
  assert.equal(result.classification, "display_copy_truncated_payload_available");
});
