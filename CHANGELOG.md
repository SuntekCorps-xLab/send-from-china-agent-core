# Changelog

All notable changes to the public reference implementation are documented here.

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
