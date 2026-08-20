# Deployment and Rollback

## Preflight

1. Use Node.js 22 or newer.
2. Run `npm ci`, `npm run verify`, and the repository safety scan.
3. Set `ALLOWED_ORIGINS` to the exact HTTPS origins that need browser access.
4. Confirm the deployment still uses synthetic data and exposes no write route.

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
curl "https://YOUR_WORKER.example/api/search?q=desk"
```

The health response must report `mode=synthetic_demo` and
`writes_enabled=false`.

## Rollback

Use the platform's deployment history to restore the previous known-good
version, then repeat both verification requests. If origin policy is wrong,
restore the previous `ALLOWED_ORIGINS` value instead of weakening it to `*`.

This reference project has no migration, database, or persistent queue to roll
back. A downstream production integration must document those independently.
