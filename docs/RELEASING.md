# Release Process

1. Start from a clean checkout of the candidate commit.
2. Run the Worker checks and tests from a fresh `npm ci` installation.
3. Run the Python compile and ETL tests used by CI.
4. Run the publisher tests and build the synthetic sample snapshot.
5. Validate that snapshot with `scripts/validate-snapshot.mjs`.
6. Run `node scripts/scan-public.mjs .`.
7. Run `npm audit --audit-level=high` in `governance-worker`.
8. Review the complete diff and generated file manifest.
9. Tag a release candidate only after CI reaches a successful terminal state.

For the first public release, also complete and record every item in
[`PUBLIC_RELEASE_CHECKLIST.md`](PUBLIC_RELEASE_CHECKLIST.md).

Release notes must state whether API shapes, environment settings, or security
boundaries changed. Never attach local environment files, screenshots containing
customer data, browser profiles, build caches, or production exports.
