# Search Contract v2 integration guide

Search Contract v2 is a product-first, transport-neutral request and response
contract for external agents. It separates the product that must be retrieved
from explicit product filters, soft ranking context, and transaction context.
This prevents a recipient, room, occasion, or inferred preference from
silently becoming a catalog exclusion.

The normative JSON Schemas are:

- [`search-v2-request.schema.json`](../contracts/search-v2-request.schema.json)
- [`search-v2-response.schema.json`](../contracts/search-v2-response.schema.json)

## Request model

Every normalized request contains four independent intent groups:

| Group | Retrieval behavior |
| --- | --- |
| `product_identity` | The product or product family responsible for recall. |
| `hard_constraints` | Explicit buyer requirements that may exclude a product. |
| `soft_context` | Recipient, room, occasion, hobby, and similar ranking context. |
| `transaction_context` | Destination, quantity, and delivery context kept separate from product identity. |

Every condition records `source=explicit|inferred|default`,
`scope=product|session|transaction`, and
`hardness=hard|soft|informational`. Only an explicitly supplied condition may
remain in `hard_constraints`. The SDK deterministically demotes inferred or
default hard conditions into soft or informational context.

```json
{
  "contract_version": "2.0",
  "product_identity": {
    "name": "product_identity",
    "value": "compact desk",
    "source": "explicit",
    "scope": "product",
    "hardness": "hard"
  },
  "hard_constraints": [
    {
      "name": "material",
      "value": "bamboo",
      "source": "explicit",
      "scope": "product",
      "hardness": "hard"
    }
  ],
  "soft_context": [
    {
      "name": "recipient",
      "value": "friend",
      "source": "explicit",
      "scope": "session",
      "hardness": "soft"
    }
  ],
  "transaction_context": [
    {
      "name": "ship_to",
      "value": "US",
      "source": "explicit",
      "scope": "transaction",
      "hardness": "hard"
    }
  ],
  "limit": 20,
  "cursor": null
}
```

The default limit is 20 and the contract maximum is 50. A cursor belongs only
to the exact normalized intent that produced it.

The wire endpoint is intentionally strict: `POST /api/search/v2` accepts only
the complete normalized schema above and rejects shorthand, missing groups,
and unknown fields. The SDK method `searchContractV2()` is the compatibility
boundary for ergonomic input such as a string `product_identity`; it
normalizes that input before sending the strict wire request. Call
`parseSearchContractV2Request()` when validating an already-normalized wire
object, and `normalizeSearchContractV2Request()` when building one.

## Response states

The only v2 states are:

- `results`: one or more eligible products are returned;
- `needs_clarification`: a required piece of buyer input is missing;
- `no_match`: the complete configured retrieval plan finished without a match;
- `degraded`: the service could not prove a complete result, for example when
  an index or bounded fallback is unavailable.

`no_match` is a terminal proof, not a synonym for an empty page. It is valid
only when `search_scope.plan_complete=true`,
`search_scope.scope_exhausted=true`, `scan_limit_reached=false`, and
`degraded=false`. A bounded scan or unavailable index must return `degraded`
instead.

Every response also contains:

- `contract_version` and a request-safe `trace_id`;
- the four-part `normalized_intent`;
- explicit `relaxations` and `missing_criteria`;
- cursor pagination;
- `search_scope`, including global-catalog and scan-limit truth.

`global_catalog_exhaustive=true` means the complete deployment catalog, not
merely a tenant-restricted subset, was exhausted. A terminal miss within an
authorized subset may still be a truthful `no_match`, but it must keep
`global_catalog_exhaustive=false`. `has_more=true` always includes a non-empty
`next_cursor`, and that cursor is rejected if reused with another normalized
intent.

## Dependency-free SDK

The SDK exports normalization, v1 compatibility, and client helpers:

```js
import {
  createSendFromChinaClient,
  normalizeSearchContractV2Request,
} from "@send-from-china/agent-sdk";

const request = normalizeSearchContractV2Request({
  product_identity: "compact desk",
  hard_constraints: [],
  soft_context: [
    {
      name: "room",
      value: "small apartment",
      source: "explicit",
      scope: "session",
      hardness: "soft",
    },
  ],
  transaction_context: [],
  limit: 20,
});

const client = createSendFromChinaClient({
  baseUrl: process.env.SEND_FROM_CHINA_BASE_URL,
  token: process.env.SEND_FROM_CHINA_AGENT_TOKEN,
});

const response = await client.searchContractV2(request);
```

The SDK has no runtime dependency. TypeScript consumers receive declarations
from `sdk/src/index.d.ts`; the contract types are generated from the JSON
Schemas. Run `npm run types:generate` after a schema change and
`npm run types:check` in review or CI.

### Deterministic Shopify hard constraints

Shopify catalog checks support numeric `price_min` and `price_max`, public
`material`, `color`, and exact `model` attributes, and literal `must_have` and
`exclude` phrases. Arrays and separate conditions are conjunctive. Model values
match complete published model names or list entries; `PB-100` does not match
`PB-1000` or `PB-100 Pro`. The v1 adapter preserves the additive `model` condition
as an explicit relaxation when its backend cannot evaluate it.

Prices are the Storefront minimum variant price in the returned currency, not
shipping, tax, currency conversion, or a quote for a selected variant. Independent
product option lists do not prove a selectable variant combination or the price
of that combination. Such requests are degraded when multiple option choices
prevent verification. Material, color, and model checks require their respective
public attributes; marketing text alone does not establish those attributes.

Text checks use complete literal token phrases from public title, description,
category, tags, and allowlisted attributes. Simple English `no`, `not`, `without`,
`non-`, and `-free` negations are handled deterministically; Boolean operators,
ambiguous double negatives, semantic claims, and other unsupported syntax are not
inferred. A missing field or unexecutable condition appears in `relaxations`.
Unverified candidates are omitted for missing data, and the search is explicitly
`degraded` even on the last upstream page. An explicit degraded v1 response also
remains degraded through SDK adaptation; it cannot become terminal `no_match`.

## v1 compatibility adapter

The reference Worker exposes authenticated `POST /api/search/v2` and also keeps
its stable `product_search` v1 tool. For v1-only compatible deployments, call
`client.searchContractV2ViaV1()` or use the SDK's explicit
`product_search_v1` compatibility adapter. The adapter:

1. uses only `product_identity` as the v1 retrieval query;
2. maps supported explicit hard constraints to v1 criteria;
3. keeps `ship_to` as v1 informational transaction context;
4. records unsupported hard, soft, or transaction conditions as
   `relaxations` instead of silently enforcing them;
5. upgrades a v1 empty response to v2 `no_match` only when the v1 response
   proves a complete, non-truncated search scope;
6. rebuilds result objects from a public product-field allowlist and recursively
   removes nested source, supplier, cost, credential, and private metadata.

Applications that need to inspect or replace this boundary may import
`createSearchContractV1Adapter()`, `adaptSearchContractV2RequestToV1()`, and
`adaptSearchContractV1ResponseToV2()` directly.

The adapter does not change the reference Worker's search rules and performs no
network request of its own.

## Versioning policy

The search contract and SDK follow Semantic Versioning independently:

- `contract_version="2.0"` identifies the request and response shape;
- adding optional conditions or response metadata is backward-compatible;
- changing status meaning, required fields, or condition semantics requires a
  new contract major version;
- SDK `1.2.0` retains the v2 helpers without removing the v1 `productSearch()` method;
- removal of the v1 adapter or `productSearch()` would require SDK `2.0.0`.

Callers should branch on `contract_version`, not on the SDK package version.
The v1 adapter will remain covered by contract tests throughout the SDK 1.x
line.

## Conformance checklist

A compatible implementation must:

- keep inferred and default context out of hard filters;
- keep transaction context when the buyer changes product identity;
- return the same state and candidate truth for the same normalized intent
  across every public search entry point;
- never report `no_match` for a degraded or incomplete retrieval plan;
- return no more than 50 public, deduplicated products;
- exclude private source, cost, credential, and supplier data;
- avoid sourcing, cart, checkout, order, payment, or publication side effects
  during search.
