<div align="center">

# Send From China Agent Core

**A self-hosted, tenant-scoped catalog gateway for commerce agents.**

[![CI](https://github.com/Peter-Fu-Collab/send-from-china-agent-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Peter-Fu-Collab/send-from-china-agent-core/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-142b2f)](governance-worker/package.json)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-c64b1a)](contracts/openapi.yaml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-6b7c70)](LICENSE)

<img src="docs/images/governed-commerce-hero.png" alt="A published product snapshot passing through governance controls to HTTP and MCP clients" width="100%">

</div>

## What you can build with it

Agent Core turns a pre-published product snapshot into a guarded HTTP and MCP
surface. An application, shopping assistant, or automation can:

- search a catalog without receiving unrestricted enumeration access;
- read tenant-visible product facts through a positive field allowlist;
- request a short-lived, non-binding quote;
- inspect its own scopes and explicit non-transactional permissions;
- run an idempotent fixture sourcing preview after a catalog miss.

The gateway has no connection to a private catalog, supplier system, store,
customer account, payment provider, or order system. It makes no outbound
runtime network request. You supply a validated published snapshot at build
time and tenant credentials at deployment time.

## Five-minute local run

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/Peter-Fu-Collab/send-from-china-agent-core.git
cd send-from-china-agent-core/governance-worker
npm ci
cp .dev.vars.example .dev.vars
npm run verify
npm run dev
```

On Windows PowerShell, replace the copy command with:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

The checked-in key is an obvious local test value. Replace it before sharing a
development deployment. In another terminal, set the same value locally:

```bash
export TENANT_KEY="key_test_alpha_1234567890"
```

PowerShell equivalent:

```powershell
$env:TENANT_KEY = "key_test_alpha_1234567890"
```

Check the public health endpoint:

```bash
curl http://localhost:8787/health
```

Search the five products visible to the sample tenant:

```bash
curl "http://localhost:8787/api/search?q=desk&limit=5" \
  -H "Authorization: Bearer ${TENANT_KEY}"
```

Read one product by public slug:

```bash
curl http://localhost:8787/api/products/modular-desk-organizer \
  -H "Authorization: Bearer ${TENANT_KEY}"
```

Create a non-binding quote:

```bash
curl http://localhost:8787/api/quote \
  -H "Authorization: Bearer ${TENANT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"public_id":"A1b2C3d4E5f6G7h8J9k0Lm","quantity":2,"ship_to":"US"}'
```

Expected quote shape:

```json
{
  "quote_id": "quote_<random-id>",
  "public_id": "A1b2C3d4E5f6G7h8J9k0Lm",
  "unit_price": {"amount": 24.9, "currency": "USD"},
  "quantity": 2,
  "availability": "in_stock",
  "expires_at": "<ISO-8601 timestamp>",
  "binding": false
}
```

## Connect an MCP client

MCP discovery is public so clients can call `initialize` and `tools/list`
before a key is configured. Every `tools/call` requires a tenant credential.

Use this server definition in an MCP client that supports custom headers:

```json
{
  "mcpServers": {
    "commerce-catalog": {
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${TENANT_KEY}"
      }
    }
  }
}
```

Available tools:

| Tool | Purpose |
| --- | --- |
| `product_search` | Criteria-first bounded search with terminal status |
| `search_catalog` | Tenant-scoped catalog search |
| `get_product` | Product detail by public slug |
| `get_quote` | Short-lived, non-binding quote |
| `get_agent_access` | Tenant scope and permissions |
| `create_sourcing_task` | Idempotent fixture preview |
| `get_sourcing_task` | Preview task status |
| `list_sourcing_results` | Paginated non-purchasable preview results |

There are no cart, checkout, order, payment, refund, product-write, or publish
tools in this repository.

## Supply your own published snapshot

The sample snapshot is [fixtures/published-catalog.sample.json](fixtures/published-catalog.sample.json).
Replace it with data that conforms to
[contracts/published-catalog.schema.json](contracts/published-catalog.schema.json),
then rebuild or restart the Worker.

The snapshot contract contains:

- `generated_at` and `valid_until` freshness boundaries;
- public product records accepted by the field allowlist;
- opaque 22-character public product identifiers;
- per-tenant product scopes and price tiers.

Snapshot validation is atomic: one invalid record rejects the whole snapshot.
The gateway never reads a local file or remote service at runtime. A production
publisher should create and deliver the snapshot outside this repository. See
[the identifier contract](publisher/id-mapping.md) and
[architecture](docs/ARCHITECTURE.md).

## Configure tenants

`TENANT_KEYS` is a JSON object injected through `.dev.vars` locally or your
deployment platform's secret store:

```text
TENANT_KEYS={"<random-key>":{"tenant_id":"tenant_alpha","max_page_size":5,"daily_quota":100}}
```

The tenant identifier selects the matching scope in the published snapshot.
Optional deployment fields are `product_ids`, `price_tier`,
`allow_full_enumeration`, `max_page_size`, and `daily_quota`.

Restricted tenants cannot call `GET /api/catalog`. They can use bounded search,
and search stops returning cursors after 200 results. Quota errors return HTTP
429 with `Retry-After`. The in-memory counter is a Phase 1 reference and must be
replaced by durable storage for multi-isolate production use.

## HTTP API

| Method | Path | Credential | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Snapshot freshness and gateway state |
| `GET` | `/api/catalog` | Yes | Full listing only for explicitly allowed tenants |
| `GET` | `/api/search?q=...` | Yes | Bounded tenant-scoped search |
| `GET` | `/api/products/:slug` | Yes | One tenant-visible product |
| `POST` | `/api/quote` | Yes | Short-lived non-binding quote |
| `POST` | `/api/chat` | Yes | Deterministic search conversation example |
| `POST` | `/mcp` | Mixed | Public discovery; authenticated tool calls |

The complete request and error contract is in
[contracts/openapi.yaml](contracts/openapi.yaml).

## Security properties

Three invariants are enforced in code and tests:

1. Worker code contains no private system address or credential.
2. Worker runtime code makes no outbound request.
3. Product responses pass through a positive field allowlist.

Additional controls include constant-time credential comparison, tenant product
isolation, page-size limits, anti-enumeration behavior, daily quotas, generic
errors, restrictive response headers, and a repository safety scan.

Run the full verification suite:

```bash
cd governance-worker
npm run verify
cd ..
node scripts/scan-public.mjs .
```

See [Security model](docs/SECURITY_MODEL.md) for the exact test files behind
each claim.

## Repository map

```text
contracts/            Snapshot schema and OpenAPI contract
fixtures/             Synthetic published snapshot for local use
governance-worker/    HTTP and MCP gateway with tests
publisher/            Public-side publishing rules, never private mappings
etl-pipeline/          File-only product validation examples
docs/                  Architecture, deployment, operations, and security
scripts/               Repository safety scanner
```

## Project boundary

Version `0.3.0-rc.1` is a Phase 1 reference gateway. It is usable for local
integration, contract tests, and adapting a pre-published catalog. It is not a
hosted marketplace and cannot complete a purchase.

Before adding a write-capable system, independently design durable identity,
authorization, idempotency, audit logging, retention, deletion, pricing,
inventory, tax, shipping, returns, and incident response.

## License and support

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Use the
issue templates for reproducible bugs and setup questions.
