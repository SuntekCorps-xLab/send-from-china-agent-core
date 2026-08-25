# V1 Release Verification Evidence

## Scope

- Release: `1.0.0`
- Review date: 2026-08-24
- Scope: published snapshot contract, positive product field policy,
  tenant-scoped HTTP and MCP gateway, anti-enumeration controls, non-binding
  catalog estimate, confirmed fixture sourcing preview, file-only ETL, local
  snapshot publisher, Agent Skill, key generator, and public smoke client
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

The V1 verification run produced these results:

- locked dependency installation completed with zero reported vulnerabilities;
- Worker static checks passed for 18 JavaScript files;
- 41 of 41 Worker tests and 2 of 2 tenant-key generator tests passed;
- poison-field, atomic snapshot, tenant isolation, enumeration, quota,
  strict structured-criteria, catalog-estimate, search-proof, single-use
  confirmation, and no-egress tests passed;
- MCP discovery remained available without a credential while every tool call
  failed closed without a tenant key;
- Python compilation passed, 4 of 4 ETL tests passed, and 10 of 10 publisher
  tests passed;
- the sample publisher output passed the Worker snapshot validator;
- the repository safety scan passed with no credential, private host, private
  path, private integration, outbound Worker request, internal codename, Han
  character, or oversized-file finding;
- Redocly validated `contracts/openapi.yaml` with no error or warning.
- the example `send-from-china-catalog` Skill passed the Skill Creator
  quick validator;
- the external public-surface smoke client passed against a local Worker,
  including public discovery, unauthenticated 401, authenticated search, and
  MCP tool discovery.

The sourcing preview remains synchronous, illustrative, and ephemeral. The
catalog estimate is explicitly non-binding and excludes shipping and tax.
These checks verify the public contract and boundaries;
they do not claim a durable task, external provider call, purchasable sourcing
result, or transaction.

## Unreleased SDK verification

On 2026-08-25, `npm run verify` passed on the current tree, including 41 Worker
tests, 9 JavaScript SDK tests, 2 tenant-key generator tests, 4 ETL tests, 10
publisher tests, snapshot validation, documentation links, and the public
safety scan. This local result covers the unreleased SDK changes; it does not
claim that the current tree has been deployed or reviewed by GitHub Actions.

The destination GitHub repository must run `.github/workflows/ci.yml` on the
exact release commit before the `v1.0.0` tag is created.
