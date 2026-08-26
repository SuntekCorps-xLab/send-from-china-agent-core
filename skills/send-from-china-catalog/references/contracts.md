# Agent Core tool contract

## Discovery and authentication

MCP `initialize` and `tools/list` are public. Every `tools/call` requires the tenant Bearer credential configured by the deployment operator. This repository has no self-service registration flow.

Start an authenticated workflow with `get_agent_access`. Stop if the required scope is absent. Cart, checkout, order, and payment permissions are false in the reference server.

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

Use `get_product` for a returned public slug. `criteria_evaluation.enforced` lists hard filters. `criteria_evaluation.informational` lists inputs that were preserved but not evaluated against the snapshot.

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
