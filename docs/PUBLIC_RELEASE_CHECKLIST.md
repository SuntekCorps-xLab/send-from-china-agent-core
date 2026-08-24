# Public repository release checklist

These controls live in GitHub settings and cannot be proven by files alone.
Record the completed settings and links in the release review.

1. Make the reviewed repository public without changing the release commit.
2. Enable private vulnerability reporting.
3. Enable secret scanning and push protection.
4. Confirm the pinned CodeQL workflow runs successfully on the public commit.
5. Create a `main` ruleset requiring pull requests, at least one approval, the
   Worker, Python, safety, dependency-review, and CodeQL checks, and block force
   pushes and branch deletion.
6. Confirm Dependabot alerts and security updates are enabled.
7. Re-run the public safety scan and inspect the complete Git history for
   credentials or private data.
8. Create the `v1.0.0` release from the exact reviewed commit and link its CI
   and security evidence.
