# Deployment and Rollback

## Preflight

1. Use Node.js 22 or newer.
2. Run `npm ci`, `npm run verify`, and the repository safety scan.
3. Set `ALLOWED_ORIGINS` to the exact HTTPS origins that need browser access.
4. Inject `TENANT_KEYS` through the destination secret store. Never place it in
   `wrangler.toml` or source control.
5. Validate the published snapshot and tenant scopes before building.
6. Confirm the deployment exposes no commerce or production write route.

## Cloudflare Worker

```bash
cd governance-worker
npm ci
npx wrangler deploy
```

The checked-in `wrangler.toml` contains no account identifier or secret. Select
the destination account through your own authenticated CLI session. Never add a
token to the file.

Verify after deployment:

```bash
curl https://YOUR_WORKER.example/health
curl "https://YOUR_WORKER.example/api/search?q=desk" \
  -H "Authorization: Bearer ${TENANT_KEY}"
```

The health response must report `mode=published_snapshot_gateway`,
`writes_enabled=false`, the expected snapshot timestamps, and
`tenant_auth_configured=true`. A stale snapshot may remain browsable, but the
quote route fails closed until a fresh snapshot is deployed.

## Rollback

Use the platform's deployment history to restore the previous known-good
version, then repeat both verification requests. If origin policy is wrong,
restore the previous `ALLOWED_ORIGINS` value instead of weakening it to `*`.

This reference project has no migration, database, or persistent queue to roll
back. Deploying or rolling back clears quotas, fixture sourcing tasks, and
idempotency records. Rollback also restores the snapshot bundled with that
deployment. A downstream integration must document durable migrations, queues,
and recovery independently.
