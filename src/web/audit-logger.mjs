import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|secret|token|password|csvText|machineGrading|idaAnswer|\bgt\b|\bquery\b)/i;
const MAX_STRING = 4000;

function redactString(value) {
  return String(value ?? "")
    .replace(/([?&](?:jwtToken|token|access_token|api[-_]?key)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/((?:authorization|api[-_]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,}){1,2}\b/g, "<redacted-jwt>")
    .slice(0, MAX_STRING);
}

export function redactAuditValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([childKey, childValue]) => [childKey, redactAuditValue(childValue, childKey)]));
  }
  return value;
}

export class WebAuditLogger {
  constructor(outputRoot) {
    this.outputRoot = path.resolve(outputRoot);
    this.servicePath = path.join(this.outputRoot, "web-server.jsonl");
    this.queues = new Map();
  }

  append(file, record) {
    const entry = `${JSON.stringify({
      schemaVersion: "trace-rca-web-log-v1",
      timestamp: new Date().toISOString(),
      ...redactAuditValue(record),
    })}\n`;
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, entry, "utf8");
    });
    this.queues.set(file, next);
    return next.finally(() => {
      if (this.queues.get(file) === next) this.queues.delete(file);
    });
  }

  service(event, data = {}, level = "info") {
    return this.append(this.servicePath, { level, scope: "web", event, data });
  }

  job(job, event, data = {}, level = "info") {
    const jobId = typeof job === "string" ? job : job.id;
    const jobDir = typeof job === "string" ? path.join(this.outputRoot, "jobs", job) : job.jobDir;
    return this.append(path.join(jobDir, "web-job.jsonl"), { level, scope: "job", event, jobId, data });
  }
}
