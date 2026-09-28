function parseMaybeJson(value, label) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (label === "machine grading") return text;
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
  }
}

export function parseGroundTruth(value) {
  const parsed = parseMaybeJson(value, "ground truth");
  if (Array.isArray(parsed)) return parsed.map(String);
  const nested = parsed?.结论?.groundTruth ?? parsed?.groundTruth;
  if (Array.isArray(nested)) return nested.map(String);
  if (typeof parsed === "string") {
    return parsed.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function explicitGroundTruth(value) {
  if (value === undefined || value === null || value === "") return { catalog: [], single: null };
  if (typeof value === "object") return { catalog: parseGroundTruth(value), single: null };
  const text = String(value).trim();
  if (!text) return { catalog: [], single: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return { catalog: parseGroundTruth(parsed), single: null };
  } catch {
    // Plain text is an authoritative single GT in single-session mode.
  }
  return { catalog: [], single: text };
}

function numberFromId(value) {
  const match = String(value ?? "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function normalizeGt(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\p{Cf}\p{M}\p{S}]+/gu, "");
}

function matchGroundTruth(groundTruth, candidate) {
  const needle = normalizeGt(candidate);
  if (!needle) return null;
  const exact = groundTruth
    .map((text, index) => ({ text, index, normalized: normalizeGt(text) }))
    .filter((item) => item.normalized === needle);
  if (exact.length === 1) return exact[0];
  const contained = groundTruth
    .map((text, index) => ({ text, index, normalized: normalizeGt(text) }))
    .filter((item) => item.normalized.includes(needle) || needle.includes(item.normalized));
  return contained.length === 1 ? contained[0] : null;
}

function uniqueCriteria(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.id}\0${item.text}`;
    if (!item.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fromConclusion(payload, groundTruth) {
  const missed = payload?.conclusion?.结论?.缺失项?.inReportMissedRecall;
  if (!Array.isArray(missed)) return [];
  return missed.map((item, index) => {
    const rawText = String(item?.未命中GT ?? "").trim();
    const matched = matchGroundTruth(groundTruth, rawText);
    return {
      id: matched ? `报告GT${matched.index + 1}` : `缺失GT${index + 1}`,
      text: matched?.text ?? rawText,
      officialVerdict: "未命中",
      reason: String(item?.缺失说明 ?? "").trim(),
      source: "conclusion.结论.缺失项.inReportMissedRecall",
    };
  });
}

function isMissedVerdict(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/^(完全满足|满足|命中|通过)$/.test(text);
}

function fromDetailedRecords(payload, groundTruth) {
  const records = payload?.complete_v2?.用户需求一致性;
  if (!Array.isArray(records)) return [];
  return records.filter((item) => isMissedVerdict(item?.验证结果)).map((item, index) => {
    const number = numberFromId(item?.GT编号);
    const rawText = String(item?.GT内容 ?? "").replace(/。{2,}$/g, "").trim();
    const matched = matchGroundTruth(groundTruth, rawText);
    return {
      id: matched ? `报告GT${matched.index + 1}` : String(item?.GT编号 ?? `GT-${index + 1}`),
      text: matched?.text ?? (Number.isInteger(number) && groundTruth[number - 1] ? groundTruth[number - 1] : rawText),
      officialVerdict: String(item?.验证结果 ?? "未命中"),
      reason: String(item?.原因说明 ?? "").trim(),
      source: "complete_v2.用户需求一致性",
    };
  });
}

function fromTopLevelObject(payload, groundTruth) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.未命中GT !== "string") return [];
  const rawText = payload.未命中GT.trim();
  const matched = matchGroundTruth(groundTruth, rawText);
  return [{
    id: matched ? `报告GT${matched.index + 1}` : "GT-1",
    text: matched?.text ?? rawText,
    officialVerdict: String(payload.验证结果 ?? "未命中"),
    reason: String(payload.缺失说明 ?? payload.原因说明 ?? JSON.stringify(payload)),
    source: "top_level_object",
  }];
}

function fromPlainText(text, groundTruth) {
  const items = [];
  const pattern = /["']?未命中GT["']?\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const [index, match] of [...text.matchAll(pattern)].entries()) {
    let decoded = match[1];
    try { decoded = JSON.parse(`"${match[1]}"`); } catch {}
    items.push({ id: `GT-${index + 1}`, text: decoded, officialVerdict: "未命中", reason: text, source: "plain_text" });
  }
  if (!items.length && groundTruth.length === 1 && /未命中|不满足|缺失/.test(text)) {
    items.push({ id: "GT-1", text: groundTruth[0], officialVerdict: "未命中", reason: text, source: "plain_text_single_gt" });
  }
  return items;
}

export function extractMissedCriteria({ machineGrading, groundTruth, explicitGt } = {}) {
  const explicit = explicitGroundTruth(explicitGt);
  const gt = explicit.catalog.length ? explicit.catalog : parseGroundTruth(groundTruth);
  if (explicit.single) {
    return [{ id: "GT-1", text: explicit.single, officialVerdict: "未命中", reason: typeof machineGrading === "string" ? machineGrading : JSON.stringify(machineGrading), source: "explicit_gt" }];
  }
  const payload = parseMaybeJson(machineGrading, "machine grading");
  let items = [];
  let recognizedStructuredFormat = false;
  if (payload && typeof payload === "object") {
    recognizedStructuredFormat = Array.isArray(payload?.conclusion?.结论?.缺失项?.inReportMissedRecall) ||
      Array.isArray(payload?.complete_v2?.用户需求一致性);
    items = fromConclusion(payload, gt);
    if (!items.length) items = fromDetailedRecords(payload, gt);
    if (!items.length) items = fromTopLevelObject(payload, gt);
  } else if (typeof payload === "string") items = fromPlainText(payload, gt);
  items = uniqueCriteria(items);
  if (!items.length && recognizedStructuredFormat) return [];
  if (!items.length) {
    const error = new Error("No missed GT could be parsed from machine grading; provide an explicit GT for single-session mode");
    error.code = "MISSED_GT_NOT_PARSED";
    throw error;
  }
  return items;
}
