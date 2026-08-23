# Architecture

## Scope

Agent Core is a deployable boundary between a user-owned product input and
external HTTP or MCP clients. A local publisher creates the public artifact;
the gateway validates it, resolves a tenant, applies scope and quota controls,
and returns only public allowlisted fields.

```mermaid
flowchart LR
    Input[User-owned JSON or JSONL] --> Publisher[Local file-only publisher]
    IdKey[User-owned identifier key] --> Publisher
    Publisher -->|one-way public snapshot| Artifact[Published snapshot artifact]
    Artifact --> Validator[Atomic snapshot validator]
    Human[HTTP client] --> Gateway[Worker gateway]
    Agent[MCP client] --> Gateway
    KeyStore[Deployment tenant keys] --> Gateway
    Validator --> Gateway
    Gateway --> Policy[Positive field policy]
    Gateway --> Guard[Tenant scope, quota, anti-enumeration]
    Policy --> Catalog[Search and product detail]
    Guard --> Catalog
    Catalog --> Quote[Non-binding quote]
    Gateway -. no runtime connection .-> SourceEnvironment[Source environment]
```

The snapshot arrow is one-way. The public gateway has no credential, route, or
runtime connection back to the publishing environment. The identifier key and
local source identifiers never cross the artifact boundary.

## Build flow

1. The publisher reads a user-selected JSON or JSONL file.
2. A keyed one-way function creates stable opaque product identifiers.
3. Unknown product fields are counted and discarded; malformed public fields
   fail the whole build.
4. Tenant source references are resolved to public identifiers.
5. The snapshot and a data-free verification report are written atomically.
6. The Node snapshot validator rechecks the exact artifact consumed by the
   Worker before bundling.

## Runtime request flow

1. The Worker assigns a request identifier and validates the browser origin.
2. `/health`, MCP `initialize`, and MCP `tools/list` remain public.
3. Data requests resolve a tenant from the deployment-injected key registry
   using constant-time comparison.
4. The tenant's page limit, daily quota, product identifiers, and enumeration
   policy are applied.
5. Catalog functions read the in-memory validated snapshot.
6. Every product is rebuilt through `toPublicProduct`; unknown fields are not
   copied into the response.
7. Browsing responses include snapshot `as_of`. Quote requests fail when the
   active snapshot is stale and otherwise expire after 15 minutes.

## Module boundaries

- `src/field-policy.js`: positive public product field policy.
- `src/snapshot.js`: pure validation and atomic activation of snapshot data.
- `src/tenant.js`: tenant key resolution, scopes, page limits, and reference quota counter.
- `src/catalog.js`: tenant-filtered ranking, pagination, and detail lookup.
- `src/quote.js`: short-lived non-binding quote contract.
- `src/http.js`: request limits, CORS, response headers, and safe errors.
- `src/mcp.js`: public discovery and authenticated tool dispatch.
- `src/sourcing.js`: optional fixture preview lifecycle with no commerce writes.
- `src/index.js`: HTTP routing and error boundaries.

Publisher modules:

- `publisher/build_snapshot.py`: file-only normalization, identifier derivation,
  tenant resolution, and atomic output.
- `scripts/validate-snapshot.mjs`: final contract validation using the same
  snapshot code as the Worker.

## Deliberate limitations

- The sample snapshot is compiled into the Worker. Runtime filesystem access is
  not available and runtime network access is prohibited.
- Tenant keys and quota counters are reference adapters. A multi-isolate
  production deployment needs durable identity and counters.
- Quotes are non-binding and use the current snapshot price. No reservation,
  inventory mutation, or checkout is created.
- The fixture sourcing lifecycle is in-memory, non-billable, and
  non-purchasable.

Source connectors and write-capable commerce systems belong in separate,
independently reviewed repositories. This publisher deliberately accepts files
instead of connecting to a source platform.
