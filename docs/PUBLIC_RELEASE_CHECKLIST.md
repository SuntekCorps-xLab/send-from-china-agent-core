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
   Worker, Python, safety, dependency-review, and CodeQL checks, and block force
   pushes and branch deletion.
6. Confirm Dependabot alerts and security updates are enabled.
7. Re-run the public safety scan and inspect the complete Git history for
   credentials or private data.
8. From a clean external checkout, generate a fresh tenant key and repeat the
   README quickstart and public-surface smoke test.
9. Create the `v1.0.0` release from the exact reviewed commit and link its CI
   and security evidence.
