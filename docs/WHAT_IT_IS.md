# What Agent Core is—and is not

## What it is

Send From China Agent Core is a guarded catalog interface for commerce agents.
It provides one Search Contract across HTTP, MCP, and the JavaScript SDK, with a
positive public-field allowlist and explicit separation between public reads
and protected operations.

The managed endpoint at `https://wp-api.sendfromchina.ai/mcp` currently allows
five anonymous, read-only catalog tools:

- `product_search`
- `search_catalog`
- `browse_catalog`
- `ask_catalog`
- `get_product`

Results can contain a verified HTTPS link to the corresponding public Shopify
product page. Price, publication, and availability are point-in-time facts and
must be read again before presenting them as current.

The repository also provides a zero-account local synthetic sandbox and a
self-hostable reference Worker. Those profiles are separate from the managed
catalog and can require an operator-issued tenant credential for every product
request or MCP `tools/call`.

## What it is not

Agent Core is not a checkout, order, payment, refund, inventory-write, product-
write, publication, carrier-rate, landed-cost, or compliance service. The
managed public catalog does not grant account, quote, sourcing, request, or
write authority.

A product-page link proves only that the response passed the public catalog
policy at that moment. It does not prove that a checkout completed, that an
order belongs to a particular integration partner, or that the integration
produced revenue or margin. Durable per-partner attribution and store-side order
capture require a separately reviewed contract and are not part of version
1.2.0.

The sourcing lifecycle in this repository is an illustrative, non-purchasable
fixture. It is not a supplier commitment, live sourcing job, or production
transaction.

## Choose the right first step

1. Use the managed MCP endpoint when you need anonymous live catalog discovery.
2. Use `npm run sandbox` when you need a zero-account, deterministic fixture.
3. Self-host only when you own the catalog, credential service, and deployment
   controls.

Never paste a production token into a prompt, issue, browser bundle, or source
file. See [Security model](SECURITY_MODEL.md) for the enforced trust boundaries.
