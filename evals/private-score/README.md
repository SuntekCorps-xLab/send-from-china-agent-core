# Private black-box search scorer

This directory defines the v1 contracts for an offline comparison of one
frozen legacy search arm and one frozen candidate search arm. The scorer works
only inside an approved, pre-annotated judgment pool. It does not execute
search, capture responses, create labels, authorize a rollout, enable Live
Preview, or modify a product.

The public synthetic Eval and this private Eval have different claims. The
public Eval remains reproducible evidence for the open-source reference
runtime. This private Eval may measure a frozen live-derived candidate, but its
sanitized output never contains a case ID, query, product ID, label, result,
response, path, URL, credential, or deployment identifier.

## Required inputs

The Eval owner supplies eight JSON files. Every input must be outside the
repository checkout:

1. an adjudicated 120-case core dataset with `provenance: private_live`;
2. a separate 180-case provisional regression dataset;
3. a hidden assignment containing exactly 30 core case IDs;
4. a passing private annotation-agreement artifact;
5. a frozen runtime manifest described by
   [`runtime-manifest.schema.json`](runtime-manifest.schema.json);
6. a 300-case pooled-universe manifest described by
   [`pool.schema.json`](pool.schema.json);
7. a legacy prediction packet; and
8. a candidate prediction packet, both described by
   [`predictions.schema.json`](predictions.schema.json).

The scorer derives the 90-case training split as `core - hidden`. It never
accepts a caller-provided training assignment. Core and provisional case IDs
must not overlap. The agreement artifact must pass with a clean Agent Core
commit, non-degenerate kappa values, and `gate_kappa >= 0.8`. Agreement is a
labeling prerequisite, not a prediction packet or search-quality result. Its
runner source hash must equal the exact checked-in `private-gate/adjudicate.mjs`
bytes; a caller-supplied 64-character value is not accepted as provenance.

The intended command contract is:

```bash
npm run eval:private-score -- \
  --core /secure/eval/core.json \
  --provisional /secure/eval/provisional.json \
  --holdout /secure/eval/holdout.json \
  --agreement /secure/eval/agreement.json \
  --runtime-manifest /secure/eval/runtime.json \
  --pool /secure/eval/pool.json \
  --legacy /secure/eval/legacy-predictions.json \
  --candidate /secure/eval/candidate-predictions.json \
  --output /secure/eval/score-artifact.json
```

Use a new output name for every run. A repository-local output is permitted
only under the ignored `build/private-eval-score/` directory.

## Runtime identity

[`runtime-manifest.schema.json`](runtime-manifest.schema.json) binds the exact
Mini Suntek, Agent Core, Reference Store, and root Worker commits; Search
Contract hash; clean root Worker state; deployment and configuration;
catalog, index, tenant-policy, deployed-field-policy, scorer-required
allowlist, constraint-evaluator, and request packet hashes; the exact candidate
retrieval recipe and pooled lane revisions;
all four surface adapters; model revisions; task packets; and
the no-write/no-invite/no-raw-query/no-retry boundaries.

The v1 scorer intentionally accepts two prediction packets. The frozen
`legacy/off/off` packet is the baseline for both quality and latency; the
`rrf` or `rrf_reranker` packet is the candidate capture from an isolated
Shadow deployment. Both packets must bind the same exact release, catalog and
index snapshots, tenant policy, request packet, pool, model identities, and
surface adapters. Only the deployment/configuration identity and explicitly
declared experimental modes may differ. The artifact therefore does not claim
simultaneous co-resident execution or a third same-deployment legacy capture.

The runtime also freezes one Planner-approved black-box capture runner by
exact version and source SHA-256. Both prediction packets must match that
identity. A packet created by an unapproved or locally modified runner is
rejected, because raw-response pointer completeness, source state, and latency
are evidence supplied by that runner.

The measurement protocol is also frozen: at least one per-surface warm-up is
excluded, each measured case has one attempt, arms are interleaved from a
hashed seed, the monotonic clock is used, timeout is 5000 ms, and timeout
samples remain in the metric population. The two packet timestamps must fall
after the runtime freeze and within the manifest's bounded capture skew (at
most one hour).

`deployed_field_policy_sha256` is externally attested provenance for the exact
root Worker commit/configuration; it is not assumed to equal Agent Core's
reference Worker policy. `scorer_required_allowlist_sha256` separately binds
the fail-closed Eval policy implemented by this scorer. The Planner must verify
the deployment-policy receipt when freezing the runtime manifest.

The runtime `pool.pool_recipe_sha256` is the canonical digest of the complete
`pool.recipe` object. `pool.pool_manifest_sha256` is the canonical digest of
the complete pool manifest. Both prediction packets must bind the same pool
manifest digest. The scorer rejects any runtime, dataset, pool, packet,
adapter, catalog, index, tenant, request, or contract identity mismatch.

## Judgment pool

The pool is frozen before independent annotation and contains exactly 120 core
cases plus 180 provisional cases. It binds the same catalog, candidate-index,
and tenant-policy snapshots as the runtime. Its candidate union includes the frozen
legacy lane, Meilisearch lexical lane, BGE vector lane, controlled alias lane,
bounded Shopify fallback, known positives, and approved negatives. Candidate
source and rank are blinded before presentation, and candidates are deduped by
the 22-character `public_id`.

Exactly 200 cases receive unique `priority_known_stock_rank` values from 1 to
200. Each priority case must have gold status `results`, at least one positive
grade, and a non-null evidence hash bound to the current catalog snapshot.
Those semantic checks, uniqueness of nested IDs and ranks, and inclusion of
all gold and forbidden IDs in the pool are enforced by the scorer's closed
runtime validator. The adjacent Draft 2020-12 schemas are exchange contracts;
CI locks their critical nested constraints to the runtime checks.

The core candidate-universe fingerprint deliberately reuses the annotation
agreement algorithm:

1. sort the 120 core case IDs;
2. sort each case's candidate IDs;
3. form `[{case_id,candidate_ids}]`;
4. serialize with recursively key-sorted canonical JSON; and
5. SHA-256 the UTF-8 bytes.

It must equal the agreement artifact's candidate-universe fingerprint. The
provisional fingerprint is calculated separately. Prediction Top 50 IDs must
all belong to the corresponding case's pool. An unjudged ID invalidates the
run; it is never silently treated as grade zero. Changing a pool-forming
retrieval lane, depth, embedding model, index, candidate configuration, or
judgment universe requires a new pool and new blind annotation. A reranker
that only reorders the frozen pool does not itself create a new universe.

The recipe/source hashes are an approval receipt for the candidate union; the
aggregate scorer does not reconstruct retrieval or infer per-result lane
membership. `generalizes_beyond_judgment_pool` therefore remains false. Any
recipe or source-revision change invalidates the receipt and requires
re-pooling.

The single `bge_vector` lane must bind the exact provider ID, revision, and
config hash through one canonical model-identity digest. Changing any part of
that model identity cannot reuse a prior pool.

## Prediction capture

Each arm contains exactly the same 300 cases and exactly four surfaces per
case: HTTP, MCP, Chat, and Storefront. Each surface binds its adapter, transport
profile and contract, exact arm-specific target deployment/configuration,
upstream Core deployment/configuration, routing receipt, request, normalized
intent, raw response, source state, canonical status, returned public product
fields, normalized Core-payload JSON pointers, and latency. Attempts are fixed
to one.

The legacy packet is cryptographically bound to the manifest's frozen
`legacy/off/off` latency-baseline deployment, configuration, catalog, and
index; the candidate packet is bound to the isolated quality-capture
deployment and candidate configuration. Both also bind the same release,
datasets, tenant policy, query packet, and judgment pool.

The four raw transports are deliberately not treated as one shape. Their
frozen profiles are direct Search v2 HTTP, MCP JSON-RPC `tools/call`, Mini Chat
BFF, and Reference Storefront BFF. HTTP and MCP targets must exactly equal the
arm's frozen Core deployment and configuration. Mini Chat and Storefront bind
their BFF target plus a receipt hash for the exact upstream Core deployment and
configuration; the prediction packet must echo all three bindings. The
approved external capture runner must
validate each complete raw envelope against the exact per-surface transport
contract, report zero raw-envelope private fields and credential/PII/internal-
host values, and then extract the Core payload. `normalized_core_payload_json_pointers` are collected from that
payload before product allowlist normalization; `raw_response_sha256` still
hashes the complete raw transport bytes. A false transport attestation, wrong
target, wrong contract, or wrong adapter is rejected before scoring.

The normalized pointer names and raw digest enter only the private input,
never the aggregate artifact. Product fields are independently checked against
the positive allowlist and deterministic hard-constraint evaluator; the
capture runner cannot assert that a product passed a constraint.

The scorer uses a frozen positive allowlist for public attribute names as well
as top-level product fields. Unknown attributes, credential/PII-shaped names,
credential/PII/internal-host values in otherwise public fields, and unknown
Core-payload pointers fail the private-field Gate. This is an Eval
boundary only: Session B does not change production projection behavior; a
failure must be handed to the Search/Agent owner for a compatibility-reviewed
production fix.

Chat and Storefront status and result IDs must come from the underlying Core
tool payload, never inferred from natural-language text or DOM copy. MCP
normalization is locked as follows:

- `catalog_match` maps to `results`;
- `no_match` maps to terminal `no_match` only when the plan is complete, scope
  is exhausted, the scan limit was not reached, and the source is not degraded;
- searching, incomplete, truncated, timeout, transport failure, and provider
  failure map to `degraded`, never terminal `no_match`.

## Metrics and absolute Gates

Every split and every surface is scored independently. A failing surface may
not be hidden by averaging it with the other three.

Ranking metrics include only cases whose gold status is `results`:

- `Recall@K = |TopK intersect relevant| / |relevant|`;
- `Precision@10 = relevant visible Top10 / visible Top10 count`;
- NDCG uses graded relevance and IDCG truncated to the best 10 grades.

A positive case with no returned result contributes zero to Recall, Precision,
and NDCG. A split with no positive case, no valid denominator, or zero IDCG
fails closed. Metrics are macro averages across eligible cases. Thresholds are
compared before rounding and emitted with at most six decimal places:

- Recall@20 at least `0.90`;
- Recall@50 at least `0.95`;
- Precision@10 at least `0.85`;
- NDCG@10 at least `0.80`; and
- status accuracy exactly `1.0`.

Invalid, duplicate, unjudged, forbidden, accessory mismatch, tenant-scope,
private-field, hard-constraint, terminal-state, and execution-failure counts
must all be zero. Hard constraints use the hashed deterministic evaluator;
substring matching is forbidden, so a token such as `red` cannot match
`recycled`.

## False no-match and terminal truth

The scorer reports both:

- `unexpected_terminal_no_match`: actual `no_match` when gold is anything
  other than `no_match`; and
- `positive_false_no_match`: actual `no_match` when gold is `results`.

The overall false-no-match rate divides unexpected terminal misses by the
number of cases whose gold status is not `no_match`, across all 300 cases, and
is emitted separately for each surface and arm. It must be at most `0.01`.
Every split/surface is also checked independently, so aggregation cannot hide a
bad cohort. The separately frozen known-stock Gate is exactly zero false
no-matches among 200 priority cases.

`degraded` is not counted as false no-match, but it does not pass for free: it
still fails status accuracy when gold is `results`. Terminal `no_match`
requires empty results, a complete plan, exhausted scope, no scan-limit
truncation, and a non-degraded source. Any other combination is a terminal
state violation.

## Four-surface consistency

For each arm and case, the scorer compares all six surface pairs using Top-20
sets. Two empty sets with matching status have Jaccard `1`; one empty and one
non-empty set has Jaccard `0`. Malformed or duplicate IDs fail before set
construction.

All 300 cases must have identical canonical status on all four surfaces. The
minimum Jaccard across every case and all six pairs must be at least `0.80`.
Request, normalized-intent, tenant-scope, catalog, and adapter identities must
also agree. An identity mismatch is an input failure, not a relevance result.

## Latency and candidate comparison

Percentiles use nearest rank: after sorting, select `ceil(N * p) - 1`.
Timeouts remain in the sample with the configured timeout value and a degraded
execution state. Missing, zero, or non-finite legacy denominators; missing
samples; discarded timeouts; or retries all fail closed.

Candidate p95 must be at most 3000 ms and p99 at most 5000 ms on every surface.
For each surface, `(candidate_p95 / legacy_baseline_p95) - 1` must be at most
`0.15`; the headline regression is the worst of all four surfaces across the
training, hidden-holdout, and provisional splits.

Candidate retention uses only hidden HTTP for the positive lift decision:

- NDCG@10 improves by at least `0.03`, or Recall@20 improves by at least
  `0.02`;
- candidate Precision@10 is no more than `0.01` below legacy on every surface
  in both hidden and provisional splits;
- provisional Recall@20, Recall@50, NDCG@10, status, and safety do not regress
  on any surface; and
- all absolute, safety, known-stock, terminal, cross-surface, and latency Gates
  pass.

Training lift never selects the candidate. The only recommendations are
`retain_candidate_for_further_shadow`, `keep_legacy_authoritative`, and
`no_safe_baseline_manual_escalation`. Even a retained candidate remains Shadow;
the artifact always has `authorizes_search_rollout: false` and
`authorizes_release: false`.

## Hash and data-safety rules

Fields explicitly named `*_canonical_sha256`, the runtime-manifest binding,
the pool-manifest binding, recipe binding, and JSON input artifact bindings use
recursively key-sorted canonical JSON encoded as UTF-8. Arrays retain their
contractual order unless a fingerprint algorithm above explicitly sorts them.
`raw_response_sha256` and source-code digests hash the exact captured bytes.

The runner rejects duplicate JSON keys before its closed runtime validation. It checks
lexical absolute paths, physical real paths, case-insensitive Windows paths,
symlink or junction ancestors, and hardlink counts. Inputs under the checkout,
hardlinked inputs, non-ignored repository outputs, and existing output targets
are rejected. The open handle and resolved path must retain the same single-link
device/inode, size, and modification time before and after every read. Files
are size-limited, failures expose only fixed reason codes, and no partial
artifact is left behind. Output creation uses the already
resolved physical parent, verifies the created file identity through both the
open handle and path, and only removes a failed output when that identity still
matches.

The sanitized output shape is fixed by
[`artifact.schema.json`](artifact.schema.json). It contains only counts,
ratios, percentiles, booleans, enum decisions, commits, and SHA-256 digests.
Runtime validators enforce the input contracts and build the output from a
closed aggregate shape; CI additionally checks top-level shape and critical
nested Schema/runtime parity. The runner applies a final
boundary denylist and creates the destination with no-clobber semantics.
Passing this scorer is necessary evidence for the Planner, never an automatic
release decision.
