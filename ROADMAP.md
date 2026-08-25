# Public Roadmap

This roadmap describes the public reference implementation. It is directional,
not a promise of hosted-service availability or a delivery date.

## Available in 1.0

- Tenant-scoped catalog search and product reads over HTTP and MCP.
- Positive public-field allowlisting, quotas, anti-enumeration controls, and a
  no-egress Worker runtime.
- Non-binding catalog estimates that explicitly exclude shipping and tax.
- A file-only snapshot publisher for user-owned JSON and JSONL catalogs.
- A dependency-free JavaScript SDK for compatible self-hosted or hosted
  deployments.
- An explicitly confirmed, synthetic sourcing lifecycle for integration tests.

## Next

- Copyable JavaScript and Python client recipes for the most common read paths.
- A paired Agent Core + Reference Store local integration recipe.
- More contract fixtures for empty, partial, expired, quota-limited, and
  permission-denied states.
- Contributor-owned adapters that remain outside the no-egress core and fail
  closed when they are not configured.
- Public compatibility notes for additional MCP clients.

## Exploring

- A durable sourcing-task adapter interface, without embedding a private
  supplier implementation in this repository.
- A deployment template that preserves tenant isolation and secret handling.
- A synthetic evaluation pack for catalog relevance and truthful failure-state
  rendering.

## Deliberately out of scope

This repository will not contain merchant credentials, private supplier
connectors, production catalog exports, real carrier rates, checkout, payment,
order creation, or automatic purchasing. Those capabilities require a
separately operated service and independent authorization, audit, data, and
incident-response design.

Use a feature-request issue to propose an item. Maintainers will label accepted
work with `help wanted` or `good first issue` when its boundary and acceptance
tests are ready.
