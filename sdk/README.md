# Send From China Agent SDK

A dependency-free JavaScript client for the public Agent Core contract and
compatible Send From China hosted deployments.

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

The client deliberately does not include cart, checkout, order, or payment
methods. A hosted deployment may return a customer-facing product, cart, or
checkout URL. Pass the exact storefront origins you trust and use
`client.resolvePurchaseHandoff(product)` before showing that link to a buyer.

Dynamic sourcing must begin only after a terminal catalog miss and explicit
customer confirmation. See the
[Hosted Platform quickstart](../docs/HOSTED_PLATFORM_QUICKSTART.md) for the
complete flow.

## Development

```bash
cd sdk
npm test
```

The package has no runtime dependencies and supports Node.js 22+ and modern
Worker runtimes with `fetch`, `URL`, `Headers`, and `AbortController`.
