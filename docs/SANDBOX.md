# Local Sandbox

The Agent Core sandbox provides two explicit, loopback-only modes with the same
closed browser status contract and compatible public search/product result
shape. `synthetic_local_sandbox` is the default zero-account mode. It uses only
the checked-in fixture and makes zero external requests.
`shopify_read_only` is separately started and reads published catalog data from
one configured Shopify development store.

## Run it

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm run sandbox
```

Open `http://127.0.0.1:8787/sandbox`.

That is the entry point for the default synthetic experience. It includes
executable HTTP and MCP recipes, response inspection, copyable local calls, and
a confirmation-gated illustrative sourcing flow.

## Modes

`npm run sandbox` always starts `synthetic_local_sandbox`. Shopify credentials,
query parameters, request bodies, and request headers cannot change that
process into live mode.

To start the explicit read-only mode, create a Storefront API token for a
Shopify development store, publish only the products intended for storefront
visibility, and keep both values in the server environment:

```bash
export SHOPIFY_STORE_DOMAIN="your-development-store.myshopify.com"
export SHOPIFY_STOREFRONT_ACCESS_TOKEN="<storefront-access-token>"
npm run doctor:shopify -- --json
npm run sandbox:shopify
```

`npm run sandbox:shopify` fails closed when readiness is not verified. It does
not start a synthetic server and does not label a failed Shopify connection as
successful.

The optional `npm run smoke:shopify:live` command runs the read-only doctor and
exactly 20 distinct known-query cases. It requires both `SHOPIFY_LIVE_SMOKE=1`
and `SHOPIFY_DEVELOPMENT_STORE_CONFIRMED=1`, plus an operator-selected JSON file
in `SHOPIFY_KNOWN_QUERY_MANIFEST`. Only set the confirmation after checking that
the configured token belongs to the dedicated development store. A missing
configuration or failed doctor stops the smoke without synthetic fallback.

The manifest is an array of exactly 20 objects, each with `query`, a nonempty
`expected_handles` array, and optional Search Contract v2 `hard_constraints`.
Each case requests up to 20 products and must find every expected handle with
zero relaxations and no degraded state. The report contains only numbered case
outcomes and aggregate counts; it never prints queries, handles, domains,
credentials, raw responses, or upstream error messages. Keep private manifests
outside version control. No credential value belongs in shell arguments or logs.
Default tests and CI use injected fetch implementations and synthetic Shopify
fixtures and make zero external requests.

## What the synthetic wrapper does

At startup, `sandbox/server.mjs` generates a random tenant token in memory. The
browser-safe `/sandbox/*` wrapper injects that token on the server side for a
small route allowlist and calls the real Worker handler in the same process.
The token is not written to disk, printed, placed in HTML, or returned by a
browser endpoint.

The Node helper `startSandbox()` returns the token only to its controlled caller
so integration tests can verify that canonical routes retain bearer
authentication. Do not log or persist that value.

Every browser-safe response includes:

```text
X-Send-From-China-Sandbox-Mode: synthetic_local_sandbox
X-Send-From-China-Sandbox-Boundary: synthetic-fixture; no-shipping-rates; no-commerce-writes
```

`GET /sandbox/status` is the authoritative browser label. It reports the
synthetic data source, absent browser credential, and disabled shipping and
commerce writes. Browser-safe JSON responses also carry
`mode: synthetic_local_sandbox`; canonical Worker responses retain their
normal contract mode.

Both modes use the closed `shopify-live-sandbox-status/v1` contract. It rejects
unknown fields and reports `mode`, `verified`, `credential_state`,
`data_source`, `api_version`, `quota`, `writes: false`, capabilities,
`checked_at`, and a public `error_code`. Credential states are exactly
`mock_ready`, `credential_missing`, `authentication_failed`,
`permission_required`, `quota_exceeded`, `service_unavailable`, and
`succeeded`. Public status failures are limited to `CREDENTIAL_MISSING`,
`AUTHENTICATION_FAILED`, `PERMISSION_REQUIRED`, `QUOTA_EXCEEDED`, and
`SERVICE_UNAVAILABLE`.

Shopify readiness requires both the fixed `ShopifySandboxHealth` and
`ShopifySandboxCatalog` operations to complete successfully. Configuration,
DNS, or one successful query is insufficient.

Before a browser-safe JSON response leaves the wrapper, it receives a
conservative sandbox projection. Products use `availability_band: demo_only`,
`purchasable: false`, `available: false`, and `illustrative_only: true`.
Catalog estimates use `availability: demo_only` with the same negative flags
and remain non-binding. Image, product, cart, checkout, order, payment,
purchase, and supplier URLs are removed. Canonical responses are not changed.

For MCP tool results, the projection is applied to `structuredContent` and the
text content is regenerated from that exact object. The JSON-RPC envelope and
MCP content shape remain valid and consistent.

## Synthetic browser-safe routes

| Method | Local route | Purpose |
| --- | --- | --- |
| `GET` | `/sandbox/status` | Sandbox truth labels |
| `GET` | `/sandbox/.well-known/send-from-china.json` | Capability discovery |
| `GET` | `/sandbox/health` | Fixture freshness and count |
| `GET` | `/sandbox/api/search?q=...` | Tenant-scoped search |
| `POST` | `/sandbox/api/search/v2` | Search Contract v2 |
| `GET` | `/sandbox/api/products/:slug` | One public product |
| `POST` | `/sandbox/api/quote` | Non-binding catalog estimate; no shipping or tax |
| `POST` | `/sandbox/api/chat` | Deterministic catalog conversation |
| `POST` | `/sandbox/mcp` | MCP discovery and fixture tool calls |

In `shopify_read_only` mode the browser route allowlist is exactly:

| Method | Local route | Purpose |
| --- | --- | --- |
| `GET` | `/sandbox/status` | Closed readiness and capability status |
| `POST` | `/sandbox/api/search/v2` | Published storefront product search |
| `GET` | `/sandbox/api/products/:handle` | One published storefront product |

These routes retain the public status/search/product structures used by the
synthetic mode. Synthetic-only health, quote, chat, MCP, sourcing, enumeration,
arbitrary proxy, and canonical routes are unavailable in Shopify mode.

There is no browser-safe catalog enumeration, arbitrary proxy, publisher,
product write, carrier rate, cart, checkout, order, or payment route. Invalid
wrapper paths fail closed before the Worker is called.

In `synthetic_local_sandbox` mode, the canonical `/.well-known`, `/health`,
`/api/*`, and `/mcp` routes are also served by the same local process without
sandbox credential injection. Their normal authentication behavior is
unchanged.

Sandbox capability discovery advertises `/sandbox/mcp` with
`local_server_injected_ephemeral_scope`. MCP `initialize` repeats that boundary
and explains that the client supplies no tenant credential. Both responses also
state that a canonical deployment uses `/mcp` with a bearer tenant key, so an
automatic client does not accidentally switch from sandbox to canonical auth.

## Shopify provider boundary

The provider constructs one HTTPS endpoint from a validated
`<store>.myshopify.com` domain and pins Storefront API `2026-07`. It exposes no
arbitrary endpoint or GraphQL input. Only the fixed health, catalog, and product
queries can run; mutations and caller-supplied queries are not accepted.
IP literals, localhost/private-style hostnames, redirects, changed response
URLs, non-JSON responses, malformed envelopes, and unknown response fields fail
closed.

Only products with a valid public `onlineStoreUrl` are returned. Fixed queries
select `handle`, `title`, `description`, `onlineStoreUrl`, `availableForSale`,
`priceRange.minVariantPrice`, `productType`, up to eight image URL/alt pairs,
and up to 20 public product options. The image host is restricted to HTTPS
`cdn.shopify.com`; redirects and credential-bearing or private URLs fail closed.
Option names pass the positive public-attribute allowlist, with bounded strings
and values; unknown/private option names are discarded. Unknown nested fields
in the upstream product, image, and option shape are rejected. Every public
product passes the Governance Worker field policy before the read-only envelope
adds an opaque `public_id`, `shopify_verified_at`, `writes: false`, and the
`catalog_read_only_non_transactional` boundary. Vendor, cost, internal Shopify
IDs, metafields, customer/order data, and raw responses are never projected.

The hosted and local providers share deterministic checks for supported hard
constraints over public catalog facts. Missing evidence or an unsupported
condition produces an explicit relaxation and degraded scope, never a terminal
`no_match`. An empty filtered page with a next cursor remains nonterminal.
See [Search Contract v2](SEARCH_CONTRACT_V2.md) for constraint semantics.

Default server controls are a 5-second upstream timeout, a 256 KiB response
limit, 60 Storefront GraphQL operations per 60-second window, four concurrent
Storefront operations, and at most 20 products per search response. Readiness
is cached for 15 seconds after the two fixed checks. Upstream and browser
responses use `no-store`. The server does not persist the original query,
Shopify response, client IP, or Cookie, and it never logs the Storefront token.

The browser receives zero Shopify credentials, uses `credentials: "omit"` and
`cache: "no-store"`, follows no redirects, and may call only the loopback
`/sandbox/*` origin. It uses neither Cookie nor local/session storage. Mode
headers and query parameters are not authority; the server-started mode and
validated status contract are authoritative.

## Connect an MCP client

For a local, zero-account fixture session, point a Streamable HTTP MCP client at
the browser-safe route without custom headers:

```json
{
  "mcpServers": {
    "send-from-china-sandbox": {
      "url": "http://127.0.0.1:8787/sandbox/mcp"
    }
  }
}
```

This endpoint is loopback-only. A deployed Agent Core endpoint uses the
canonical `/mcp` route and a deployment-issued bearer credential.

## Four access states

| State | Identity | Data | Intended use | Writes |
| --- | --- | --- | --- | --- |
| Local zero-account demo | Process-only ephemeral tenant | Checked-in synthetic fixture | Learn, inspect, and test the contract | None |
| Local Shopify read-only sandbox | Server-only Storefront credential | Published products in one development store | Validate public catalog integration | None |
| Hosted invite-only preview candidate | In-memory invite proof with server-side digest and rate limit | Published development-store catalog | Protected external catalog-read testing | None |
| Reviewed production | Operator-provisioned tenant and policy | Authorized deployment snapshot | Production read integration | Not included in this repository |

The two local states and an independent hosted invite-only candidate are
implemented here. The hosted candidate lives in `hosted-sandbox/`, keeps the
Shopify credential server-side, requires a hashed invite proof and Cloudflare
rate-limit binding, and has no write route. It is not a self-service production
platform. Broader access would still require identity verification, individual
short-lived credentials, tenant isolation, rotation, revocation, abuse
controls, and budget limits. A shared public production key is not acceptable.

## Security properties

- The server binds to a loopback address and rejects non-loopback hosts through
  `startSandbox()`. The lower-level `createSandboxServer()` factory also guards
  its `listen()` method, including calls that omit a host.
- Static assets use no external scripts, fonts, images, or analytics.
- The default synthetic wrapper never calls a network client; it invokes
  `worker.fetch()` directly. Only the explicit Shopify server has the fixed
  Storefront read path described above.
- Product responses still pass through the positive public-field allowlist.
- The synthetic tenant cannot enumerate the complete catalog.
- MCP JSON-RPC envelopes remain valid. Tool `structuredContent` and its text
  representation receive the same conservative projection, while `initialize`
  carries explicit sandbox and canonical-auth metadata.
- Sourcing requires a terminal confirmed search proof and explicit user action.
  Its in-memory results remain non-billable, non-purchasable, and illustrative.

Run `npm run test:sandbox` for the focused boundary suite or `npm run verify`
for the complete repository verification.
