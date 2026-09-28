import assert from "node:assert/strict";
import test from "node:test";
import { runRcaCase } from "../../src/rca/orchestrator.mjs";

test("RCA orchestrator module is importable", () => {
  assert.equal(typeof runRcaCase, "function");
});
