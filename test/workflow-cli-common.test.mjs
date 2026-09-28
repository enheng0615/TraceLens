import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRetryPlan } from "../scripts/workflow-cli-common.mjs";

test("loads selected_sessions retry selections for the workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "selected-session-plan-"));
  const file = path.join(root, "retry-plan.json");
  await writeFile(file, JSON.stringify({
    lineage: { rootJobId: "root", parentJobId: "parent", attempt: 2, scope: "selected_sessions" },
    retrySelection: [{ rowNumber: 12, sessionId: "30665086", selectionSource: "selected_session" }],
  }));
  const result = await loadRetryPlan({ "retry-plan": file });
  assert.equal(result.lineage.scope, "selected_sessions");
  assert.deepEqual(result.retrySelection.map((item) => [item.rowNumber, item.sessionId]), [[12, "30665086"]]);
});

test("rejects a selected_sessions plan without a selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "empty-selected-session-plan-"));
  const file = path.join(root, "retry-plan.json");
  await writeFile(file, JSON.stringify({ lineage: { scope: "selected_sessions" }, retrySelection: [] }));
  await assert.rejects(loadRetryPlan({ "retry-plan": file }), /selected_sessions retry plan requires retrySelection/);
});
