import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchCursorPages } from "../../src/ingestion/sophon-trace/pagination.mjs";

test("accepts a final page that omits nextPageToken", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sophon-pages-"));
  try {
    const client = {
      async fetchJson() {
        return { data: { turns: [{ id: "one" }], hasMore: false } };
      },
    };
    const result = await fetchCursorPages({
      client,
      directory,
      itemKey: "turns",
      buildArgs: () => [],
    });
    assert.equal(result.complete, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.pages[0].nextPageToken, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects hasMore=true without a continuation token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sophon-pages-"));
  try {
    const client = {
      async fetchJson() {
        return { data: { spans: [], hasMore: true } };
      },
    };
    await assert.rejects(
      fetchCursorPages({
        client,
        directory,
        itemKey: "spans",
        buildArgs: () => [],
      }),
      (error) => error.code === "INVALID_PAGE_TOKEN",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
