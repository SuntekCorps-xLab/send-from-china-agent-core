# Troubleshooting and Limits

## `ORIGIN_NOT_ALLOWED`

The request includes an `Origin` that is not listed in `ALLOWED_ORIGINS`. Add
the exact scheme and hostname only when that browser client is trusted. Do not
use a wildcard as a quick fix.

## `INVALID_QUERY`, `INVALID_LIMIT`, or `INVALID_CURSOR`

Queries must be 1 to 300 characters. Page size must be 1 to 50. Cursors are
opaque and must be reused exactly as returned.

## `PAYLOAD_TOO_LARGE`

JSON bodies are limited to 32 KiB. Send a compact message history of no more
than 20 messages.

## Search Finds Few Products

The repository contains four synthetic products by design. It is suitable for
contract and interface testing, not merchandising evaluation.

## `SOURCING_DEMO_DISABLED` or `INVALID_AGENT_TOKEN`

Synthetic sourcing is fail-closed. Configure a random `DEMO_AGENT_TOKEN` of at
least 16 characters in local `.dev.vars` or the platform secret store, then
send the same value as a bearer credential. Do not place it in source, a URL,
an issue, or a test artifact.

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
