# Agent Core hosted sandbox implementation receipt

Date: 2026-09-02
Decision: `OFFLINE_READY_LIVE_BLOCKED`
Scope: one local child commit; no deployment, push, main merge, hosted MCP, or commerce writes.

## Starting identity

- Branch: `session-release/hosted-shopify-sandbox`
- Parent: `c309bb9012607c2989c60bc8f012ef51b302c1cc`
- Parent tree: `7d3394ee6f279c9dba7b24550e883b0f25700fcf`
- Exact identity, clean status, and absence of active Git operations/locks were verified before changes.

## Implemented behavior

Both Shopify providers use fixed Storefront queries for public handle, title,
description, URL, availability, minimum variant price, product type, up to eight
image URL/alt pairs, and bounded product options. Every product passes the
existing positive field policy. Image hosts are limited to the Shopify HTTPS
CDN. Vendor, internal identifiers, metafields, arbitrary nested fields, raw
responses, and reflected credentials are rejected or excluded at the boundary.

Shared deterministic checks enforce price ranges, material, color, exact model,
required terms, and exclusions. Missing evidence, unsupported operands, mixed
currencies, and unproven variant combinations produce explicit relaxations and
remain degraded. Degraded responses cannot become terminal `no_match`, including
through the SDK v1 adapter. The additive model constraint preserves existing v1
behavior by recording a relaxation when that backend cannot enforce it.

The three hosted routes and existing HTTP, MCP, SDK, and local sandbox contracts
remain covered. The hosted UI renders public images, alt text, handles, prices,
and attributes; maintains keyboard focus; clears stale readiness after failed
reads; and distinguishes incomplete searches from terminal no-match outcomes.

## Verification

| Gate | Result |
| --- | --- |
| `npm run verify` | PASS: 301 Node tests and 20 Python tests |
| Required Governance Worker verify | PASS: included in the complete verification |
| Required publisher unittest suite | PASS: 14 tests, also run independently |
| Public repository scan, generated types, local documentation links | PASS |
| Hosted staging Worker dry-run | PASS: exactly three static assets; no deployment |
| Injected doctor plus known-query smoke | PASS: 20/20 cases, 22 injected operations, zero external fetches |
| Hosted browser matrix | PASS: all six browser/viewport pairs |

The browser matrix uses installed Chrome 152.0.7977.65, Firefox 148.0.2, and
WebKit 26.4 with Playwright 1.59.1 and axe-core 4.13.0. Each browser runs at
1440x1000 and 390x844. Each pair audits initial, connected, results, detail,
terminal no-match, degraded, search-failure, and detail-failure states, plus
keyboard access and normal/reduced-motion behavior. All 48 state audits have
zero automated WCAG A/AA violations, horizontal overflow findings, console
warnings/errors, page errors, unapproved requests, or external application
requests. CDN image bytes are fulfilled locally; Shopify calls use injected
fixtures. Existing browser/tool caches were reused without installation or download.

All security, console, accessibility, and functional checks run with the shipped
CSP. Playwright's WebKit screenshot routine injects a stylesheet; WebKit visual
captures therefore use a separate script-free DOM snapshot context with CSP
bypass and verified matching dimensions. Those snapshots are visual evidence
only. The application CSP was not weakened for QA.

## Evidence in ignored local artifact directories

- `build/s1-verification/full-verify-final.log`
- `build/s1-verification/publisher.log`
- `build/s1-verification/hosted-dry-run.log`
- `build/s1-verification/shopify-mock-smoke.json`
- `hosted-sandbox/.wrangler/browser-qa/report.json`
- `hosted-sandbox/.wrangler/browser-qa/`: 48 state screenshots
- `build/s1-verification/receipt.json`: final commit/tree and evidence hashes,
  written after the single local commit

Repository verification used Node 24.14.0 and Python 3.12.10; the browser harness used Node 22.23.2. Synthetic eval and
fixture results are not production, live-store, or real-model acceptance evidence.

## Live-only blockers

1. No dedicated Shopify development-store identity/domain was supplied.
2. No authorized development-store Storefront token or usable secret reference
   was supplied. The actual doctor returned `CREDENTIAL_MISSING` without egress.
3. No development-store manifest containing 20 distinct known queries and
   expected public handles was supplied. The live 20-query smoke is `BLOCKED`;
   fixture success does not satisfy that gate.
4. No protected staging URL/invite serving this exact candidate was supplied.
   The existing shell identified by commit `68e2837` is stale and is not evidence
   for this candidate. This blocks hosted live validation independently of the
   direct development-store doctor/smoke.

The smoke runner is ready for explicit development-store confirmation, the
existing live opt-in, and an operator-selected manifest. Reports expose only
case numbers, counts, and fixed public error codes. No live store was contacted,
no secret was printed, and no preview/release approval is claimed.
