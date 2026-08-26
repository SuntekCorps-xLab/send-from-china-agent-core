# Local Sandbox

The Agent Core sandbox provides a zero-account first call against the real HTTP
and MCP Worker code. It uses only the checked-in synthetic snapshot and never
connects to a catalog system, supplier, carrier, storefront, cart, order, or
payment service.

## Run it

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm run sandbox
```

Open `http://127.0.0.1:8787/sandbox`.

That is the single entry point for the local experience. It includes executable
HTTP and MCP recipes, response inspection, copyable local calls, and a
confirmation-gated illustrative sourcing flow.

## What the local wrapper does

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

Before a browser-safe JSON response leaves the wrapper, it receives a
conservative sandbox projection. Products use `availability_band: demo_only`,
`purchasable: false`, `available: false`, and `illustrative_only: true`.
Catalog estimates use `availability: demo_only` with the same negative flags
and remain non-binding. Image, product, cart, checkout, order, payment,
purchase, and supplier URLs are removed. Canonical responses are not changed.

For MCP tool results, the projection is applied to `structuredContent` and the
text content is regenerated from that exact object. The JSON-RPC envelope and
MCP content shape remain valid and consistent.

## Browser-safe routes

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

There is no browser-safe catalog enumeration, arbitrary proxy, publisher,
product write, carrier rate, cart, checkout, order, or payment route. Invalid
wrapper paths fail closed before the Worker is called.

The canonical `/.well-known`, `/health`, `/api/*`, and `/mcp` routes are also
served by the same local process without sandbox credential injection. Their
normal authentication behavior is unchanged.

Sandbox capability discovery advertises `/sandbox/mcp` with
`local_server_injected_ephemeral_scope`. MCP `initialize` repeats that boundary
and explains that the client supplies no tenant credential. Both responses also
state that a canonical deployment uses `/mcp` with a bearer tenant key, so an
automatic client does not accidentally switch from sandbox to canonical auth.

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

## Three access states

| State | Identity | Data | Intended use | Writes |
| --- | --- | --- | --- | --- |
| Local zero-account demo | Process-only ephemeral tenant | Checked-in synthetic fixture | Learn, inspect, and test the contract | None |
| Hosted self-service sandbox | Individual, short-lived, revocable credential | Isolated sandbox data and quotas | External integration testing | Only separately designed sandbox scopes |
| Reviewed production | Operator-provisioned tenant and policy | Authorized deployment snapshot | Production read integration | Not included in this repository |

Only the first state is implemented here. A hosted self-service sandbox is a
separate product capability and must add identity verification, short-lived
credentials, tenant isolation, rotation and revocation, quotas, rate limits,
usage logs, abuse controls, and budget limits. A shared public production key is
not an acceptable substitute.

## Security properties

- The server binds to a loopback address and rejects non-loopback hosts through
  `startSandbox()`. The lower-level `createSandboxServer()` factory also guards
  its `listen()` method, including calls that omit a host.
- Static assets use no external scripts, fonts, images, or analytics.
- The wrapper never calls a network client; it invokes `worker.fetch()` directly.
- Product responses still pass through the positive public-field allowlist.
- The synthetic tenant cannot enumerate the complete catalog.
- MCP JSON-RPC envelopes remain valid. Tool `structuredContent` and its text
  representation receive the same conservative projection, while `initialize`
  carries explicit sandbox and canonical-auth metadata.
- Sourcing requires a terminal confirmed search proof and explicit user action.
  Its in-memory results remain non-billable, non-purchasable, and illustrative.

Run `npm run test:sandbox` for the focused boundary suite or `npm run verify`
for the complete repository verification.
