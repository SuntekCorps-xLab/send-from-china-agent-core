# Agent Core tool contract

## Connection profiles

### Managed live public catalog

Use the production MCP endpoint:

```text
https://wp-api.sendfromchina.ai/mcp
```

Call `initialize` and `tools/list` without an Authorization header. The managed service also allows anonymous calls to these public read tools:

- `product_search`
- `search_catalog`
- `browse_catalog`
- `ask_catalog`
- `get_product`

These tools return allowlisted public catalog fields. Never infer access to account data, private fields, sourcing, writes, orders, checkout, or payments from anonymous catalog access.

### Local synthetic and self-hosted deployments

Use the endpoint and tenant Bearer credential supplied by the deployment operator. The runtime in this repository requires that credential for every `tools/call` and has no self-service registration flow. Its bundled catalog is synthetic and is not the live Send From China catalog.

### Protected operations

Account, quote, sourcing, and write-capable operations require a deployment-issued key with the necessary scope. Start such a workflow with `get_agent_access` and stop if the credential or scope is absent. Do not invent a key, request one in chat, or send one to a different endpoint. Cart, checkout, order, and payment permissions are false in the reference server.

## Catalog workflow

New clients should model intent with
[`Search Contract v2`](../../../docs/SEARCH_CONTRACT_V2.md). Keep the product
identity responsible for recall, allow only explicit buyer requirements in
hard constraints, and use recipient, room, occasion, and hobby as soft context.
The SDK's compatibility adapter preserves the v1 tool shown below.

Call `product_search` with:

```json
{
  "query": "compact bamboo desk organizer under 30",
  "criteria": {
    "category": "office",
    "materials": ["bamboo"],
    "price_max": 30,
    "ship_to": "US"
  },
  "operation": "confirm_search"
}
```

Use `get_product` for a returned public slug or handle. `criteria_evaluation.enforced` lists hard filters. `criteria_evaluation.informational` lists inputs that were preserved but not evaluated against the snapshot.

## Catalog estimate

`get_quote` accepts `public_id`, `quantity`, and a two-letter `ship_to` value. A successful response has `quote_kind=catalog_estimate`, `shipping_included=false`, `tax_included=false`, `destination_evaluated=false`, and `binding=false`. Do not call it a landed cost or shipping rate.

## Illustrative sourcing preview

After a terminal confirmed miss and explicit user confirmation, call `create_sourcing_task` with the unchanged query and criteria plus:

```json
{
  "search_id": "<terminal-search-id>",
  "confirmed": true,
  "plan_id": "preview",
  "idempotency_key": "<stable-request-key>"
}
```

The search proof expires, belongs to one tenant, and can create at most one task. Repeat the identical request with the same idempotency key after uncertain delivery. Results with `match_status=illustrative_only` and `criteria_satisfied=false` demonstrate client integration states only.
