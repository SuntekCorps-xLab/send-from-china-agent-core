# Snapshot Publisher

The publisher converts a user-owned JSON or JSONL catalog into the exact
snapshot consumed by Agent Core. It uses only the Python standard library,
makes no network request, and writes output atomically.

## 1. Prepare input

Start from [`samples/catalog-input.sample.json`](samples/catalog-input.sample.json)
or the JSON Schema at
[`../contracts/publisher-input.schema.json`](../contracts/publisher-input.schema.json).

Each product has a local `source_id`. That value is accepted only by the local
publisher and is never written to the public snapshot. Tenant scopes refer to
the same local values through `source_ids`.

JSONL is also accepted. Put one product object on each line and provide tenant
scopes in a separate JSON file with `--tenant-config`.

## 2. Create a local identifier key

Generate a random value and keep it in your secret manager. The same key must
be used for every subsequent build or product identifiers will change.

```bash
export CATALOG_ID_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

PowerShell:

```powershell
$env:CATALOG_ID_KEY = python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Do not put the value in a command-line argument, repository file, snapshot,
build report, support ticket, or log.

## 3. Build and validate

From the repository root:

```bash
python publisher/build_snapshot.py \
  --source publisher/samples/catalog-input.sample.json \
  --output build/published-catalog.json \
  --report build/publisher-report.json

node scripts/validate-snapshot.mjs build/published-catalog.json
```

PowerShell:

```powershell
python publisher\build_snapshot.py `
  --source publisher\samples\catalog-input.sample.json `
  --output build\published-catalog.json `
  --report build\publisher-report.json

node scripts\validate-snapshot.mjs build\published-catalog.json
```

The report contains counts, freshness timestamps, discarded input field count,
and a SHA-256 digest of the exact snapshot file content. It contains no product
records or local identifiers.

Use `--generated-at` for reproducible contract tests and
`--valid-for-seconds` to set a freshness window between one minute and seven
days. Use `--check-only` to validate without writing files.

## 4. Run the gateway with the snapshot

The Phase 2 reference uses a build-time JSON import so the Worker still has no
filesystem or network access at runtime. Copy the validated snapshot over the
development fixture, rebuild, and do not commit the resulting catalog:

```bash
cp build/published-catalog.json fixtures/published-catalog.sample.json
cd governance-worker
npm run verify
npm run dev
```

PowerShell copy command:

```powershell
Copy-Item build\published-catalog.json fixtures\published-catalog.sample.json
```

For a production fork, make the generated snapshot a private build artifact
and inject it before the Worker bundle step. Do not publish source files,
identifier keys, local IDs, tenant keys, or generated production snapshots in
the open repository.

## Safety behavior

- A missing or short identifier key stops the build.
- Product identifiers are stable keyed derivations with no reversible source
  relationship.
- Unknown product input fields are counted and discarded.
- Invalid URLs, nested attributes, duplicate products, invalid availability,
  and unknown tenant product references stop the entire build.
- Output uses a temporary file and atomic replacement.
- The publisher never writes the key or local product identifiers to output.
