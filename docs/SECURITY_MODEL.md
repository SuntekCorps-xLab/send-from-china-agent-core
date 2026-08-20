# Security Model

## Protected Assets

The reference project is designed not to possess customer data, credentials,
payments, orders, or private catalog records. Its only bundled records are
synthetic products marked as non-purchasable.

## Trust Boundaries

- Network input is untrusted.
- Browser origins are allowed only when explicitly configured.
- MCP callers receive the same synthetic data as HTTP callers.
- Build artifacts and pull request attachments are untrusted until scanned.

## Controls

- Read-only route and tool allowlists.
- Maximum 32 KiB JSON body and bounded query, message, cursor, and page inputs.
- Explicit CORS origins with no wildcard fallback.
- Generic error codes that do not echo request bodies or stack traces.
- `no-store`, `nosniff`, frame denial, and restrictive content security policy.
- Synthetic data labels and `purchasable=false` on every product.
- CI secret, private-host, local-path, and private-integration scans.
- Dependency lockfile and automated dependency-update checks.

## Out of Scope

Authentication is intentionally absent because every public endpoint is
read-only and returns the same synthetic data. Authentication becomes mandatory
before adding private data, account state, writes, or tenant-specific behavior.

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
