# Release Process

1. Start from a clean checkout of the release commit.
2. Run the Worker checks and tests from a fresh `npm ci` installation.
3. Run `npm run sdk:test` and `npm run types:check` from the repository root.
4. Run the Python compile and ETL tests used by CI.
5. Run the publisher tests and build the synthetic sample snapshot.
6. Validate that snapshot with `scripts/validate-snapshot.mjs`.
7. Run `node scripts/scan-public.mjs .`.
8. Run `npm audit --audit-level=high` in `governance-worker`.
9. Download and inspect the `spdx-sbom-<commit SHA>` CI artifact. It must
   contain parseable SPDX 2.3 documents for Agent Core, the dependency-free
   SDK, and the Worker's locked build and test dependency graph.
10. Review the complete diff and generated file manifest.
11. Tag the exact reviewed release commit only after CI and CodeQL reach a
    successful terminal state.
12. Validate an independently produced paired E2E artifact against
    `contracts/paired-release-evidence.v1.schema.json` and generate the release
    evidence with `npm run release:evidence -- ...`. The generator binds the
    tagged Git commit and tree; never type or predict a future merge SHA.
13. Create the GitHub Release and link the generated evidence manifest.

For the first public release, also complete and record every item in
[`PUBLIC_RELEASE_CHECKLIST.md`](PUBLIC_RELEASE_CHECKLIST.md).

Release notes must state whether API shapes, environment settings, or security
boundaries changed. Never attach local environment files, screenshots containing
customer data, browser profiles, build caches, or production exports.
