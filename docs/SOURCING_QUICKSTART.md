# Synthetic Sourcing Quick Start

This walkthrough lets an external agent exercise the sourcing contract without
touching a supplier, production catalog, cart, checkout, order, or payment.
Every task and result is synthetic, non-billable, non-purchasable, and stored
only in one Worker isolate's memory.

## 1. Configure the local boundary

Create an ignored `governance-worker/.dev.vars` file containing a random value
of at least 16 characters:

```text
DEMO_AGENT_TOKEN=replace-with-a-locally-generated-random-value
```

Start the service from `governance-worker` with `npm run dev`. Keep the same
value in the client's process as `DEMO_AGENT_TOKEN`; never paste it into an
issue, log, URL, screenshot, or committed file.

## 2. Discover and verify access

Call MCP `tools/list`, then call `get_agent_access` with the bearer credential.
The response must include:

- `catalog:read`, `sourcing:read`, and `sourcing:write` scopes;
- non-billable preview access;
- `cart=false`, `checkout=false`, `order=false`, and `payment=false`.

## 3. Search before sourcing

Call `product_search` with a bounded, structured request:

```json
{
  "query": "a walnut desk organizer with cable management",
  "criteria": {
    "category": "office storage",
    "materials": ["walnut"],
    "must_have": ["cable management"],
    "price_max": 40,
    "ship_to": "US"
  },
  "operation": "confirm_search"
}
```

Only proceed when the server returns `status=no_match`,
`search_scope_exhausted=true`, and `dynamic_request_recommended=true`. A client
must not turn an incomplete search or its own judgment into a sourcing write.

## 4. Create one idempotent preview

After user confirmation, call `create_sourcing_task` once with the same query
and criteria, `plan_id=preview`, and a stable request key:

```json
{
  "query": "a walnut desk organizer with cable management",
  "criteria": {
    "category": "office storage",
    "materials": ["walnut"],
    "must_have": ["cable management"],
    "price_max": 40,
    "ship_to": "US"
  },
  "plan_id": "preview",
  "idempotency_key": "demo-request:walnut-organizer:001"
}
```

Repeat the identical call to verify it returns the same `task.id` with
`idempotent=true`. Reusing the key with changed input must fail with
`IDEMPOTENCY_CONFLICT`.

## 5. Read status and results

Call `get_sourcing_task` with the returned ID, then page through
`list_sourcing_results`. The demo synchronously reports the lifecycle
`QUEUED -> SOURCING -> GOVERNING -> RESULTS_READY` and returns three reviewed
fixtures. Every result must remain `available=false`, `purchasable=false`, with
no product or add-to-cart URL.

This immediate status history is a client-contract fixture, not proof of a real
asynchronous sourcing workflow. Deployments and isolate changes clear all
tasks, quotas, and idempotency records.

## External-agent instruction

An evaluator can use the following instruction after its controlled profile has
injected the base URL and bearer credential:

> Discover the MCP tools first. Verify agent access and confirm that all four
> transactional permissions are false. Search the catalog with the structured
> walnut organizer request above. Create a preview task only after a terminal
> no-match and only after explicit confirmation. Re-submit the identical request
> once to verify idempotency, read the task, page through all results, and report
> the status history and non-purchasable boundaries. Do not call or simulate a
> cart, checkout, order, payment, paid plan, product publication, or merchant
> write. Never print the credential.
