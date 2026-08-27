# Copyable recipes

These recipes exercise the real Agent Core HTTP or MCP handlers through the
loopback-only synthetic sandbox. Start it first:

```bash
npm ci
npm run sandbox
```

Then choose one path:

| Recipe | Runtime | First result |
| --- | --- | --- |
| [curl](curl/README.md) | curl | Search Contract v2 JSON |
| [MCP](mcp/README.md) | Any Streamable HTTP MCP client, or curl | `product_search` structured content |
| [JavaScript](javascript/README.md) | Node.js 22+ | Normalized Search Contract v2 results |
| [Python](python/README.md) | Python 3.10+ standard library | Bounded catalog search results |

All examples use checked-in synthetic data. They return no live price,
inventory, shipping rate, supplier, checkout, order, or payment state and make
no external network call. Canonical deployments use `/api/*` and `/mcp` and
require a deployment-issued tenant credential.
