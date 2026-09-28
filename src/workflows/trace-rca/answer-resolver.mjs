import { TraceRepository } from "../../rca/trace-repository.mjs";
import { markdownDisplayExact, normalizeMarkdownLinkTargets } from "./content-alignment.mjs";

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function comparable(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

export function hasExplicitAttachmentTruncation(value) {
  const text = String(value ?? "");
  return /内容过长[，,].*已截断/.test(text) || /original (?:content )?length.*truncated/i.test(text);
}

function larkDocUrls(value) {
  return [...new Set(String(value ?? "").match(/https:\/\/[^\s)\]"']*larkoffice\.com\/docx\/[^\s)\]"']+/gi) ?? [])];
}

function toolArguments(span) {
  return parseJson(span?.input)?.arguments ?? {};
}

function normalizeFilePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
}

function sameArtifactPath(left, right) {
  const a = normalizeFilePath(left);
  const b = normalizeFilePath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function publishedArtifact(repository, suppliedAnswer) {
  const urls = larkDocUrls(suppliedAnswer);
  if (!urls.length) return null;
  const publishCandidates = repository.spans.filter(
    (span) => span.spanType === "TOOL" && span.name === "lark_doc" && urls.some((url) => String(span.output ?? "").includes(url)),
  );
  if (publishCandidates.length > 1) {
    const error = new Error(`Multiple lark_doc spans match the evaluated answer URL: ${publishCandidates.map((item) => item.id).join(", ")}`);
    error.code = "AMBIGUOUS_PUBLISHED_ARTIFACT";
    throw error;
  }
  const publish = publishCandidates[0];
  if (!publish) return null;
  const publishedUrl = urls.find((url) => String(publish.output ?? "").includes(url));
  const publishedPath = toolArguments(publish).file_path;
  const writes = repository.spans
    .filter((span) => span.spanType === "TOOL" && span.name === "write_file" && Number(span.startTime) <= Number(publish.startTime))
    .map((span) => ({ span, args: toolArguments(span) }))
    .filter(({ args }) => sameArtifactPath(args.file_path, publishedPath) && typeof args.content === "string" && args.content.trim())
    .sort((a, b) => Number(a.span.startTime) - Number(b.span.startTime));
  const write = writes.at(-1);
  if (!write) {
    const error = new Error(`lark_doc span ${publish.id} has no preceding write_file source for ${publishedPath}`);
    error.code = "PUBLISHED_ARTIFACT_SOURCE_NOT_FOUND";
    throw error;
  }
  return {
    content: write.args.content,
    resolution: "published_artifact_from_trace",
    accepted: true,
    provenance: {
      artifactToolSpanId: write.span.id,
      publishToolSpanId: publish.id,
      artifactPath: write.args.file_path,
      publishedPath,
      publishedUrl,
    },
  };
}

/** Resolve the exact answer object evaluated upstream, failing closed on ambiguity. */
export async function resolveEvaluatedAnswer({
  traceRoot,
  suppliedAnswer,
  traceExchange,
  repository,
}) {
  const source = comparable(suppliedAnswer);
  const agent = comparable(traceExchange?.idaAnswer);
  if (source && source === agent) {
    return {
      content: String(traceExchange.idaAnswer),
      resolution: "exact_agent_output",
      accepted: true,
      provenance: { deliveryAgentSpanId: traceExchange.spanId ?? null },
    };
  }

  if (source && agent && markdownDisplayExact(source, agent)) {
    return {
      content: String(suppliedAnswer),
      resolution: "markdown_link_target_normalized_exact_match",
      accepted: true,
      provenance: {
        deliveryAgentSpanId: traceExchange?.spanId ?? null,
        alignment: {
          method: "markdown_link_target_normalized_exact",
          suppliedChars: source.length,
          traceAnswerChars: agent.length,
          normalizedChars: normalizeMarkdownLinkTargets(source).length,
        },
      },
    };
  }

  // Some evaluation exports prepend a delivery narration to the exact final
  // AGENT answer. Accept only a long, dominant, exact suffix: no fuzzy or
  // semantic matching, and keep the actually scored supplied answer intact.
  if (source && agent && source.endsWith(agent)) {
    const ratio = agent.length / source.length;
    const prefixChars = source.length - agent.length;
    if (agent.length >= 200 && ratio >= 0.8 && prefixChars > 0) {
      return {
        content: String(suppliedAnswer),
        resolution: "trace_answer_exact_suffix_of_supplied_answer",
        accepted: true,
        provenance: {
          deliveryAgentSpanId: traceExchange?.spanId ?? null,
          alignment: {
            method: "exact_suffix",
            suppliedChars: source.length,
            traceAnswerChars: agent.length,
            suppliedPrefixChars: prefixChars,
            traceShare: Number(ratio.toFixed(6)),
          },
        },
      };
    }
  }

  if (larkDocUrls(suppliedAnswer).length) {
    const repo = repository ?? await TraceRepository.open(traceRoot);
    const artifact = publishedArtifact(repo, suppliedAnswer);
    if (artifact) {
      return {
        ...artifact,
        provenance: { ...artifact.provenance, deliveryAgentSpanId: traceExchange?.spanId ?? null },
      };
    }
  }

  if (hasExplicitAttachmentTruncation(suppliedAnswer) && agent) {
    return {
      content: String(traceExchange.idaAnswer),
      resolution: "explicitly_truncated_input_replaced_with_trace_output",
      accepted: true,
      provenance: { deliveryAgentSpanId: traceExchange.spanId ?? null },
    };
  }

  return {
    content: String(suppliedAnswer || traceExchange?.idaAnswer || ""),
    resolution: "unresolved_mismatch",
    accepted: false,
    provenance: { deliveryAgentSpanId: traceExchange?.spanId ?? null },
  };
}
