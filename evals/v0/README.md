# Public synthetic Eval v0

Eval v0 is a deterministic regression check for the checked-in synthetic
catalog and Search Contract v2. It exercises the real in-process Worker
handler; it does not mock a prediction file or make an external request.

This public dataset is deliberately small and visible. A passing score means
the reference implementation still satisfies these public synthetic
judgments. It is **not** evidence of production relevance, catalog coverage,
supplier connectivity, inventory, shipping, purchasing, or model quality. A
separately reviewed holdout is required before any production-quality claim.

## Commands

```bash
npm run eval:smoke
npm run eval:full
npm run eval:security
npm run eval:perf
```

- `eval:smoke` is the fast pull-request subset and is part of `npm run verify`.
- `eval:full` runs every public synthetic judgment.
- `eval:security` selects terminal-state, forbidden-ID, and enforced
  hard-constraint regression cases. It does not claim that a write-capable
  system has been tested; this repository has no commerce write path.
- `eval:perf` repeats a fixed synthetic in-process workload and reports local
  request latency. V0 gates correctness only. Its timings are neither a hosted
  benchmark nor a production SLO.

Artifacts are written under ignored `build/eval-v0/` by default. Pass
`--output <path>` after `--` to retain an artifact elsewhere, for example:

```bash
npm run eval:smoke -- --output artifacts/eval-v0-smoke.json
```

## Metrics and gates

The scorer reports macro-averaged Recall@20, Recall@50, returned-set
Precision@10 (relevant results divided by the number of visible results, up to
ten), NDCG@10 with grades 1 to 3, and expected-state accuracy. Returned-set
precision keeps a truthful one-result answer from being penalized for nine
empty slots while still failing on irrelevant visible results. It also fails
closed on:

- a forbidden public product ID;
- a result that violates an evaluated `price_min`, `price_max`, `material`,
  `color`, `must_have`, or `exclude` hard constraint;
- a duplicate or malformed public result ID; or
- a missing expected relevant result within the first 50 results.

The versioned thresholds live in [`dataset.json`](dataset.json). Changing a
judgment, case membership, or threshold changes the dataset SHA-256 recorded
in every artifact and requires review.

## Evidence boundary

Each JSON artifact includes the exact Git commit, dirty-worktree boolean,
dataset version and SHA-256, selected case IDs, public returned IDs, metrics,
and gate outcomes. It excludes raw requests, query text, credentials,
environment values, response bodies, and private data. The checked-in catalog
and judgments are synthetic public fixtures only.

The dataset contract is [`dataset.schema.json`](dataset.schema.json). New
public cases must use synthetic public IDs, normalized Search Contract v2
requests, explicit expected states, graded relevance, and explicit forbidden
IDs. Never derive public cases from customer prompts, supplier data, private
catalogs, order data, credentials, or captured production responses.

Private live evaluation uses this same dataset schema with
`provenance: private_live`, an opaque `private-snapshot:<sha256>` reference and
locked production-quality thresholds. Private datasets never enter this
repository. The two-reviewer, 120-case, hidden-holdout and provisional-set Gate
is documented in [`../private-gate/README.md`](../private-gate/README.md).
