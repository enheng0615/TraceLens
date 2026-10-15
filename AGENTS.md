# Project report instructions

For every new final analysis report in this repository, follow [docs/analysis-report-template.md](docs/analysis-report-template.md). This applies to manually written case analyses as well as generated `feedback-report.md` and `rca-report.md` files.

- Begin with the report title, then `## 根因及成因` and `## 问题类别`. Put one concise sentence below each heading. Do not insert `两句话结论` or `结论摘要` before them.
- Follow those sentences with a detailed, evidence-linked account from the earliest supported divergence through downstream execution and the final user feedback or evaluated result.
- Separate confirmed observations, candidate mechanisms, user claims, and unknowns. If the cause is unproven, write `候选原因（尚未证实）`; if only the symptom is located, write `根因尚未定位`.
- Keep raw field locations, EV citations, alternative explanations, evidence boundaries, and validation results available after the readable account.
- For aggregate analyses without one defensible cause, say that a single root cause is not established and classify only the observed issue set. Do not force an invented cause to fill the template.

Operational logs, failure diagnostics, and batch status summaries retain their own formats because they do not present a final causal conclusion.
