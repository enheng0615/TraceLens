import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { SophonCliClient } from "../../src/ingestion/sophon-trace/sophon-cli-client.mjs";

test("surfaces a safe non-JSON sophon-cli validation message", async () => {
  const client = new SophonCliClient({ binary: process.execPath, timeoutMs: 5_000 });
  await assert.rejects(
    client.run(["-e", "process.stderr.write('Usage: command\\nError: --since and --until are required together\\n'); process.exit(2)"]),
    (error) => {
      assert.equal(error.code, "SOPHON_CLI_ERROR");
      assert.match(error.message, /退出码为 2：--since and --until are required together/);
      assert.equal(error.details.diagnostic.message, "--since and --until are required together");
      return true;
    },
  );
});

test("redacts secrets from surfaced sophon-cli diagnostics", async () => {
  const client = new SophonCliClient({ binary: process.execPath, timeoutMs: 5_000 });
  await assert.rejects(
    client.run(["-e", "process.stderr.write('Error: failed https://example.test/?jwtToken=PRIVATE api-key: SECRET\\n'); process.exit(2)"]),
    (error) => {
      assert.doesNotMatch(error.message, /PRIVATE|SECRET/);
      assert.match(error.message, /<redacted>/);
      return true;
    },
  );
});
