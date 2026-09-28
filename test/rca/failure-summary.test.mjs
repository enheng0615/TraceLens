import assert from "node:assert/strict";
import test from "node:test";
import { renderFailureSummary } from "../../src/rca/failure-summary.mjs";

test("renders a useful failure artifact with coverage gaps and resume command", () => {
  const text = renderFailureSummary({
    runId: "run-1",
    mode: "live",
    modelInfo: { provider: "sophon" },
    target: { criterion: { text: "GT" }, phenomenonToExplain: "gap" },
    decisions: [{ round: 3, decision: { analysisSummary: "checked", readyForConclusion: false, openQuestions: ["why"] } }],
    ledger: { entries: [{ evidenceId: "EV-001" }] },
    coverage: { complete: false, missing: ["fact group"] },
    error: new Error("Investigation coverage incomplete"),
    casePath: "/case.json",
    traceRoot: "/trace",
    outputDir: "/run",
  });
  assert.match(text, /失败阶段：investigation/);
  assert.match(text, /fact group/);
  assert.match(text, /--resume \/run/);
  assert.match(text, /失败摘要不是最终RCA结论/);
});
