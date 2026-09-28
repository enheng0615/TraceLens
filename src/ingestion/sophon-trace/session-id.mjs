import { TraceIngestionError } from "./errors.mjs";

// IDA links may be very long and contain credentials or parameters that a
// standards-compliant URL parser does not need to understand.  The only field
// required by Trace ingestion is the decimal value immediately following the
// Session ID query key, so extract that value directly and never retain the URL.
const SESSION_ID_PATTERN = /\bsessionid\s*=\s*(\d+)/i;
const LEGACY_SESSION_ID_PATTERN = /\bsession_id\s*=\s*(\d+)/i;

export function extractSessionId(value) {
  const source = String(value ?? "");
  const match = source.match(SESSION_ID_PATTERN) ?? source.match(LEGACY_SESSION_ID_PATTERN);
  if (match) return match[1];

  throw new TraceIngestionError(
    "输入中未找到 sessionId= 后的数字",
    { code: "SESSION_ID_NOT_FOUND" },
  );
}
