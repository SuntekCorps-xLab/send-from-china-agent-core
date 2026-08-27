# Public repository release checklist

These controls live in GitHub settings and cannot be proven by files alone.
Record the completed settings and links in the release review.

1. Keep the repository private until the reviewed release commit passes the
   full verification, Skill validation, Redocly lint, and public-surface smoke
   test; then make that exact commit public.
2. Enable private vulnerability reporting.
3. Enable secret scanning and push protection.
4. Confirm the pinned CodeQL workflow runs successfully on the public commit.
5. Create a `main` ruleset requiring pull requests, at least one approval, the
   `search-contract`, `worker`, `python`, `safety`, `sbom`, dependency-review,
   and CodeQL checks, and block force pushes and branch deletion.
6. Confirm Dependabot alerts and security updates are enabled.
7. Re-run the public safety scan and inspect the complete Git history for
   credentials or private data.
8. From a clean external checkout, generate a fresh tenant key and repeat the
   README quickstart and public-surface smoke test.
9. Download the `spdx-sbom-<commit SHA>` CI artifact and confirm it contains
   valid SPDX 2.3 documents for Agent Core, the SDK, and Worker build tooling.
10. Create the release from the exact reviewed commit and link its CI,
    security, and SBOM evidence.
11. Run `npm run eval:full` and `npm run eval:security` on the exact release
    commit and retain their sanitized artifacts. Treat Eval v0 as public
    synthetic regression evidence, never as production relevance evidence.
