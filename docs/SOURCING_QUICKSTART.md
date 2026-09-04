# Synthetic Sourcing Quick Start

This walkthrough lets an external agent exercise the fixture sourcing contract
without touching a supplier, private catalog, cart, checkout, order, or
payment. Every task and result is non-billable, non-purchasable, and stored only
in one Worker isolate's memory.

## 1. Configure the local boundary

Copy `governance-worker/.dev.vars.example` to an ignored `.dev.vars` file and
replace the local test key before sharing the deployment:

```text
TENANT_KEYS={"<random-key>":{"tenant_id":"tenant_alpha","max_page_size":5,"daily_quota":100}}
```

Start the service from `governance-worker` with `npm run dev`. Keep the key in
the client's controlled environment; never paste it into an issue, log, URL,
screenshot, or committed file.

## 2. Discover and verify access

Call MCP `tools/list` without a credential, then call `get_agent_access` with
the bearer credential.
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

This proof flow is MCP-only. HTTP `POST /api/search/v2` and the SDK
`searchContractV2()` method do not return `search_id`; they cannot be used to
start `create_sourcing_task`. SDK callers must use
`productSearch({ operation: "confirm_search" })` for this step.

Only proceed when the server returns `status=no_match`,
`search_scope_exhausted=true`, `dynamic_request_recommended=true`, and a
non-empty `search_id`. The `search_id` is a short-lived, tenant-bound proof from
`operation=confirm_search`. In this reference it expires after 15 minutes and
is held only in the current Worker isolate; restart, deployment, or isolate
replacement invalidates it. A client must not turn an incomplete search or its
own judgment into a sourcing write.

## 4. Create one idempotent preview

After explicit user confirmation, call `create_sourcing_task` once with the
same query and criteria, the returned `search_id`, `confirmed=true`,
`plan_id=preview`, and a stable request key:

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
  "search_id": "search_demo_<terminal-search-id>",
  "confirmed": true,
  "plan_id": "preview",
  "idempotency_key": "demo-request:walnut-organizer:001"
}
```

Repeat the identical call to verify it returns the same `task.id` with
`idempotent=true`. Reusing the key with changed input must fail with
`IDEMPOTENCY_CONFLICT`. A search proof can create only one task; using a
different idempotency key must not duplicate the confirmed request.

Criteria objects are normalized before comparison, so JSON object key order is
not significant. Values and list order remain significant. A proof mismatch
returns only the stable `SEARCH_PROOF_MISMATCH` code; it does not reflect a
field name or rejected value.

## 5. Read status and results

Call `get_sourcing_task` with the returned ID, then page through
`list_sourcing_results`. The demo synchronously reports the lifecycle
`QUEUED -> SOURCING -> GOVERNING -> RESULTS_READY` and returns up to three
fixtures. Every result must remain `available=false`, `purchasable=false`, with
no product or add-to-cart URL. `match_status=illustrative_only` and
`criteria_satisfied=false` make clear that the fixture cards are UI test data,
not candidates that satisfy the request.

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
