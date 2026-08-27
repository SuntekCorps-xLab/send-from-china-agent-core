# Private annotation agreement preflight

This offline tool implements one prerequisite of the private live Eval: it
checks that two independent reviewers used the same candidate universe and
reached sufficient annotation agreement. It is deliberately **not** a search
quality or release Gate. It does not execute search, score predictions, or
calculate Recall, Precision, NDCG, status accuracy, latency, or safety metrics.
It does not include or generate a private catalog, query, label, holdout
assignment, reviewer identity, or production response.

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
student ID directly. Different hashes are necessary but do not prove that the
reviewers are different people; the Eval owner must separately attest their
identity, independence, and lack of collaboration.

Run:

```bash
npm run eval:private-agreement -- \
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
- The candidate universe must come from a separately frozen black-box retrieval
  run. This preflight records its aggregate fingerprint but cannot prove where
  it came from; the later prediction scorer must report the same fingerprint.
  The shared algorithm is `candidateUniverseFingerprint`: sort core case IDs,
  sort each case's 22-character candidate IDs, serialize that array with the
  repository's canonical JSON function, then SHA-256 the UTF-8 bytes. It covers
  only the 120 core cases, not prediction order or the 180 provisional set.
- Each reviewer must use at least two observed labels in every kappa dimension;
  constant status, relevance, or forbidden labels are undefined and fail
  closed instead of becoming an artificial `1.0`.
- Status uses unweighted Cohen's kappa.
- Relevance grades 0–3 use quadratic-weighted Cohen's kappa.
- Forbidden-result decisions use binary Cohen's kappa.
- The Gate uses the minimum of all three and requires `kappa >= 0.8`.
- The adjudicated gold choice must be one of the two independent reviewer
  choices; unsupported third labels fail closed.
- Private relevance thresholds are fixed at Recall@20 0.90, Recall@50 0.95,
  Precision@10 0.85, NDCG@10 0.80, status accuracy 1.0, and zero safety
  violations.

The output contains only counts, kappa values, SHA-256 fingerprints, exact code
provenance, fixed boundary booleans, and pass/fail. It contains no case ID,
query, product ID, reviewer identity, label, request, response, credential, or
catalog field. Passing this preflight permits the Eval owner to freeze the
labels and candidate-universe fingerprint. A separate black-box run must then
score actual predictions on the 90 training cases, the 30 hidden holdout cases,
and the 180-case provisional regression set against the locked thresholds.
Only the Planner may combine those artifacts into a release decision. This
preflight never enables Meilisearch, reranking, Evidence RAG, Live Preview, or
any write.

The command refuses to overwrite an existing output (including a symlink or
hardlink target). Choose a new artifact filename for every run.

Input structures are defined by [`review.schema.json`](review.schema.json),
[`holdout.schema.json`](holdout.schema.json), and the shared
[`dataset.schema.json`](../v0/dataset.schema.json). The sanitized result shape
is [`artifact.schema.json`](artifact.schema.json).
