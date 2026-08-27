# MCP: guarded product search

Configure a Streamable HTTP MCP client with the local, browser-safe endpoint:

```json
{
  "mcpServers": {
    "send-from-china-sandbox": {
      "url": "http://127.0.0.1:8787/sandbox/mcp"
    }
  }
}
```

Or inspect the exact JSON-RPC call with curl:

```bash
curl -sS http://127.0.0.1:8787/sandbox/mcp \
  -H "Content-Type: application/json" \
  --data-binary @recipes/mcp/product-search.json
```

The local wrapper injects an ephemeral synthetic scope. A canonical `/mcp`
deployment requires a bearer tenant credential for every `tools/call`.
