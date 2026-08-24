# Hosted Platform quickstart

Agent Core is the self-hosted reference contract. A compatible hosted Send
From China deployment can add durable sourcing, governed product publication,
and customer-facing purchase handoffs without moving supplier data or merchant
credentials into the agent.

## 1. Configure the client

Install the package from `sdk/` (or use that workspace package directly while
developing), then keep all configuration in the server environment:

```js
import { createSendFromChinaClient } from "@send-from-china/agent-sdk";

const client = createSendFromChinaClient({
  baseUrl: process.env.SEND_FROM_CHINA_BASE_URL,
  token: process.env.SEND_FROM_CHINA_AGENT_TOKEN,
  commerceOrigins: [process.env.SEND_FROM_CHINA_STOREFRONT_ORIGIN],
});
```

Never embed the token in browser code, prompts, logs, repository files, or
product metadata.

## 2. Negotiate capabilities

Call `getCapabilities()`, `listTools()`, and `getAgentAccess()` at startup.
Do not infer hosted features from a version string. The self-hosted reference
reports non-transactional synthetic previews; hosted deployments may expose
durable sourcing and governed customer product URLs.

## 3. Search the published catalog first

Call `productSearch()` with the buyer's actual constraints. A missing budget is
not a catalog miss. Continue pagination when `has_more` is true. Create a
sourcing task only when the final response explicitly reports a terminal
`no_match`, the search scope is exhausted, and the customer confirms that an
additional search should start.

```js
const search = await client.productSearch({
  query: "soft silicone newborn feeding spoon",
  criteria: { ship_to: "US", must_have: ["soft silicone"] },
  operation: "confirm_search",
  limit: 20,
});

const canSource = search.status === "no_match"
  && search.exhaustive === true
  && search.search_scope_exhausted === true
  && search.search_id;
```

## 4. Start sourcing only after confirmation

After a visible confirmation from the customer, pass the exact query,
criteria, and search proof back with a unique idempotency key. Reuse that key
only for retries of the identical request.

```js
const created = await client.createSourcingTask({
  query: "soft silicone newborn feeding spoon",
  criteria: search.criteria,
  search_id: search.search_id,
  confirmed: true,
  plan_id: "preview",
  idempotency_key: crypto.randomUUID(),
});

const task = await client.waitForSourcingTask(created.task.id, {
  timeoutMs: 10 * 60_000,
  onStatus: ({ status }) => console.log("Sourcing status:", status),
});
const results = task.status === "RESULTS_READY"
  ? await client.listAllSourcingResults(task.id)
  : [];
```

Treat `NO_MATCH` and `FAILED` as final outcomes, not empty product batches.
Keep the task ID so the buyer can resume later instead of creating duplicates.

## 5. Hand purchasing back to the merchant

The SDK never performs payment. For each governed result, call
`resolvePurchaseHandoff()`. It accepts only HTTPS URLs on an explicitly
configured commerce origin. Supplier links and unknown hosts resolve to
`null`.

```js
const handoff = client.resolvePurchaseHandoff(results[0]);
if (handoff) {
  // Show a customer-controlled “View & buy” action.
  console.log(handoff.url);
}
```

The merchant product page remains responsible for variant, inventory,
delivery, tax, cart, and checkout truth at the moment of purchase.

## Self-hosted and hosted boundaries

| Capability | Self-hosted reference | Compatible hosted deployment |
| --- | --- | --- |
| Published catalog search | Included | Included |
| Catalog estimate | Included; excludes shipping and tax | Inspect capability metadata |
| Sourcing | Synthetic, non-purchasable fixture | May be durable and governed |
| Product-pool expansion | File publisher + redeploy | Managed sourcing/publication service |
| Purchase | Not included | Customer-facing merchant handoff only |
| Payment | Never handled by the SDK | Merchant checkout owns payment |

External sellers or curators should not write directly into the public
catalog. A production platform must authenticate contributors, validate
ownership and compliance, deduplicate candidates, review commercial facts,
and publish only the allowlisted customer record after approval.
