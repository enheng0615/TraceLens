import { createHash } from "node:crypto";
import path from "node:path";
import { isValidJsonFile, readJson, safeFileName, writeJsonAtomic } from "./file-store.mjs";

const ALLOWED_HOST = "ida.bytedance.net";
const ALLOWED_PATH = "/dataAgent/llm/api/v2/deepresearch/images";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function redactInternalDownloadUrls(value) {
  return String(value ?? "")
    .replace(/(["']?(?:fullResultDownloadUrl|downloadUrl)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1<redacted-internal-download-url>$2")
    .replace(/https:\/\/ida\.bytedance\.net\/dataAgent\/llm\/api\/v2\/deepresearch\/images\?[^\s"']+/gi, "<redacted-internal-download-url>");
}

function safeDownloadUrl(value) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.hostname !== ALLOWED_HOST || url.pathname !== ALLOWED_PATH) {
    const error = new Error("Rejected untrusted fullResultDownloadUrl");
    error.code = "UNTRUSTED_EXPANDED_RESULT_URL";
    throw error;
  }
  if (!url.searchParams.get("file_path")) {
    const error = new Error("fullResultDownloadUrl is missing file_path");
    error.code = "INVALID_EXPANDED_RESULT_URL";
    throw error;
  }
  return url;
}

function collectDescriptors(value, result = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return result;
  if (typeof value === "string") {
    const text = value.trim();
    if ((text.startsWith("{") || text.startsWith("[")) && text.length <= 10_000_000) {
      try { collectDescriptors(JSON.parse(text), result, depth + 1); } catch {}
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectDescriptors(child, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    if (value.isResultTruncated === true && value.fullResultDownloadUrl) {
      result.push({
        url: String(value.fullResultDownloadUrl),
        originalResultChars: Number(value.originalResultChars) || null,
      });
    }
    for (const child of Object.values(value)) collectDescriptors(child, result, depth + 1);
  }
  return result;
}

async function readResponseText(response, maxBytes) {
  if (!response.ok) {
    const error = new Error(`Expanded Tool Result download failed with HTTP ${response.status}`);
    error.code = "EXPANDED_RESULT_HTTP_ERROR";
    throw error;
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`Expanded Tool Result exceeds ${maxBytes} bytes`);
    error.code = "EXPANDED_RESULT_TOO_LARGE";
    throw error;
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw Object.assign(new Error(`Expanded Tool Result exceeds ${maxBytes} bytes`), { code: "EXPANDED_RESULT_TOO_LARGE" });
    return buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error(`Expanded Tool Result exceeds ${maxBytes} bytes`), { code: "EXPANDED_RESULT_TOO_LARGE" });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function recoverExpandedToolResults({
  outputDirectory,
  spanDetailFiles,
  fetchImpl = globalThis.fetch,
  force = false,
  logger = console,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required for expanded Tool Results");
  const recovered = new Map();
  const attempts = [];
  for (const [spanId, detailPath] of spanDetailFiles) {
    const wrapper = await readJson(detailPath);
    const descriptors = collectDescriptors(wrapper?.data?.output);
    if (!descriptors.length) continue;
    const artifactPath = path.join(outputDirectory, "expanded-tool-results", `${safeFileName(spanId)}.json`);
    if (!force && await isValidJsonFile(artifactPath)) {
      const cached = await readJson(artifactPath);
      if (cached?.data?.output && cached?.source?.spanOutputSha256 === sha256(wrapper?.data?.output)) {
        recovered.set(String(spanId), artifactPath);
        attempts.push({ spanId: String(spanId), status: "recovered", source: "cache", artifactPath: path.relative(outputDirectory, artifactPath) });
        continue;
      }
    }
    try {
      const bodies = [];
      const sources = [];
      for (const descriptor of descriptors) {
        const url = safeDownloadUrl(descriptor.url);
        const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(120_000) });
        const content = await readResponseText(response, maxBytes);
        if (!content.trim()) {
          const error = new Error("Expanded Tool Result download returned an empty body");
          error.code = "EXPANDED_RESULT_EMPTY";
          throw error;
        }
        bodies.push(content);
        sources.push({
          host: url.hostname,
          path: url.pathname,
          filePathSha256: sha256(url.searchParams.get("file_path")),
          originalResultChars: descriptor.originalResultChars,
          downloadedChars: content.length,
          contentSha256: sha256(content),
        });
      }
      const expandedContent = bodies.join("\n\n");
      const enrichedOutput = `${redactInternalDownloadUrls(wrapper.data.output)}\n\n[Recovered full Tool Result]\n${expandedContent}`;
      await writeJsonAtomic(artifactPath, {
        schemaVersion: "trace-expanded-tool-result-v1",
        spanId: String(spanId),
        source: { spanDetail: path.relative(outputDirectory, detailPath), spanOutputSha256: sha256(wrapper.data.output), downloads: sources },
        data: { output: enrichedOutput, expandedContent },
      });
      recovered.set(String(spanId), artifactPath);
      attempts.push({ spanId: String(spanId), status: "recovered", source: "network", artifactPath: path.relative(outputDirectory, artifactPath) });
      logger.info?.(`已补拉截断 Tool Result: span ${spanId}`);
    } catch (error) {
      attempts.push({ spanId: String(spanId), status: "failed", code: error?.code || "EXPANDED_RESULT_DOWNLOAD_FAILED", message: String(error?.message || error).slice(0, 500) });
      logger.warn?.(`截断 Tool Result 补拉失败: span ${spanId}; ${error?.code || error?.message}`);
    }
  }
  return { recovered, attempts };
}
