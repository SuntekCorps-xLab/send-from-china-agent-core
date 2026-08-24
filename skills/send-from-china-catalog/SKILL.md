---
name: send-from-china-catalog
description: Use a configured Send From China Agent Core MCP server for governed catalog discovery, product details, catalog estimates, and explicitly confirmed illustrative sourcing previews. Do not use it for carrier rates, purchasing, orders, or payments.
---

# Send From China Catalog

Use the configured Send From China MCP server as a catalog-first, non-transactional commerce source.

Before acting, call `get_agent_access` and respect its scopes and transactional permissions. Treat `get_quote` as a non-binding catalog estimate: it excludes shipping and tax and is not a carrier rate.

For product discovery, call `product_search` with the user's structured criteria. Returned products satisfy every criterion listed under `criteria_evaluation.enforced`; `ship_to` is informational unless the deployed catalog adds a destination policy.

Only offer the illustrative sourcing preview when `confirm_search` returns all of the following:

- `status=no_match`;
- `search_scope_exhausted=true`;
- `dynamic_request_recommended=true`;
- a non-empty `search_id`.

Obtain explicit user confirmation immediately before `create_sourcing_task`. Reuse the exact query and criteria, pass that `search_id`, set `confirmed=true` and `plan_id=preview`, and use a stable idempotency key. Never describe preview results as matched, available, purchasable, reserved, or supplier-confirmed.

Read [references/contracts.md](references/contracts.md) when composing tool arguments or interpreting response boundaries.
