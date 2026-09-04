# Troubleshooting and Limits

## `ORIGIN_NOT_ALLOWED`

The request includes an `Origin` that is not listed in `ALLOWED_ORIGINS`. Add
the exact scheme and hostname only when that browser client is trusted. Do not
use a wildcard as a quick fix.

## `INVALID_QUERY`, `INVALID_LIMIT`, or `INVALID_CURSOR`

Queries must be 1 to 300 characters. Page size cannot exceed the tenant's
`max_page_size`. Cursors are opaque and must be reused exactly as returned.

`q` is required for `GET /api/search`. Restricted tenants cannot call
`GET /api/catalog` and cannot use a wildcard or empty query to enumerate their
visible set. Start with the buyer's product intent. When testing the checked-in
`tenant_alpha` fixture, use `desk`, `garden`, `blocks`, `cable`, or `lunch` as
known seed queries.

## `PAYLOAD_TOO_LARGE`

JSON bodies are limited to 32 KiB. Send a compact message history of no more
than 20 messages.

## Search Finds Few Products

The sample snapshot contains twelve products split between two tenant scopes.
Search only sees identifiers allowed for the current tenant.

## `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, or `AUTH_CONFIGURATION_ERROR`

Copy `.dev.vars.example` to `.dev.vars`, replace the local test key, and send it
as a bearer credential. `AUTH_CONFIGURATION_ERROR` means `TENANT_KEYS` is
missing or malformed. Do not place a real key in source, a URL, an issue, or a
test artifact.

## `ENUMERATION_NOT_ALLOWED` or `QUOTA_EXCEEDED`

Restricted tenants cannot call `/api/catalog`; use `/api/search`. Quota errors
include `Retry-After`. Phase 1 counters are per isolate and intended for
integration testing, not billing.

## `CATALOG_STALE`

Browsing may display a stale snapshot with its `as_of` timestamp. Quotes fail
closed until a snapshot with a future `valid_until` is deployed.

## Publisher `ID_KEY_TOO_SHORT`

Set `CATALOG_ID_KEY` in the local environment to a randomly generated value of
at least 32 bytes. Reuse the same value on later builds. Do not add it to a
file, CLI argument, issue, or log.

## Publisher `UNKNOWN_TENANT_PRODUCT`

A tenant scope references a `source_id` that is not present in the same input.
Correct the source file or tenant configuration; the publisher deliberately
rejects the entire snapshot.

## Publisher Output Changes Every Run

Product identifiers change only when the identifier key or source ID changes.
Timestamps change by default. Pass a fixed `--generated-at` for reproducible
contract tests, but use the real publication time for deployments.

## Publisher `INVALID_OUTPUT_PATH`

The snapshot and report must use different paths and neither may overwrite the
source catalog or tenant configuration. Choose paths under the ignored
`build/` directory.

## A Sourcing Task Disappeared

This release deliberately stores synthetic tasks and idempotency records only
in memory. An isolate restart, deployment, or request routed to another isolate
can make a task unavailable. Use the demo only for local contract testing; a
real integration requires durable tenant-bound state.

## A Task Immediately Reaches `RESULTS_READY`

That is expected. The demo returns a synchronous lifecycle fixture so clients
can test status and result handling. It does not run a supplier search or prove
an asynchronous production workflow.

## Chat Is Not Generative

`/api/chat` is deterministic and performs catalog matching only. This prevents
the quick start from requiring a model credential or sending user input to a
third party. A downstream model integration needs its own data-handling policy,
timeouts, fallback behavior, output validation, and tests.

## No Order or Payment Route

This is intentional. The public project cannot accept money, publish a product,
or create an order. Those capabilities require authenticated and auditable
production integrations that are outside this release.
