import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { buildConversationTimeline } from "./feedback-anchor-resolver.mjs";

export async function loadFeedbackTimeline(root, sessionId) {
  const dir = path.join(root, "session", "detail-pages");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) throw new Error("Timeline snapshot has no raw pages");
  const pages = [];
  for (const file of files) pages.push(JSON.parse(await readFile(path.join(dir, file), "utf8")).data);
  if (pages.some((page) => String(page?.sessionId) !== String(sessionId))) throw new Error("Timeline snapshot Session mismatch");
  if (pages.at(-1).hasMore !== false) throw new Error("Timeline pagination is incomplete");
  if (pages.slice(0, -1).some((p) => p.hasMore !== true)) throw new Error("Timeline contains pages after pagination ended");
  const identity = Object.fromEntries(["tenantId", "agentId", "agentType", "region", "dataSource"].map((key) => {
    const values = new Set(pages.map((p) => p[key]).filter((v) => v !== undefined && v !== null).map(String));
    if (values.size > 1) throw new Error(`Timeline identity changed across pages: ${key}`);
    return [key, [...values][0] ?? null];
  }));
  const fingerprints = new Set(pages.map((p) => p.sessionVersionFingerprint).filter(Boolean));
  if (fingerprints.size > 1) throw new Error("Timeline pages have different snapshot fingerprints");
  const turns = pages.flatMap((p) => p.turns ?? []);
  const totals = new Set(pages.map((p) => p.total).filter((n) => Number.isInteger(n)));
  if (totals.size > 1 || (totals.size && !totals.has(turns.length))) throw new Error("Timeline pagination count mismatch");
  const timeline = buildConversationTimeline(turns);
  return { timeline, coverage: {
    paginationComplete: true, turnCount: timeline.length,
    identity,
    historyScope: pages[0].dataScope ?? "unknown",
    entireSessionHistoryProven: pages[0].dataScope === "FULL_SESSION_HISTORY",
    sessionVersionFingerprint: [...fingerprints][0] ?? null,
  } };
}
