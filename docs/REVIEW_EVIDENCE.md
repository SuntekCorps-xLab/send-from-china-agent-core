# Release Candidate Verification Evidence

## Scope

- Candidate: `0.4.0-rc.1`
- Review date: 2026-08-23
- Scope: published snapshot contract, positive product field policy,
  tenant-scoped HTTP and MCP gateway, anti-enumeration controls, non-binding
  quote, fixture sourcing preview, file-only ETL, and local snapshot publisher
- Excluded: source connectors, production catalogs, customer accounts,
  payments, orders, fulfillment, private connectors, and production credentials

## Reproduction commands

```bash
cd governance-worker
npm ci
npm run verify
npm audit --audit-level=high
cd ..

python -m compileall -q etl-pipeline/scripts etl-pipeline/tests publisher
python -m unittest discover -s etl-pipeline/tests -p 'test_*.py' -v
python -m unittest discover -s publisher/tests -p 'test_*.py' -v
python publisher/build_snapshot.py --source publisher/samples/catalog-input.sample.json --output build/published-catalog.json --report build/publisher-report.json --generated-at 2026-08-23T12:00:00Z
node scripts/validate-snapshot.mjs build/published-catalog.json

node scripts/scan-public.mjs .
npx --yes @redocly/cli lint contracts/openapi.yaml
```

## Recorded local results

The 2026-08-23 candidate run produced these results:

- locked dependency installation completed with zero reported vulnerabilities;
- Worker static checks passed for 18 JavaScript files;
- 37 of 37 Worker tests passed;
- poison-field, atomic snapshot, tenant isolation, enumeration, quota,
  non-binding quote, and no-egress tests passed;
- MCP discovery remained available without a credential while every tool call
  failed closed without a tenant key;
- Python compilation passed, 4 of 4 ETL tests passed, and 10 of 10 publisher
  tests passed;
- the sample publisher output passed the Worker snapshot validator;
- the repository safety scan passed with no credential, private host, private
  path, private integration, outbound Worker request, internal codename, Han
  character, or oversized-file finding;
- Redocly validated `contracts/openapi.yaml` with no error or warning.

The sourcing preview remains synchronous and ephemeral. The quote is explicitly
non-binding. These checks verify the Phase 2 public contract and boundaries;
they do not claim a durable task, external provider call, purchasable sourcing
result, or transaction.

The destination GitHub repository must run `.github/workflows/ci.yml` on the
exact candidate commit before a release tag is created.
