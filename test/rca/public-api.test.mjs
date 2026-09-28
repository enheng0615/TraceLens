import assert from "node:assert/strict";
import test from "node:test";
import * as rca from "../../src/rca/index.mjs";

test("RCA public entrypoint exports stable framework APIs", () => {
  for (const name of ["runRcaCase", "validateRcaCase", "TraceRepository", "EvidenceLedger"]) {
    assert.ok(rca[name], `missing public export: ${name}`);
  }
});
