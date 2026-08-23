# Repository Guardrails

These rules apply to the entire repository.

## Non-negotiable invariants

1. `governance-worker/` must never contain internal hostnames, connection strings, credentials, accounts, or private identifiers.
2. Worker runtime code must never make outbound network requests. Do not call `fetch` from `governance-worker/src/`.
3. Every product response must pass through the positive field allowlist in `governance-worker/src/field-policy.js`. Unknown fields are discarded.

## Engineering constraints

- Do not add runtime dependencies. The Worker uses the platform runtime and Node.js built-ins for tests.
- Keep GitHub Actions pinned to immutable commit SHAs.
- Add or update tests for every security boundary or contract change.
- Keep code, comments, fixtures, and documentation in English.
- Do not commit credentials, production catalog records, internal mappings, customer data, or private integration names.
- Keep catalog, quote, and sourcing examples non-binding and free of cart, checkout, order, payment, or publication writes.
- Publisher code may read user-selected local files and write ignored build artifacts, but it must not make network requests.
- Publisher keys must come from the environment and must never appear in snapshots, reports, exceptions, or logs.
- Local source identifiers must never appear in a published snapshot or report.

## Required verification

Run both commands before committing:

```bash
cd governance-worker && npm run verify
cd .. && node scripts/scan-public.mjs .
python -m unittest discover -s publisher/tests -p 'test_*.py'
```
