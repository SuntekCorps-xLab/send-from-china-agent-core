# MCP: guarded product search

Configure a Streamable HTTP MCP client with the local, browser-safe endpoint.
Clients such as Claude Code require the explicit transport type:

```json
{
  "mcpServers": {
    "send-from-china-sandbox": {
      "type": "http",
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

The JSON shape and configuration path vary by client. Claude Desktop requires
the included stdio bridge rather than this HTTP entry. Follow the
[client-specific setup and troubleshooting guide](../../docs/SANDBOX.md#connect-an-mcp-client).

The local wrapper injects an ephemeral synthetic scope. A canonical `/mcp`
deployment requires a bearer tenant credential for every `tools/call`.
