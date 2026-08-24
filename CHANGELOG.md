# Changelog

All notable changes to the public reference implementation are documented here.

## Unreleased

- Added a dependency-free JavaScript SDK for capability discovery, catalog
  search, governed sourcing polling, paginated results, and allowlisted
  customer purchase handoffs.
- Added a hosted-platform quickstart and a read-only integration example.

## 1.0.0 - 2026-08-24

- Enforced structured product-search criteria as hard filters and reported
  which criteria are enforced versus informational.
- Added short-lived tenant-bound catalog-miss proofs and explicit confirmation
  requirements before the illustrative sourcing preview can be created.
- Marked all preview results as illustrative and prevented one search proof
  from creating multiple tasks.
- Clarified that `get_quote` is a catalog estimate that excludes shipping and
  tax and does not evaluate the destination.
- Added public capability discovery, an example Agent Skill, tenant-key
  generation, and a public-surface smoke test.
- Declared the first stable public HTTP, MCP, snapshot, and publisher contract.
- Synchronized the package, MCP discovery, OpenAPI, documentation, and release
  evidence versions.
- Added a cross-platform root `npm run verify` command covering Worker tests,
  Python pipelines, sample publication, snapshot validation, documentation
  links, and the public safety scan.
- Refreshed the GitHub presentation, pinned CodeQL workflow, repository settings
  checklist, and Dependabot coverage for public release.

## 0.4.0-rc.1 - 2026-08-23

- Added a standard-library Python publisher for user-owned JSON and JSONL
  catalogs.
- Added keyed stable public identifiers without emitting source identifiers or
  the identifier key.
- Added tenant source resolution, atomic snapshot and report writes, a
  publisher input schema, and a synthetic input example.
- Added a Node-side final snapshot validator and end-to-end CI coverage.
- Added ten publisher tests and external build, deployment, operations, and
  troubleshooting documentation.

## 0.3.0-rc.1 - 2026-08-23

- Replaced the hard-coded four-product catalog with an atomically validated
  twelve-product published snapshot fixture.
- Added a positive public product field policy and opaque public identifiers.
- Added tenant keys, product isolation, page limits, anti-enumeration behavior,
  daily quota responses, and public MCP discovery.
- Added a short-lived non-binding HTTP and MCP quote contract.
- Added OpenAPI, snapshot schema, external setup instructions, no-egress
  enforcement, and 37 Worker tests.

## 0.2.0-rc.1 - 2026-08-21

- Added bounded `product_search` with a truthful terminal `no_match` handoff.
- Added bearer-authenticated demo-agent access with explicit catalog and
  sourcing scopes and all transactional permissions disabled.
- Added an idempotent, preview-only synthetic sourcing lifecycle and paginated
  non-purchasable results.
- Kept all task state ephemeral and excluded supplier, product, cart, checkout,
  order, payment, and publication writes.
- Added lifecycle, authorization, ownership, idempotency, pagination, and
  fail-closed regression tests.

## 0.1.0-rc.4 - 2026-08-16

- Aligned the public project identity with the Send From China product name.
- Kept the synthetic catalog, read-only API surface, and private-integration
  exclusion boundary unchanged.

## 0.1.0-rc.3 - 2026-08-15

- Corrected the allowlist snapshot manifest so ignored nested build caches are
  excluded from both the file list and release artifact.
- Kept the public API, synthetic catalog, and security boundary unchanged.

## 0.1.0-rc.2 - 2026-08-15

- Added a synthetic, read-only catalog Worker.
- Added cursor pagination, search, product lookup, deterministic chat, and MCP.
- Added CORS allowlisting, request limits, safe error responses, and security headers.
- Added reproducible CI, dependency updates, release documentation, and safety scans.
- Added a file-only product validation and Shopify JSONL example.
- Added CI evidence artifacts and a documented maintainer review boundary.
- Added release-candidate verification and operational response guidance.
