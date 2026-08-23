# Security Model

## Protected assets

The gateway is designed to possess only a public product snapshot and
deployment-injected tenant credentials. It does not require customer records,
orders, payments, supplier records, private product identifiers, or private
system credentials.

## Non-negotiable invariants

| Invariant | Enforcement | Verification |
| --- | --- | --- |
| Worker code contains no private system address, connection string, credential, or account | Repository safety scan and review boundary | `scripts/scan-public.mjs` |
| Worker runtime makes no outbound network request | Source scan scoped to Worker runtime and a fetch-blocking integration test | `test/no-egress.test.js` |
| Product output uses a positive field allowlist | `toPublicProduct` reconstructs every response | `test/field-policy.test.js` |

## Trust boundaries

- All network input is untrusted.
- Browser origins are allowed only when configured.
- Health and MCP discovery disclose capability metadata but no product data.
- HTTP product data and MCP tool calls require a tenant credential.
- Tenant product identifiers are intersected with the published snapshot.
- Restricted tenants cannot enumerate the full catalog.
- A product outside a tenant scope returns the same not-found behavior as an
  unknown product.
- The private publisher is outside the runtime boundary; only its public
  snapshot artifact crosses into this project.

## Controls

- Constant-time credential comparison.
- Positive product field allowlist with atomic snapshot rejection.
- Opaque public identifiers with no public mapping implementation.
- Maximum request body, query, cursor, and tenant-specific page sizes.
- Search result truncation and a reference daily quota with `Retry-After`.
- Generic error codes that do not echo input, dropped fields, or stack traces.
- `no-store`, `nosniff`, frame denial, and restrictive content security policy.
- Non-binding quotes that expire after 15 minutes and reject stale snapshots.
- No cart, checkout, order, payment, refund, product-write, or publication tool.
- Lockfile, pinned CI actions, dependency audit, and repository safety scan.

## Phase 1 limitations

`TENANT_KEYS` is deployment JSON and the quota counter is per isolate. Replace
both with audited durable services before a multi-instance production rollout.
The checked-in snapshot is a synthetic fixture. A real publisher must validate
catalog ownership, media rights, customer-visible pricing, availability, and
retention before producing a snapshot.

The optional sourcing preview is fixture state and disappears on restart. It
cannot represent a supplier commitment or business transaction.

## Verification

```bash
cd governance-worker
npm ci
npm run verify
npm audit --audit-level=high
cd ..
node scripts/scan-public.mjs .
```

Additional coverage:

- `test/snapshot.test.js`: atomic validation and stale metadata.
- `test/tenant.test.js`: authentication and cross-tenant isolation.
- `test/enumeration.test.js`: page limits, quota, and enumeration denial.
- `test/quote.test.js`: non-binding quote and tenant-bound price access.
- `test/no-egress.test.js`: every HTTP route and MCP tool with outbound fetch disabled.
