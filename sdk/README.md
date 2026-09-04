# Send From China Agent SDK

A dependency-free JavaScript client for the public Agent Core contract and
compatible Send From China hosted deployments.

This workspace package is intentionally not published to the npm registry.
Install it from a checked-out repository before using the package-name import:

```bash
npm install --save file:../send-from-china-agent-core/sdk
```

The local package exports `src/index.js`, so consumers should use the scoped
package name below after that install. They should not import a nonexistent
`sdk/index.js` file. Repository-local examples may instead import
`../sdk/src/index.js` directly.

```js
import { createSendFromChinaClient } from "@send-from-china/agent-sdk";

const client = createSendFromChinaClient({
  baseUrl: process.env.SEND_FROM_CHINA_BASE_URL,
  token: process.env.SEND_FROM_CHINA_AGENT_TOKEN,
  commerceOrigins: [process.env.SEND_FROM_CHINA_STOREFRONT_ORIGIN],
});

const capabilities = await client.getCapabilities();
const search = await client.productSearch({
  query: "compact foldable laptop desk",
  criteria: { ship_to: "US" },
  operation: "confirm_search",
  limit: 20,
});
```

For new agent integrations, prefer the versioned product-first contract:

```js
const search = await client.searchContractV2({
  contract_version: "2.0",
  product_identity: "compact foldable laptop desk",
  hard_constraints: [],
  soft_context: [{
    name: "room", value: "small apartment", source: "explicit",
    scope: "session", hardness: "soft",
  }],
  transaction_context: [{
    name: "ship_to", value: "US", source: "explicit",
    scope: "transaction", hardness: "hard",
  }],
  limit: 20,
});

for (const product of search.results) {
  console.log(product.title);
}
```

`searchContractV2()` calls the authenticated `POST /api/search/v2` endpoint.
It accepts the ergonomic `SearchContractV2Request` shape shown above and sends
the complete normalized `SearchContractV2WireRequest` required by the strict
HTTP contract. Direct HTTP callers must send every required intent group and
must not send shorthand or unknown fields.
For a deployment that exposes only the stable `product_search` v1 tool, use
`searchContractV2ViaV1()` or the direct adapter exports. Unsupported v2
conditions appear in `relaxations`; they are never silently promoted to hard filters. See the
[Search Contract v2 integration guide](../docs/SEARCH_CONTRACT_V2.md) for the
schemas, status semantics, direct adapter exports, and versioning policy.

The Search Contract v2 product array is `search.results`. It is not
`search.items`; integrations using the old example should migrate to
`results`.

The client deliberately does not include cart, checkout, order, or payment
methods. A hosted deployment may return a customer-facing product, cart, or
checkout URL. Pass the exact storefront origins you trust and use
`client.resolvePurchaseHandoff(product)` before showing that link to a buyer.

The zero-account synthetic sandbox strips purchase URLs and configures no
trusted commerce origin, so `resolvePurchaseHandoff()` returns `null` there by
design. It can return a handoff only for an HTTPS URL whose origin exactly
matches a `commerceOrigins` entry in a connected deployment.

Dynamic sourcing must begin only after a terminal catalog miss and explicit
customer confirmation. See the
[Hosted Platform quickstart](../docs/HOSTED_PLATFORM_QUICKSTART.md) for the
complete flow.

## Safe error handling

SDK failures use `SendFromChinaError`. Branch on the stable `code` property;
known HTTP, JSON-RPC, and tool codes also receive stable public messages. An
unknown or malformed upstream code remains a generic request, MCP, or tool
failure and upstream error text is never reflected.

An `INVALID_SEARCH_CONTRACT` response may include the optional, allowlisted
`field` and `reason` properties. These identify categories such as `limit` plus
`out_of_range`, never the rejected value or an unknown/private field name. The
SDK exposes the pair as `searchField` and `searchReason`; both are `null` when
the response omits either category or sends an unknown value.

```js
try {
  await client.searchContractV2(request);
} catch (error) {
  if (error instanceof SendFromChinaError && error.code === "INVALID_SEARCH_CONTRACT") {
    console.error(error.searchField, error.searchReason);
  }
}
```

## Development

```bash
cd sdk
npm test
```

The package has no runtime dependencies, includes TypeScript declarations, and supports Node.js 22+ and modern
Worker runtimes with `fetch`, `URL`, `Headers`, and `AbortController`.
