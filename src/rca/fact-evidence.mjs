const MARKDOWN_DISPLAY_CHARS = /[*_~`|]/g;
const SPACE_CHARS = /\s+/g;
const NUMBER_WITH_EXPLICIT_UNIT = /-?\d[\d,.]*(?:个百分点|亿元|万元|小时|分钟|秒|万|亿|元|%|笔|张|人|个|次|条)/g;
const ANY_NUMBER = /-?\d[\d,.]*/g;

/** Normalize presentation-only Markdown without changing semantic characters. */
export function normalizeEvidenceText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(MARKDOWN_DISPLAY_CHARS, "")
    .replace(SPACE_CHARS, "")
    .toLocaleLowerCase();
}

function cleanAnchor(value) {
  return String(value ?? "")
    .replace(MARKDOWN_DISPLAY_CHARS, "")
    .replace(/^[\s:：,，;；。]+|[\s:：,，;；。]+$/g, "")
    .trim();
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizeEvidenceText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Convert a grounded answer quote into a deterministic evidence group.
 * Markdown table rows use the label plus the first salient number. Other
 * quotes keep one display-normalized phrase, avoiding semantic guessing.
 */
export function buildFactEvidenceGroup(quote, index = 0) {
  const sourceQuote = String(quote ?? "").trim();
  const cells = sourceQuote.split("|").map(cleanAnchor).filter(Boolean);
  let anchors;
  if (cells.length >= 2) {
    const label = cells[0];
    const valueText = cells.slice(1).join(" ");
    // Prefer a measured value over a leading year/ordinal. This remains an
    // exact textual anchor and does not infer semantic equivalence.
    const numeric = valueText.match(NUMBER_WITH_EXPLICIT_UNIT)?.[0] ?? valueText.match(ANY_NUMBER)?.[0];
    anchors = unique([label, numeric]);
  } else {
    anchors = unique([cleanAnchor(sourceQuote)]);
  }
  return {
    id: `answer-fact-${index + 1}`,
    sourceQuote,
    anchors,
    match: "all_anchors_in_one_evidence",
  };
}

/** Extract source-bearing documents only; action arguments such as a search query do not count as evidence. */
export function evidencePayloadDocuments(entry) {
  if (entry?.tool === "search_trace") {
    return (entry.result?.hits ?? []).map((hit) => hit.excerpt ?? "").filter(Boolean);
  }
  if (entry?.tool === "get_span_content") return [entry.result?.content ?? ""].filter(Boolean);
  if (entry?.tool === "get_tool_exchange") {
    return [JSON.stringify({ request: entry.result?.request, response: entry.result?.response })];
  }
  return [];
}

export function evidencePayloadText(entry) {
  return evidencePayloadDocuments(entry).join("\n");
}

export function evidenceSatisfiesFactGroup(entry, group) {
  const anchors = (group?.anchors ?? []).map(normalizeEvidenceText).filter(Boolean);
  if (!anchors.length) return false;
  return evidencePayloadDocuments(entry).some((document) => {
    const text = normalizeEvidenceText(document);
    return text && anchors.every((anchor) => text.includes(anchor));
  });
}

export function findFactGroupEvidence(entries, group) {
  return entries.filter((entry) => evidenceSatisfiesFactGroup(entry, group));
}
