# Managed public catalog client

Agent Core `1.2.0` keeps three catalog connection profiles distinct. None of
them creates a cart, checkout, order, payment, inventory change, publication,
or product mutation.

| Profile | Transport | Credential | Product key | Purchase boundary |
| --- | --- | --- | --- | --- |
| Managed public catalog | Fixed MCP over HTTPS | None | `handle` | Verified public product page only |
| Self-hosted Agent Core | HTTP or MCP | Tenant Bearer token | `slug` | Explicitly allowlisted merchant origin |
| Local Shopify sandbox | Loopback HTTP | Shopify token stays in the server | `handle` | Development-store product page only |

The managed SDK profile fixes its endpoint to
`https://wp-api.sendfromchina.ai/mcp`. It cannot accept a token, endpoint,
arbitrary tool name, or write-capable operation. It verifies MCP initialize and
requires the five public read tools within discovery before the first call. The
managed server can advertise protected tools, but this client neither exposes
nor calls them. It sends no
Authorization or Cookie header, disables redirects and caching, and applies a
five-second timeout, 512 KiB response limit, and two-request concurrency cap.
Unknown envelope and projected-field shapes fail closed. Documented detail
collections outside the projection are never returned to the caller.

The managed server's public discovery can include protected account, sourcing,
and governance tools. Discovery is therefore a superset: the client requires
the five read tools and exposes only `product_search` and `get_product`. It does
not require or imply that the server itself has only five tools.

The SDK projects the current managed wire into a deliberately smaller public
shape. Search `results` become `products`; `price_usd` plus `currency` become
`price.amount` plus `price.currency`; `url` becomes `product_url`; and public
catalog, purchase-status, market-review, and cart-verification facts retain
their source names. The projection intentionally omits raw query/reply text,
search proofs, variant identifiers, fact-evidence internals, and unrecognized
fields. It does not invent `availableForSale` or `shopify_verified_at`, because
the managed response does not attest either field. `boundary.writes=false` is
an SDK capability guarantee, not a field claimed to come from Shopify.

## Hosted managed MCP through the SDK

```js
import { createManagedPublicCatalogClient } from "@send-from-china/agent-sdk";

const client = createManagedPublicCatalogClient();
const search = await client.productSearch({
  query: "desk organizer",
  mode: "catalog",
  operation: "confirm_search",
  limit: 5,
});
const summary = search.products[0];
const product = summary ? await client.getProduct({ handle: summary.handle }) : null;
const handoff = product ? client.resolvePurchaseHandoff(product) : null;

if (handoff) {
  // Render a user-controlled “View product” link. Do not fetch checkout.
  console.log(handoff.url);
}
```

The handoff is non-null only for an exact HTTPS
`https://sendfromchina.ai/products/{handle}` URL whose handle matches the
current detail response. `confirm_search` remains a read-only confirmation of
criteria and can return a search proof; this client has no method that can use
that proof to create sourcing work. It does not accept quote, account,
mutation, arbitrary-tool, cart, or checkout calls.

## Self-hosted MCP through the general SDK

Self-hosted calls use the tenant credential and the schema discovered from that
deployment. Its `get_product` input is the public `slug`, not the managed
Shopify `handle`.

```js
import { createSendFromChinaClient } from "@send-from-china/agent-sdk";

const client = createSendFromChinaClient({
  baseUrl: process.env.SEND_FROM_CHINA_BASE_URL,
  token: process.env.SEND_FROM_CHINA_AGENT_TOKEN,
  commerceOrigins: [process.env.SEND_FROM_CHINA_STOREFRONT_ORIGIN],
});
const search = await client.productSearch({ query: "desk organizer", operation: "search", limit: 5 });
const product = await client.getProduct({ slug: search.products[0].slug });
const handoff = client.resolvePurchaseHandoff(product);
```

## Self-hosted HTTP

The equivalent HTTP sequence is authenticated `POST /api/search/v2`, followed
by `GET /api/products/{slug}`. The complete Search Contract v2 wire request is
required. A product URL is still only a customer-facing handoff; it is not
transaction authority.

```js
import { selfHostedHttpFlow } from "../examples/catalog-read-profiles.mjs";

const result = await selfHostedHttpFlow({
  product_identity: "desk organizer",
  limit: 5,
}, {
  baseUrl: process.env.SEND_FROM_CHINA_BASE_URL,
  token: process.env.SEND_FROM_CHINA_AGENT_TOKEN,
  commerceOrigins: [process.env.SEND_FROM_CHINA_STOREFRONT_ORIGIN],
});
```

The executable functions for all three sequences are in
[`catalog-read-profiles.mjs`](../examples/catalog-read-profiles.mjs). Automated
tests inject synthetic `fetch` fixtures; default CI makes no request to the
managed endpoint. No live smoke is part of this client or the default verify
command.

## Local Shopify and Reference Store

Reference Store must call only the loopback sandbox routes documented in the
[Hosted Platform quickstart](HOSTED_PLATFORM_QUICKSTART.md). It must first
validate `GET /sandbox/status` and require `verified=true`. Until a dedicated
development store passes both fixed readiness queries, the truthful state is
`credential_missing`, read-only, and `writes=false`; do not present the live
catalog as available. Browser code receives no Shopify credential, Cookie, raw
response, or persisted catalog payload.
