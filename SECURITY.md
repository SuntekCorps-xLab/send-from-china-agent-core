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

## Shopify read-only sandbox

The Shopify sandbox is an explicit development-store-only integration.
`SHOPIFY_STORE_DOMAIN` and `SHOPIFY_STOREFRONT_ACCESS_TOKEN` belong only in the
server process. They must not enter browser assets, request parameters, logs,
receipts, errors, fixtures, snapshots, or source control.

The provider pins Storefront API `2026-07`, accepts only a validated
`<store>.myshopify.com` domain, rejects IP/localhost/private-style hosts and
redirects, and exposes no arbitrary endpoint, GraphQL query, or mutation.
Responses must match the exact expected GraphQL shape; unknown fields,
oversized or malformed bodies, timeouts, and unexpected content types map to a
small public failure enum.

Readiness is fail-closed. Both the fixed health query and fixed catalog query
must succeed before `verified` becomes true. Missing credentials,
authentication failure, missing permission, exhausted quota, and upstream
unavailability never fall back to synthetic success.

The positive Shopify status capabilities are doctor, Storefront health, Search
Contract v2 catalog search, and published product detail. Cart, checkout,
order, payment, inventory, publication, and product mutation are always
disabled. Public results exclude vendor, cost, internal IDs, metafields,
customers, orders, and raw Shopify responses.

The provider enforces server-side quota, concurrency, timeout, response byte
limits, redirect rejection, and `no-store`. By default it persists no original
query, raw response, client IP, or Cookie. Browser calls contain no Shopify
credential and use no Cookie or local/session storage.

The Governance Worker remains a no-egress runtime. Only the explicit Shopify
commands (`doctor:shopify`, `sandbox:shopify`, and the separately opted-in live
smoke) may contact the configured development store. The default
`npm run sandbox`, unit tests, contract tests, browser tests, and CI make zero
external requests.

## Dependency assurance

Releases use locked installs, `npm audit`, Dependabot alerts, and automated
security updates. GitHub dependency review runs on pull requests
once the repository is public; GitHub does not provide that API to a private
repository without Advanced Security.

## Supported Versions

Security fixes target the latest `1.x` release. Production deployments remain
the deployer's responsibility.
