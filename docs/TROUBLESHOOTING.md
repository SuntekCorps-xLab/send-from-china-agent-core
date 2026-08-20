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

## Chat Is Not Generative

`/api/chat` is deterministic and performs catalog matching only. This prevents
the quick start from requiring a model credential or sending user input to a
third party. A downstream model integration needs its own data-handling policy,
timeouts, fallback behavior, output validation, and tests.

## No Order or Payment Route

This is intentional. The public project cannot accept money, publish a product,
or create an order. Those capabilities require authenticated and auditable
production integrations that are outside this release.
