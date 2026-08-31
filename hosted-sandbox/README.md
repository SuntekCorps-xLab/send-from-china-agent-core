# Hosted Shopify read-only sandbox

This is an independent Cloudflare Worker subproject for the invite-only hosted
catalog preview. It does not change the Governance Worker's zero-egress
runtime. The browser and BFF share one HTTPS origin, while the Shopify
Storefront credential remains in the Worker environment.

## Exact public surface

Only these protected API routes exist:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/sandbox/status` | Verify Shopify readiness and the closed capability boundary |
| `POST` | `/sandbox/api/search/v2` | Search published Storefront products with Search Contract v2 |
| `GET` | `/sandbox/api/products/:handle` | Read one published Storefront product |

The static asset allowlist is exactly `index.html`, `app.js`, and `styles.css`.
Worker source, tests, configuration, and repository files cannot be requested
as assets. Cart, checkout, order, payment, inventory, publication, product
mutation, quote, chat, MCP, arbitrary GraphQL, and proxy routes do not exist.

## Access, rate limit, and secret boundary

Production configuration is fail closed:

- `workers_dev` and preview URLs are disabled, so an operator must attach a
  deliberately protected custom route.
- `SANDBOX_ACCESS_MODE` is fixed to `protected`.
- API requests require `X-Sandbox-Invite`; the Worker compares its SHA-256
  digest with the secret `SANDBOX_INVITE_SHA256`.
- The browser holds the invite only in JavaScript memory. It is not written to
  Cookie, local storage, session storage, IndexedDB, or a service worker.
- The Cloudflare `SANDBOX_RATE_LIMITER` binding is required. A missing, invalid,
  denied, or failing binding rejects the request before Shopify is contacted.
- Shopify requests use only the three fixed queries in
  `src/shopify-provider.js`, API version `2026-07`, and one validated
  `<store>.myshopify.com` endpoint.

Set these values with the deployment platform's secret/configuration controls;
do not place them in this repository or a shell history:

```text
SHOPIFY_STORE_DOMAIN
SHOPIFY_STOREFRONT_ACCESS_TOKEN
SANDBOX_INVITE_SHA256
```

The invite digest is the lowercase hexadecimal SHA-256 of a randomly generated
preview invite. Distribute the original invite through the approved private
channel and rotate or revoke it after the preview cohort ends.

## Offline verification

Use Node.js 22:

```bash
npm --prefix hosted-sandbox ci --offline --ignore-scripts --no-audit --no-fund
npm --prefix hosted-sandbox run verify
npm --prefix governance-worker ci
node governance-worker/node_modules/wrangler/bin/wrangler.js deploy \
  --dry-run --config hosted-sandbox/wrangler.toml \
  --outdir hosted-sandbox/.wrangler/hosted-dry-run
```

The tests inject a fixture fetch implementation. They make no external request,
use no credential, and perform no deployment. A real Shopify smoke remains a
separate, explicitly authorized release step.

## Deployment gate

Do not deploy until an independent reviewer confirms the exact commit, dry-run
bundle, asset manifest, secret scan, route allowlist, rate-limit binding, custom
route protection, development-store identity, and read-only smoke receipt.
Deployment must stop if any binding or secret is missing. There is no synthetic
fallback in the hosted Shopify mode.
