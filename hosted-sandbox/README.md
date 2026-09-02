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
  --dry-run --env="" --config hosted-sandbox/wrangler.toml \
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

## Temporary staging only

The only authorized hosted target is the isolated
`send-from-china-hosted-shopify-sandbox-staging` environment. It may use its
temporary `workers.dev` endpoint for an invite-only review cohort. The default
configuration remains disabled on `workers.dev`, has no route or custom domain,
and is not an authorized production deployment target.

Use only a dedicated Shopify development store. Never connect this candidate to
an operating merchant store, production catalog, customer account, order, or
payment environment. Staging remains catalog-read-only and invite-protected.

From the repository root, enter each secret through Wrangler's interactive
prompt. The commands reference secret names only; never place their values in a
command, file, log, issue, or CI variable:

```powershell
node governance-worker/node_modules/wrangler/bin/wrangler.js secret put SHOPIFY_STORE_DOMAIN --env staging --config hosted-sandbox/wrangler.toml
node governance-worker/node_modules/wrangler/bin/wrangler.js secret put SHOPIFY_STOREFRONT_ACCESS_TOKEN --env staging --config hosted-sandbox/wrangler.toml
node governance-worker/node_modules/wrangler/bin/wrangler.js secret put SANDBOX_INVITE_SHA256 --env staging --config hosted-sandbox/wrangler.toml
```

After independent review of the exact commit and development-store identity,
the explicitly authorized staging-only deployment command is:

```powershell
node governance-worker/node_modules/wrangler/bin/wrangler.js deploy --env staging --config hosted-sandbox/wrangler.toml
```

Do not remove `--env staging`. Do not add a default or production deploy script,
route, custom domain, preview URL, or production secret. Do not record the
resulting staging URL in this repository.


See [Hosted Sandbox browser QA](BROWSER_QA.md) for the offline three-browser,
two-viewport runner, screenshot instrumentation scope, and verified results.
