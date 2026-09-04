---
name: send-from-china-catalog
description: Search the live public Send From China catalog or an operator-configured Agent Core catalog through MCP, then inspect public product details. Use it for governed product discovery and non-binding catalog estimates, not carrier rates, purchasing, orders, or payments.
---

# Send From China Catalog

Use Send From China Agent Core as a catalog-first, non-transactional commerce source.

For the managed live public catalog, connect to `https://wp-api.sendfromchina.ai/mcp`. Call `initialize`, then `tools/list`, before selecting a tool. Public catalog reads (`product_search`, `search_catalog`, `browse_catalog`, `ask_catalog`, and `get_product`) do not require a Bearer credential. Do not call `get_agent_access` before these public reads.

For a local synthetic or self-hosted deployment, use the endpoint and tenant credential supplied by its operator. Those profiles can require authentication for every `tools/call`; never send a production credential to a local or unverified endpoint.

For product discovery, call `product_search` with the user's structured criteria. Returned products satisfy every criterion listed under `criteria_evaluation.enforced`; `ship_to` is informational unless the deployed catalog adds a destination policy.

Use `get_product` on a returned public slug or handle before presenting exact product details. Treat Shopify-backed price, publication, and availability fields in that response as current only at response time.

Account, quote, sourcing, or write-capable operations are protected. Call `get_agent_access` only when the user requests one of those operations, and continue only with a deployment-issued credential and the required scope. Never ask the user to paste a production token into chat, a prompt, or source code. Treat `get_quote` as a non-binding catalog estimate: it excludes shipping and tax and is not a carrier rate.

Only offer the illustrative sourcing preview when `confirm_search` returns all of the following:

- `status=no_match`;
- `search_scope_exhausted=true`;
- `dynamic_request_recommended=true`;
- a non-empty `search_id`.

Obtain explicit user confirmation immediately before `create_sourcing_task`. Reuse the exact query and criteria, pass that `search_id`, set `confirmed=true` and `plan_id=preview`, and use a stable idempotency key. Never describe preview results as matched, available, purchasable, reserved, or supplier-confirmed.

Read [references/contracts.md](references/contracts.md) when composing tool arguments or interpreting response boundaries.
