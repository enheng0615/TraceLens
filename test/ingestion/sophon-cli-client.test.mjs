import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SophonCliClient } from "../../src/ingestion/sophon-trace/sophon-cli-client.mjs";
import { SophonCliError } from "../../src/ingestion/sophon-trace/errors.mjs";

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

test("allows an online-feedback CLI request to finish without a local timer", async () => {
  const client = new SophonCliClient({ binary: process.execPath, timeoutMs: null });
  await client.run(["-e", "setTimeout(() => process.stdout.write('done'), 20)"]);
});

test("retryable CLI failures can recover after the former retry cap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sophon-retries-"));
  try {
    const client = new SophonCliClient({ retries: Infinity, retryDelayMs: 0, logger: { warn() {} } });
    let calls = 0;
    client.run = async (args) => {
      calls += 1;
      if (calls < 5) throw new SophonCliError("retryable", { exitCode: 5 });
      await writeFile(args[args.indexOf("-o") + 1], JSON.stringify({ success: true, data: {} }));
    };
    await client.fetchJson(path.join(directory, "result.json"), ["trace", "tree", "trace-id"]);
    assert.equal(calls, 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Sophon range rejection reaches the Session window adapter without repeated CLI retries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sophon-range-rejection-"));
  try {
    const client = new SophonCliClient({ retries: Infinity, retryDelayMs: 0, logger: { warn() {} } });
    let calls = 0;
    client.run = async () => {
      calls += 1;
      throw new SophonCliError("查询时间范围超出ES可用范围，请缩小时间范围", { exitCode: 5 });
    };
    await assert.rejects(client.fetchJson(path.join(directory, "result.json"), ["session", "list"]), /缩小时间范围/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
