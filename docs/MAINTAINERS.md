# Maintainer Responsibilities

## Ownership

The repository owner appoints the Send From China open-source maintainer group
before enabling public contributions. That group is responsible for code
review, release approval, vulnerability triage, and keeping the declared public
scope separate from private production systems.

Before public contributions are enabled, configure a named GitHub maintainer
team and the branch rules in `PUBLIC_RELEASE_CHECKLIST.md`. Until then, external
pull requests may be reviewed but must not be merged.

## Review Rules

- Every pull request needs one maintainer approval and successful required CI.
- Security-boundary, dependency, workflow, or release changes need a second
  review by the repository owner.
- A maintainer must confirm that the public safety scan covers the complete
  diff and generated release artifact.
- No reviewer may approve a change containing credentials, customer data,
  private catalog records, private hosts, or unlicensed product media.

## Release Duties

The release owner records the release commit, dependency lockfile, test
results, safety-scan result, and release notes. Production deployment of a
downstream commerce system is outside this repository's scope.
