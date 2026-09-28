export class TraceIngestionError extends Error {
  constructor(message, { code = "TRACE_INGESTION_ERROR", cause, details } = {}) {
    super(message, { cause });
    this.name = "TraceIngestionError";
    this.code = code;
    this.details = details;
  }
}

export class SophonCliError extends TraceIngestionError {
  constructor(message, { command, exitCode, stdout, stderr, cause, ...diagnostics } = {}) {
    super(message, {
      code: "SOPHON_CLI_ERROR",
      cause,
      details: { command, exitCode, stdout, stderr, ...diagnostics },
    });
    this.name = "SophonCliError";
  }
}
