/** Shared opening for every case-level analysis report. */
export function reportSentence(value) {
  const text = String(value ?? "").trim().replace(/[。；;，,\s]+$/u, "");
  return text ? `${text}。` : "";
}

export function renderReportOpening({ title, rootCause, category, detailHeading }) {
  return [
    `# ${title}`, "",
    "## 根因及成因", "",
    reportSentence(rootCause), "",
    "## 问题类别", "",
    reportSentence(category), "",
    `## ${detailHeading}`, "",
  ];
}

export function validateReportOpening(report) {
  const errors = [];
  const headline = report?.rootCauseHeadline;
  if (typeof headline !== "string" || !headline.trim() || headline.length > 220 || /[。！？].*[。！？]/u.test(headline)) {
    errors.push("rootCauseHeadline must be one concise sentence of at most 220 characters");
  }
  const classification = report?.problemClassification;
  if (typeof classification?.category !== "string" || !classification.category.trim()
    || classification.category.length > 120 || /[。！？].*[。！？]/u.test(classification.category)
    || typeof classification?.rationale !== "string" || !classification.rationale.trim()) {
    errors.push("problemClassification needs one concise category of at most 120 characters and a rationale; if no defect is located, state that explicitly");
  }
  return { valid: errors.length === 0, errors };
}
