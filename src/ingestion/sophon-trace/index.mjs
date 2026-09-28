export { TraceIngestionError, SophonCliError } from "./errors.mjs";
export { SophonCliClient } from "./sophon-cli-client.mjs";
export { SophonSessionCollector } from "./fetch-session.mjs";
export { extractSessionId } from "./session-id.mjs";
export { auditCollection } from "./integrity.mjs";

export { recoverExpandedToolResults } from "./expanded-tool-results.mjs";
export { buildTraceEvidenceBoundary } from "./evidence-boundary.mjs";
