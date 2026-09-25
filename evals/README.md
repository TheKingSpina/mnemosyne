# Evaluation baseline

This directory contains the deterministic, offline governance baseline. It uses only synthetic Italian examples and the local extractor. It does not call OpenRouter or measure model quality.

## Run

```bash
npm run eval:all
```

The command builds the workspaces, runs `evals/datasets/governance-v1.json` and `evals/datasets/retrieval-v1.json`, and writes the latest metrics to `evals/results/`. Results are ignored by Git; the datasets and runners are versioned.

## Current gates

- candidate precision and recall;
- kind and scope accuracy;
- retrieval precision, recall and graded nDCG for both search and context;
- a discriminative multi-relevant ordering case with distractors;
- a deliberate legacy-order contrast check that must fail when ranking is broken;
- context budget compliance and pending exclusion;
- duplicate merging;
- conflict detection after an approved memory;
- zero false auto-acceptances;
- zero pending memories leaking into context;
- local retrieval latency percentiles.

The baseline is intentionally conservative. It does not enable automatic acceptance or claim M1 quality. A production benchmark must add reviewed relevance judgments, explicit provider profiles, latency/cost measurements, and an M1 runner with hardware metadata; the repository runner deliberately stays offline and deterministic. See [`docs/retrieval-ranking.md`](../docs/retrieval-ranking.md) for the ranking contract and operational limits.
