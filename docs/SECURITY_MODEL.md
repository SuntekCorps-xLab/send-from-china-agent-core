# Security Model

## Protected Assets

The reference project is designed not to possess customer data, payments,
orders, or private catalog records. Its only bundled records are synthetic
products marked as non-purchasable. The optional local sourcing credential is
deployment configuration and must never be committed.

## Trust Boundaries

- Network input is untrusted.
- Browser origins are allowed only when explicitly configured.
- Catalog MCP callers receive the same synthetic data as HTTP callers.
- Sourcing MCP calls cross an authorization boundary and create only ephemeral
  synthetic task state owned by the authenticated demo agent.
- Build artifacts and pull request attachments are untrusted until scanned.

## Controls

- Explicit route and tool allowlists with no commerce mutation tool.
- Maximum 32 KiB JSON body and bounded query, message, cursor, and page inputs.
- Explicit CORS origins with no wildcard fallback.
- Generic error codes that do not echo request bodies or stack traces.
- `no-store`, `nosniff`, frame denial, and restrictive content security policy.
- Synthetic data labels and `purchasable=false` on every product.
- Bearer authorization, explicit scopes, preview-only plan validation,
  idempotency conflict detection, task ownership checks, and a small UTC quota
  for synthetic sourcing.
- CI secret, private-host, local-path, and private-integration scans.
- Dependency lockfile and automated dependency-update checks.

## Out of Scope

Catalog endpoints intentionally remain public because they return the same
synthetic data. Sourcing endpoints require `DEMO_AGENT_TOKEN`; the token guards
only an in-memory contract simulation and is not a production identity system.

The module-level task, quota, and idempotency maps are per-isolate and
non-durable. A production implementation must replace them with tenant-bound
durable storage, cryptographic identity, audited authorization, durable
idempotency, replay protection, rate limiting, retention, and deletion.

A production catalog must add authorization, durable idempotency, audit logs,
retention and deletion policies, abuse controls, and an incident-response owner.
Model calls require a separate privacy and prompt-injection review.

## Security Verification

```bash
cd governance-worker
npm ci
npm run verify
npm audit --audit-level=high
cd ..
node scripts/scan-public.mjs .
```
