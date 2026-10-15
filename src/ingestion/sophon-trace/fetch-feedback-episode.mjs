import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { isValidJsonFile, readJson, writeJsonAtomic } from "./file-store.mjs";
import { acquireFeedbackCacheLock } from "./feedback-cache-lock.mjs";

/** Download only selected Trace trees/details, without a Session-wide Span list. */
export async function collectFeedbackEpisode({ client, episode, cacheRoot, identity }) {
  if (!client?.fetchJson || !cacheRoot || !identity?.agentId || !identity?.agentType || !episode?.selectedTurns?.length) throw new Error("Selective collector needs a client, route identity and selected Turns");
  const route = { tenant: client.tenant ?? "unknown", region: client.region ?? "default", agentId: String(identity.agentId), agentType: identity.agentType, sessionId: String(episode.sessionId) };
  if (!/^[A-Za-z0-9._-]+$/.test(route.sessionId) || !Number.isFinite(episode.feedbackReceivedAt)) throw new Error("Invalid episode identity");
  const namespace = createHash("sha256").update(JSON.stringify(route)).digest("hex").slice(0, 24);
  const root = path.resolve(cacheRoot, namespace, route.sessionId);
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, ".collection.lock");
  const releaseLock = await acquireFeedbackCacheLock(lockPath);
  let bytes = 0; const ids = new Set();
  try {
    const identityPath = path.join(root, "cache-identity.json");
    if (await isValidJsonFile(identityPath)) {
      if (JSON.stringify(await readJson(identityPath)) !== JSON.stringify(route)) throw new Error("Selective cache route identity mismatch");
    } else await writeJsonAtomic(identityPath, route);
    const seen = new Set();
    for (const turn of episode.selectedTurns) {
      const traceId = turn.businessTraceId ?? turn.traceId;
      if (!/^[A-Za-z0-9._:-]+$/.test(traceId ?? "") || turn.endTime > episode.feedbackReceivedAt || turn.startTime >= episode.feedbackReceivedAt) throw new Error("Selected Turn violates feedback boundary");
      if (seen.has(traceId)) continue;
      seen.add(traceId);
      const since = Math.max(0, turn.startTime - 300000), until = Math.min(episode.feedbackReceivedAt, turn.endTime + 300000);
      const shared = ["--agent-type", route.agentType, "--agent-id", route.agentId, "--since", String(since), "--until", String(until)];
      const treePath = path.join(root, "traces/trees", `${traceId}.json`);
      const tree = await client.fetchJson(treePath, ["trace", "tree", traceId, ...shared, "--exclude-input-output"]);
      bytes += (await stat(treePath)).size;
      const nodes = []; const nodeIds = new Set(); const pending = [tree.data];
      while (pending.length) {
        const node = pending.pop();
        if (!node?.id || nodeIds.has(node.id)) throw new Error("Invalid or duplicate Tree node");
        nodeIds.add(node.id); nodes.push(node.id);
        for (let index = (node.childs?.length ?? 0) - 1; index >= 0; index -= 1) pending.push(node.childs[index]);
      }
      for (const spanId of nodes) {
        if (!/^[A-Za-z0-9._:-]+$/.test(spanId)) throw new Error("Invalid Tree Span ID");
        const file = path.join(root, "spans/details", `${spanId}.json`);
        const detail = await client.fetchJson(file, ["trace", "get", spanId, "--trace-id", traceId, ...shared]);
        const d = detail?.data;
        if (d?.id !== spanId || d.traceId !== traceId || String(d.sessionId) !== route.sessionId
          || !Number.isFinite(d.startTime) || !Number.isFinite(d.endTime) || d.endTime < d.startTime
          || d.startTime >= episode.feedbackReceivedAt || d.endTime > episode.feedbackReceivedAt) throw new Error(`Downloaded Span violates episode identity/time: ${spanId}`);
        ids.add(spanId); bytes += (await stat(file)).size;
      }
    }
    const completion = { ...episode, schemaVersion: "feedback-episode-v1", sourceIdentity: route,
      localRoot: root, downloadedSpanCount: ids.size, observedBytes: bytes, collectionStatus: "complete_selected_structure",
      payloadCompleteness: "requires_payload_audit", completedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(root, "episodes", `${episode.episodeId}.json`), completion);
    return { root, completion };
  } finally { await releaseLock(); }
}
