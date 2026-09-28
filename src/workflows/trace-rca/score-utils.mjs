export function parseStrictNumericScore(value) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const score = Number(text);
  return Number.isFinite(score) ? score : null;
}

export function isFullScore(value) {
  return parseStrictNumericScore(value) === 1;
}
