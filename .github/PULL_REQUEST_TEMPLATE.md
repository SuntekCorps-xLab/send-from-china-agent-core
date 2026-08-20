## Problem

Describe the user or maintainer problem.

## Change

Describe behavior, API, configuration, and migration impact.

## Verification

- [ ] `npm ci && npm run verify` in `governance-worker`
- [ ] Python validation and JSONL tests
- [ ] `node scripts/scan-public.mjs .`
- [ ] No credentials, customer data, private hosts, or private catalog records
- [ ] Documentation updated when behavior or configuration changed
