# Hosted Sandbox browser QA

## Offline runner

Run with Node.js 22, existing Playwright Core and axe-core packages, installed
Google Chrome, and existing compatible Firefox/WebKit browser caches:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = '<existing-browser-cache>'
$env:SANDBOX_QA_NODE_MODULES = '<existing-QA-node_modules>'
npm --prefix hosted-sandbox run qa:browser
```

The tooling path defaults to `.wrangler/qa-tooling/node_modules` within this
subproject. The runner never installs packages, downloads browsers, uses live
credentials, or contacts a store. Missing tooling or any missing required
browser produces a failed report with an explicit environment blocker. Chrome
uses Playwright's `chrome` channel, not a substituted Chromium build.

Every page request is intercepted. Static files and the three hosted API routes
execute the real Worker handler. Shopify calls use `TEST_FETCH` with synthetic
catalog fixtures, and the exact fixture CDN image is fulfilled from memory.
Other origins are rejected, and a non-injected Node fetch fails the suite.
Two browser fetch rejections per case exercise search/detail failure handling
without making a request. There are no runtime dependencies.

## Checks and evidence

Each browser runs at 1440x1000 and 390x844. Every case covers initial readiness,
search before authentication, keyboard connection, search, detail, terminal
no-match, degraded results, and injected search/detail failures. Assertions
check image rendering/alt, long titles and handles, price, material/model,
44px detail controls, keyboard focus, readiness invalidation, and truthful
incomplete-result messages. Loading is checked with both motion preferences:
`pulse` normally and `none` with reduced motion.

Automated WCAG 2/2.1 A/AA checks, horizontal overflow checks, console/page errors,
and all functional/security assertions run on the real page with the shipped
CSP. No accessibility rule is disabled and no console error is filtered.

Chrome and Firefox screenshots capture the real page. Playwright 1.59.1 injects
an empty synchronization stylesheet before every WebKit screenshot, conflicting
with the shipped CSP. Only WebKit screenshots use a separate CSP-bypass visual
context containing a script-free copy of the current DOM. Its stylesheet and
image requests are also fulfilled locally; document dimensions must equal the
real page before capture. These snapshots are visual evidence only. WebKit's
functional, accessibility, overflow, console and reduced-motion checks still
use the original page and its unchanged CSP.

The ignored evidence directory is `.wrangler/browser-qa/` in this subproject:

- `report.json` records versions, the six required cases, detailed checks,
  motion values, request counters, findings and screenshot filenames.
- `<browser>-<width>x<height>-<state>.png` captures `initial`, `connected`,
  `results`, `detail`, `no-match`, `degraded`, `search-unavailable`, and
  `detail-unavailable`: 48 screenshots in total.

## Verified result: 2026-09-02

Tooling: Node.js 22.23.2, Playwright Core 1.59.1, axe-core 4.13.0.

| Browser | Version | 1440x1000 | 390x844 |
| --- | --- | --- | --- |
| Google Chrome | 152.0.7977.65 | PASS | PASS |
| Firefox | 148.0.2 | PASS | PASS |
| WebKit | 26.4 | PASS | PASS |

All six cases passed with zero accessibility violations, horizontal overflow,
console warnings/errors, page errors, unapproved browser requests, or external
network requests. Reduced-motion loading assertions passed in all six cases.
The final run completed at `2026-09-02T07:08:55.085Z`: 42 injected Shopify
operations, 12 injected browser failures, and 7 fixture CDN image requests
fulfilled locally. Staging, a dedicated development store and live-query smoke
are separate gates; this report makes no live-readiness claim.