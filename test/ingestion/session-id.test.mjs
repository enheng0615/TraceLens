import assert from "node:assert/strict";
import test from "node:test";
import { extractSessionId } from "../../src/ingestion/sophon-trace/session-id.mjs";

test("directly extracts decimal digits after sessionId from long or pasted text", () => {
  assert.equal(extractSessionId("https://example.test/run?jwtToken=secret&sessionId=29785869&appId=1"), "29785869");
  assert.equal(extractSessionId("[link](https://example.test/run?SESSIONID=30514182#section)"), "30514182");
  assert.equal(extractSessionId("https://example.test/run?session_id=30659421"), "30659421");
});

test("rejects a query URL without a Session ID", () => {
  assert.throws(
    () => extractSessionId("https://example.test/run?sessionId=abc-123&id=1"),
    (error) => error.code === "SESSION_ID_NOT_FOUND",
  );
});
