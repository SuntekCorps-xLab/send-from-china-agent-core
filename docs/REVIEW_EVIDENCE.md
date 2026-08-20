# Release Candidate Verification Evidence

## Scope

- Candidate: `0.2.0-rc.1`
- Review date: 2026-08-21
- Scope: synthetic catalog Worker, guarded synthetic sourcing MCP contract, and
  file-only ETL
- Excluded: production catalogs, accounts, payments, orders, supplier systems,
  fulfillment systems, private connectors, and production credentials

This file records reproducible local checks. It does not claim that GitHub
Actions has passed in a repository that has not yet been published.

## Reproduction Commands

```bash
cd governance-worker
npm ci
npm run verify
npm audit --audit-level=high
cd ..

python -m py_compile etl-pipeline/scripts/*.py etl-pipeline/tests/*.py
python -m unittest discover -s etl-pipeline/tests -p 'test_*.py' -v
python etl-pipeline/scripts/validate_import.py \
  --source etl-pipeline/samples/sample_product.json \
  --output build/products.normalized.json \
  --report build/validation-report.json
python etl-pipeline/scripts/build_shopify_jsonl.py \
  --input build/products.normalized.json \
  --output build/shopify-products.jsonl \
  --manifest build/import-manifest.json

node scripts/scan-public.mjs .
```

## Recorded Local Results

The 2026-08-21 candidate run produced these results:

- locked dependency installation completed successfully;
- Worker static checks passed;
- 17 of 17 Worker tests passed, including sourcing authorization, explicit
  scope, idempotency, ownership, lifecycle, pagination, and non-commerce
  boundary coverage;
- locked dependency installation and the complete test suite passed. The
  registry-backed vulnerability query was attempted, but the local proxy
  rejected the request; this candidate does not claim a fresh audit result;
- Python compilation passed;
- 4 of 4 ETL tests passed;
- sample validation reported one valid record and zero errors;
- the JSONL builder produced one `DRAFT` product with inventory denied and no
  network call;
- the public safety scan found no credential, private host, private path,
  private integration, customer data, or oversized-file finding.

Synthetic sourcing is synchronous and ephemeral in this candidate. These tests
verify a public client contract; they do not claim a durable production task,
external provider call, purchasable result, or transaction.

The destination GitHub repository must run `.github/workflows/ci.yml` on the
exact candidate commit. Until that workflow reaches a successful terminal
state, its result remains unverified and the candidate must not be tagged as a
stable release.
