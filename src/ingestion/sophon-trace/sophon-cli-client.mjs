import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { SophonCliError, TraceIngestionError } from "./errors.mjs";
import { ensureDirectory, isValidJsonFile, readJson } from "./file-store.mjs";

const DEFAULT_RETRY_EXIT_CODES = new Set([5]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeDiagnostic(text) {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error ?? parsed;
    return {
      code: error?.code,
      message: error?.message,
      service: error?.service,
      hint: error?.hint,
    };
  } catch {
    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const primary = lines.find((line) => /^Error:/i.test(line)) ?? lines.at(-1);
    if (!primary) return { message: "sophon-cli returned non-JSON diagnostics" };
    const message = primary
      .replace(/^Error:\s*/i, "")
      .replace(/([?&](?:jwtToken|token|access_token|api[-_]?key)=)[^&#\s]+/gi, "$1<redacted>")
      .replace(/((?:authorization|api[-_]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
      .slice(0, 1000);
    return { message };
  }
}

function redactArgs(args) {
  const secretFlags = new Set(["--token", "--user-email"]);
  return args.map((arg, index) =>
    index > 0 && secretFlags.has(args[index - 1]) ? "***" : arg,
  );
}

export class SophonCliClient {
  constructor({
    binary = "sophon-cli",
    tenant = "data",
    region,
    userEmail,
    timeoutMs = 120_000,
    retries = 2,
    retryDelayMs = 1_000,
    logger = console,
  } = {}) {
    this.binary = binary;
    this.tenant = tenant;
    this.region = region;
    this.userEmail = userEmail;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.logger = logger;
  }

  globalArgs(outputPath) {
    const args = [];
    if (this.region) args.push("--region", this.region);
    if (this.tenant) args.push("--tenant", this.tenant);
    if (this.userEmail) args.push("--user-email", this.userEmail);
    args.push("--format", "json", "-o", outputPath);
    return args;
  }

  async fetchJson(outputPath, commandArgs, { force = false } = {}) {
    if (!force && (await isValidJsonFile(outputPath))) {
      this.logger.info?.(`复用已下载文件: ${outputPath}`);
      return readJson(outputPath);
    }

    await ensureDirectory(path.dirname(outputPath));
    const tempPath = `${outputPath}.${process.pid}.tmp`;
    await rm(tempPath, { force: true });

    const args = [...this.globalArgs(tempPath), ...commandArgs.map(String)];
    let lastError;

    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      try {
        await this.run(args);
        const payload = await readJson(tempPath);
        if (payload?.success === false) {
          throw new TraceIngestionError("Sophon 返回 success=false", {
            code: "SOPHON_RESPONSE_ERROR",
            details: { outputPath, status: payload.status, message: payload.message },
          });
        }
        await rename(tempPath, outputPath);
        return payload;
      } catch (error) {
        lastError = error;
        await rm(tempPath, { force: true });
        const retryable =
          error instanceof SophonCliError &&
          DEFAULT_RETRY_EXIT_CODES.has(error.details?.exitCode);
        if (!retryable || attempt > this.retries) break;
        const delay = this.retryDelayMs * 2 ** (attempt - 1);
        this.logger.warn?.(
          `sophon-cli 第 ${attempt} 次执行失败，${delay}ms 后重试`,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdout = [];
      const stderr = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", (cause) => {
        clearTimeout(timer);
        reject(
          new SophonCliError(`无法启动 ${this.binary}: ${cause.message}`, {
            command: [this.binary, ...redactArgs(args)],
            cause,
          }),
        );
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        if (exitCode === 0 && !timedOut) {
          resolve({ stdout: stdoutText, stderr: stderrText });
          return;
        }
        const diagnostic = safeDiagnostic(stderrText || stdoutText);
        reject(
          new SophonCliError(
            timedOut
              ? `sophon-cli 执行超过 ${this.timeoutMs}ms`
              : `sophon-cli 退出码为 ${exitCode}${diagnostic?.message ? `：${diagnostic.message}` : ""}`,
            {
              command: [this.binary, ...redactArgs(args)],
              exitCode,
              stdoutBytes: Buffer.byteLength(stdoutText),
              stderrBytes: Buffer.byteLength(stderrText),
              diagnostic,
            },
          ),
        );
      });
    });
  }
}
