function parseEmbeddedJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if ((!text.startsWith("{") && !text.startsWith("[")) || text.length > 10_000_000) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function collectCandidates(value, currentPath = "$", result = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectCandidates(child, `${currentPath}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${currentPath}.${key}`;
    if (typeof child === "string" && /^(?:output|content|text|result)$/i.test(key)) {
      result.push({ path: childPath, chars: child.length, content: child });
    }
    collectCandidates(child, childPath, result);
  }
  return result;
}

function matchesVisiblePrefix(shortened, complete) {
  if (typeof shortened !== "string" || typeof complete !== "string") return false;
  const visible = shortened
    .replace(/(?:\.\.\.)?(?:\[truncated\]|<truncated>|truncated(?: due to length limit)?)\s*$/i, "")
    .replace(/^```[^\n]*\n/, "")
    .trimEnd();
  return visible.length >= 32 && complete.startsWith(visible);
}

function collectDescriptors(value, currentPath = "$", result = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectDescriptors(child, `${currentPath}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const flagKey = ["isResultTruncated", "resultTruncated", "truncated"]
    .find((key) => value[key] === true);
  if (flagKey) {
    result.push({
      path: currentPath,
      flagPath: `${currentPath}.${flagKey}`,
      originalResultChars: Number(value.originalResultChars) || null,
      visibleResultChars: typeof value.result === "string" ? value.result.length : 0,
      visibleResult: value.result,
      fullResultDownloadUrl: value.fullResultDownloadUrl ? String(value.fullResultDownloadUrl) : null,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    collectDescriptors(child, `${currentPath}.${key}`, result);
  }
  return result;
}

/**
 * Distinguish a genuinely missing Tool payload from a shortened display copy.
 * Some Tool wrappers keep resources[].result at 10k characters while also
 * persisting the full body in a sibling top-level output/content field.
 */
export function assessEmbeddedResultTruncation(value, basePath = "$", { toleranceChars = 32 } = {}) {
  const root = parseEmbeddedJson(value);
  if (!root || typeof root !== "object") return [];
  const candidates = collectCandidates(root, basePath);
  return collectDescriptors(root, basePath).map((descriptor) => {
    const { visibleResult, ...publicDescriptor } = descriptor;
    const required = descriptor.originalResultChars;
    const tolerance = required ? Math.max(toleranceChars, Math.ceil(required * 0.01)) : 0;
    const alternate = required
      ? candidates
        .filter((candidate) => !candidate.path.startsWith(`${descriptor.path}.`))
        .filter((candidate) => candidate.chars >= required - tolerance)
        .filter((candidate) => matchesVisiblePrefix(visibleResult, candidate.content))
        .sort((left, right) => right.chars - left.chars)[0] ?? null
      : null;
    return {
      ...publicDescriptor,
      classification: alternate
        ? "display_copy_truncated_payload_available"
        : "source_payload_missing",
      alternatePayload: alternate ? { path: alternate.path, chars: alternate.chars } : null,
    };
  });
}
