#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebJobStore } from "./job-store.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(moduleDir, "public");
const projectRoot = path.resolve(moduleDir, "../..");
const host = process.env.TRACE_WEB_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.TRACE_WEB_PORT || "4317", 10);
const maxBodyBytes = 22 * 1024 * 1024;

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TRACE_WEB_PORT must be a valid port");

const store = await new WebJobStore({
  projectRoot,
  outputRoot: process.env.TRACE_WEB_OUTPUT_ROOT,
  traceOutputRoot: process.env.TRACE_OUTPUT_ROOT,
}).initialize();
await store.audit.service("server_initialized", { host, port, pid: process.pid, nodeVersion: process.version });

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function securityHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra,
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("请求内容超过22MB限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("请求JSON格式无效");
    error.statusCode = 400;
    throw error;
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(publicRoot, requested);
  if (resolved !== publicRoot && !resolved.startsWith(`${publicRoot}${path.sep}`)) return false;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return false;
    const content = await readFile(resolved);
    response.writeHead(200, securityHeaders({ "content-type": mime.get(path.extname(resolved)) || "application/octet-stream", "cache-control": "no-cache" }));
    response.end(content);
    return true;
  } catch { return false; }
}

const server = createServer(async (request, response) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const startedAt = Date.now();
  const rawPath = String(request.url || "/").split("?", 1)[0];
  const auditRequest = request.method !== "GET";
  if (auditRequest) {
    void store.audit.service("http_request_started", {
      requestId,
      method: request.method,
      path: rawPath,
      contentLength: Number(request.headers["content-length"] || 0),
    });
  }
  response.once("finish", () => {
    if (auditRequest || response.statusCode >= 400) {
      void store.audit.service("http_request_completed", {
        requestId,
        method: request.method,
        path: rawPath,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }, response.statusCode >= 400 ? "error" : "info");
    }
  });
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        service: "trace-rca-web",
        modelConfigured: Boolean(process.env.SOPHON_MODEL_API_KEY && process.env.SOPHON_MODEL_ID),
        ingestionConfigured: Boolean(process.env.SOPHON_INGESTION_USER_EMAIL || process.env.SOPHON_OPERATOR_EMAIL),
        bind: host,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/jobs") {
      sendJson(response, 200, { jobs: await store.listWithProgress() });
      return;
    }
    if (request.method === "POST" && pathname === "/api/jobs/session") {
      sendJson(response, 202, { job: await store.createSession(await readJsonBody(request)) });
      return;
    }
    if (request.method === "POST" && pathname === "/api/jobs/csv") {
      sendJson(response, 202, { job: await store.createCsv(await readJsonBody(request)) });
      return;
    }

    const detail = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && detail) {
      const job = await store.details(detail[1]);
      if (!job) return sendJson(response, 404, { error: "任务不存在" });
      sendJson(response, 200, { job });
      return;
    }
    const retry = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retry) {
      const job = await store.createRetry(retry[1], await readJsonBody(request));
      if (!job) return sendJson(response, 404, { error: "任务不存在" });
      sendJson(response, 202, { job });
      return;
    }
    const cancel = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancel) {
      const job = await store.cancel(cancel[1]);
      if (!job) return sendJson(response, 404, { error: "任务不存在" });
      sendJson(response, 200, { job });
      return;
    }
    const artifact = pathname.match(/^\/api\/jobs\/([^/]+)\/artifact$/);
    if (request.method === "GET" && artifact) {
      const result = await store.artifact(artifact[1], url.searchParams.get("path"));
      if (!result) return sendJson(response, 404, { error: "任务不存在" });
      sendJson(response, 200, { content: result.content, path: url.searchParams.get("path") });
      return;
    }

    if (request.method === "GET" && await serveStatic(response, pathname)) return;
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    await store.audit.service("http_request_failed", {
      requestId,
      method: request.method,
      path: rawPath,
      statusCode: error.statusCode || 400,
      errorName: error.name,
      message: error.message || "Request failed",
    }, "error");
    sendJson(response, error.statusCode || 400, { error: error.message || "Request failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Trace RCA Console: http://${host}:${port}`);
  console.log(`Local jobs: ${store.outputRoot}`);
  void store.audit.service("server_listening", { host, port, pid: process.pid });
});

function shutdown(signal) {
  console.log(`\n${signal}: stopping Trace RCA Console`);
  void store.audit.service("server_stopping", { signal, pid: process.pid });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
