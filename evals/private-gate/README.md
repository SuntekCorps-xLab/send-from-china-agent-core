# Private live Eval agreement Gate

This offline tool turns the 96-hour relevance requirement into a fail-closed,
reproducible Gate. It does not include or generate a private catalog, query,
label, holdout assignment, reviewer identity, or production response.

The Eval owner keeps five input files outside the repository:

1. an adjudicated 120-case core dataset using the same
   `send-from-china-eval-dataset/v0` contract as public Eval v0, with
   `provenance: private_live`;
2. a separate 180-case provisional regression dataset using that same contract;
3. a 30-case hidden holdout assignment visible only to the Eval owner;
4. reviewer A's independent packet; and
5. reviewer B's independent packet.

`reviewer_id_hash` must be derived from a randomly assigned study pseudonym
with an approved salt or HMAC. Never hash a name, email address, employee ID or
student ID directly.

Run:

```bash
npm run eval:private-gate -- \
  --core /private/eval/core-gold.json \
  --provisional /private/eval/provisional.json \
  --holdout /private/eval/holdout.json \
  --reviewer-a /private/eval/reviewer-a.json \
  --reviewer-b /private/eval/reviewer-b.json \
  --output build/private-eval-gate/adjudication.json
```

On Windows PowerShell, use the same options on one line or use PowerShell's
backtick continuation. Never place the private inputs under this checkout.

## Locked decisions

- Core dataset: exactly 120 cases.
- Hidden holdout: exactly 30 core case IDs, leaving 90 training cases.
- Provisional set: exactly 180 non-overlapping cases.
- Two distinct reviewers must label the identical case and candidate universe.
- Status uses unweighted Cohen's kappa.
- Relevance grades 0–3 use quadratic-weighted Cohen's kappa.
- Forbidden-result decisions use binary Cohen's kappa.
- The Gate uses the minimum of all three and requires `kappa >= 0.8`.
- The adjudicated gold choice must be one of the two independent reviewer
  choices; unsupported third labels fail closed.
- Private relevance thresholds are fixed at Recall@20 0.90, Recall@50 0.95,
  Precision@10 0.85, NDCG@10 0.80, status accuracy 1.0, and zero safety
  violations.

The output contains only counts, kappa values, SHA-256 fingerprints, fixed
boundary booleans, and pass/fail. It contains no case ID, query, product ID,
reviewer identity, label, request, response, credential, or catalog field.
Passing this agreement Gate freezes the evaluation inputs; it does not enable
Meilisearch, reranking, Evidence RAG, Live Preview, or any write.

Input structures are defined by [`review.schema.json`](review.schema.json),
[`holdout.schema.json`](holdout.schema.json), and the shared
[`dataset.schema.json`](../v0/dataset.schema.json). The sanitized result shape
is [`artifact.schema.json`](artifact.schema.json).
