import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isValidJsonFile, readJson, writeJsonAtomic } from "./file-store.mjs";

/** Download only selected Trace trees/details, without a Session-wide Span list. */
export async function collectFeedbackEpisode({ client, episode, cacheRoot, identity, maxBytes = 512 * 1024 * 1024, maxSpans = 5000, timeoutMs = 180000 }) {
  if (!client?.fetchJson || !cacheRoot || !identity?.agentId || !identity?.agentType || !episode?.selectedTurns?.length) throw new Error("Selective collector needs a client, route identity and selected Turns");
  if (![maxBytes, maxSpans, timeoutMs].every((n) => Number.isFinite(n) && n > 0) || !Number.isInteger(maxSpans)) throw new Error("Invalid selective collection budget");
  const route = { tenant: client.tenant ?? "unknown", region: client.region ?? "default", agentId: String(identity.agentId), agentType: identity.agentType, sessionId: String(episode.sessionId) };
  if (!/^[A-Za-z0-9._-]+$/.test(route.sessionId) || !Number.isFinite(episode.feedbackReceivedAt)) throw new Error("Invalid episode identity");
  const namespace = createHash("sha256").update(JSON.stringify(route)).digest("hex").slice(0, 24);
  const root = path.resolve(cacheRoot, namespace, route.sessionId);
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, ".collection.lock");
  const lock = await open(lockPath, "wx").catch((error) => { if (error.code === "EEXIST") throw new Error("Selective Trace cache is being collected by another worker"); throw error; });
  const started = Date.now(); let bytes = 0; const ids = new Set();
  const checkBudget = () => { if (Date.now() - started > timeoutMs || bytes > maxBytes || ids.size > maxSpans) throw new Error("Selective Trace collection budget exhausted"); };
  try {
    const identityPath = path.join(root, "cache-identity.json");
    if (await isValidJsonFile(identityPath)) {
      if (JSON.stringify(await readJson(identityPath)) !== JSON.stringify(route)) throw new Error("Selective cache route identity mismatch");
    } else await writeJsonAtomic(identityPath, route);
    const seen = new Set();
    for (const turn of episode.selectedTurns) {
      checkBudget();
      const traceId = turn.businessTraceId ?? turn.traceId;
      if (!/^[A-Za-z0-9._:-]+$/.test(traceId ?? "") || turn.endTime > episode.feedbackReceivedAt || turn.startTime >= episode.feedbackReceivedAt) throw new Error("Selected Turn violates feedback boundary");
      if (seen.has(traceId)) continue;
      seen.add(traceId);
      const since = Math.max(0, turn.startTime - 300000), until = Math.min(episode.feedbackReceivedAt, turn.endTime + 300000);
      const shared = ["--agent-type", route.agentType, "--agent-id", route.agentId, "--since", String(since), "--until", String(until)];
      const treePath = path.join(root, "traces/trees", `${traceId}.json`);
      const tree = await client.fetchJson(treePath, ["trace", "tree", traceId, ...shared, "--exclude-input-output"]);
      bytes += (await stat(treePath)).size; checkBudget();
      const nodes = [];
      const walk = (node) => { if (!node?.id || nodes.includes(node.id)) throw new Error("Invalid or duplicate Tree node"); nodes.push(node.id); if (nodes.length > maxSpans) throw new Error("Selective Trace Span budget exhausted"); for (const child of node.childs ?? []) walk(child); };
      walk(tree.data);
      if (nodes.length + ids.size > maxSpans) throw new Error("Selective Trace Span budget exhausted");
      for (const spanId of nodes) {
        if (!/^[A-Za-z0-9._:-]+$/.test(spanId)) throw new Error("Invalid Tree Span ID");
        const file = path.join(root, "spans/details", `${spanId}.json`);
        const detail = await client.fetchJson(file, ["trace", "get", spanId, "--trace-id", traceId, ...shared]);
        const d = detail?.data;
        if (d?.id !== spanId || d.traceId !== traceId || String(d.sessionId) !== route.sessionId
          || !Number.isFinite(d.startTime) || !Number.isFinite(d.endTime) || d.endTime < d.startTime
          || d.startTime >= episode.feedbackReceivedAt || d.endTime > episode.feedbackReceivedAt) throw new Error(`Downloaded Span violates episode identity/time: ${spanId}`);
        ids.add(spanId); bytes += (await stat(file)).size; checkBudget();
      }
    }
    const completion = { ...episode, schemaVersion: "feedback-episode-v1", sourceIdentity: route,
      localRoot: root, downloadedSpanCount: ids.size, observedBytes: bytes, collectionStatus: "complete_selected_structure",
      payloadCompleteness: "requires_payload_audit", completedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(root, "episodes", `${episode.episodeId}.json`), completion);
    return { root, completion };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
