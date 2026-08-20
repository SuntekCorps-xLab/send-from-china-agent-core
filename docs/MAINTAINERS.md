# Maintainer Responsibilities

## Ownership

The repository owner appoints the Send From China open-source maintainer group
before enabling public contributions. That group is responsible for code
review, release approval, vulnerability triage, and keeping the declared public
scope separate from private production systems.

Until named GitHub accounts or teams are configured, the repository must remain
in release-candidate status and external pull requests must not be merged.

## Review Rules

- Every pull request needs one maintainer approval and successful required CI.
- Security-boundary, dependency, workflow, or release changes need a second
  review by the repository owner.
- A maintainer must confirm that the public safety scan covers the complete
  diff and generated release artifact.
- No reviewer may approve a change containing credentials, customer data,
  private catalog records, private hosts, or unlicensed product media.

## Release Duties

The release owner records the candidate commit, dependency lockfile, test
results, safety-scan result, and release notes. Production deployment of a
downstream commerce system is outside this repository's scope.
