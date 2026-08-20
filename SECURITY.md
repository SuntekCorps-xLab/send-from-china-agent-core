# Security Policy

## Reporting

Do not open a public issue for a vulnerability or suspected credential leak.
Use the repository's private security-advisory channel. If private reporting is
not enabled yet, contact the repository maintainers through the organization
that published the repository and mark the message confidential.

Include affected versions, reproduction steps, impact, and a minimal proof of
concept. Do not access customer data, modify production records, or perform
denial-of-service testing.

## Secrets

Credentials belong in platform secret stores or local ignored files such as
`.dev.vars`. They must never appear in commits, issue attachments, screenshots,
theme settings committed to Git, or sample payloads.

If a secret is committed, revoke or rotate it immediately. Removing it from the
latest commit is not sufficient because Git history and build logs may retain it.

## Supported Versions

Until the first stable release, security fixes target the newest release
candidate only. Production deployments remain the deployer's responsibility.
