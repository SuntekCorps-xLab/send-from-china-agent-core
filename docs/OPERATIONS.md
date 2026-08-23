# Operations and Incident Response

This repository is a published-snapshot reference gateway with ephemeral
per-isolate quota and sourcing fixtures. It has no database, customer records,
payment flow, order flow, or commerce write-capable tool.

## Readiness and Monitoring

- Probe `GET /health` from outside the deployment network.
- Require HTTP 200, `mode=published_snapshot_gateway`, and `writes_enabled=false`.
- Alert when `catalog_stale=true` or the snapshot timestamps are unexpected.
- Test tenant isolation, search, and non-binding quote behavior with a controlled key.
- Alert on sustained 5xx responses, elevated latency, or health-check failure.
- Use the response `X-Request-Id` to correlate a report with platform logs.
- Do not log request bodies, authorization headers, cookies, or client data.

The service intentionally has no analytics SDK. A deployer may use platform
request metrics, but must document retention, access, and privacy boundaries
before adding application telemetry.

## Capacity Boundaries

Request bodies are limited to 32 KiB, search text to 300 characters, chat
history to 20 messages, search output to 200 results, and page size to the
tenant's configured maximum. Fixture task state and the daily quota are local
to an isolate and reset on restart. Replacing either with a large or durable
system requires a new capacity test and threat review.

## Failure Response

1. Confirm the failure with `/health` and record the request ID and UTC time.
2. If a release introduced the failure, restore the previous deployment.
3. If origin policy is wrong, restore the last approved allowlist; never use
   a wildcard as an emergency workaround.
4. If private data or a credential may have entered an artifact, stop the
   release, remove public access, rotate affected credentials, and inspect
   Git history and CI artifacts before reopening access.
5. Record the cause, impact, corrective action, and a regression test.

## Compatibility and Data Changes

There are no database migrations in this release. API response shapes follow
the release-candidate version and should be treated as unstable until `1.0.0`.
An incompatible API change requires release notes and a version update.
