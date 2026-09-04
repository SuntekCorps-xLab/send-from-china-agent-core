# curl: Search Contract v2

With `npm run sandbox` running in the repository root:

```bash
curl -sS http://127.0.0.1:8790/sandbox/api/search/v2 \
  -H "Content-Type: application/json" \
  --data-binary @recipes/curl/search-v2.json
```

The result is a synthetic, non-purchasable Search Contract v2 response. No
credential is supplied by the caller; the loopback wrapper holds an ephemeral
scope only inside the local process.
