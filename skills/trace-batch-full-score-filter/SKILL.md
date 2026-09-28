---
name: trace-batch-full-score-filter
description: Filter Trace RCA batch CSV rows by the evaluation score, treating only a strict numeric score equal to 1 as full score. Use before batch Trace collection or attribution, or when producing separate full-score and RCA-candidate CSV files. Do not infer full score from machine-grading prose.
---

# Trace Batch Full Score Filter

Run the deterministic filter before any Trace collection or RCA work.

```bash
node skills/trace-batch-full-score-filter/scripts/filter-full-score.mjs \
  --input <batch.csv> \
  --output-dir <output-directory>
```

The default score column is `ida_结论报告评分`, with `score` as a fallback. Override it only when the input contract explicitly names another column:

```bash
node skills/trace-batch-full-score-filter/scripts/filter-full-score.mjs \
  --input <batch.csv> \
  --output-dir <output-directory> \
  --score-column <column-name>
```

## Decision rule

- Parse the trimmed score as a plain finite decimal number.
- Only numeric value `1` is full score; `1`, `1.0`, and `1.00` are equivalent.
- Do not inspect GT, machine-grading text, or the IDA answer to override the score.
- Blank, non-numeric, below-zero, and above-one scores are not full score. Keep them in the RCA-candidate output and surface them as invalid-score rows for upstream validation.
- Never modify the input CSV.
- Never print row content or Session URLs; they may contain credentials.

## Outputs

The script atomically writes three input-preserving files under the requested output directory:

- `<name>.full-score.csv`: rows excluded from Trace RCA;
- `<name>.rca.csv`: all remaining rows, preserving the original columns and row order;
- `<name>.filter-summary.json`: rule, counts, score frequencies, and invalid-score row numbers.

For this repository's normal `workflow:csv` path, the same deterministic rule is already integrated. Full-score rows are recorded in `workflow-manifest.json` as `status=skipped`, `stage=score_filter`, `reason=full_score`, and never reach Trace collection or the model.
