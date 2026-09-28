/** Terminal states shared by the Web store and its read-only projections. */
export const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "completed_with_evidence_gaps",
  "completed_with_failures",
  "completed_no_action",
  "failed",
  "cancelled",
]);

export const WEB_JOB_LOG = "web-job.jsonl";
export const WEB_FAILURE_JSON = "web-failure-diagnosis.json";
export const WEB_FAILURE_MD = "web-failure-summary.md";
