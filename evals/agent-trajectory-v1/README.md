# Agent trajectory Eval v1

This offline harness freezes the shape of the 30-task, three-first-attempt-run
trajectory Gate. It is deliberately split into two claims:

- the included deterministic adapter validates the runner, task contract and
  safety accounting across exactly 90 first attempts;
- the real-LLM Gate remains `BLOCKED` until an approved, separately governed
  execution environment produces genuine first-attempt evidence.

A deterministic `90/90` result is not a 90-run LLM result and is not evidence
of production task quality. The aggregate always records the real-LLM evidence
count as zero and never authorizes rollout.

## Run the public synthetic contract

Both the generated input and aggregate must remain outside the checkout. Make
a fresh directory and use a new filename for every command:

```powershell
$trajectoryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-trajectory-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $trajectoryDir | Out-Null
npm run eval:agent-trajectory:fixture -- --output (Join-Path $trajectoryDir "tasks.json")
npm run eval:agent-trajectory -- --tasks (Join-Path $trajectoryDir "tasks.json") --output (Join-Path $trajectoryDir "aggregate.json") --adapter deterministic
```

The input is public synthetic data. The adapter is in-process, makes zero
network requests, and invokes no production tool. Every task is executed three
times as a first attempt. A failure is retained; the runner never retries a
failed task. The runner accepts only the byte-independent canonical JSON value
produced by the checked-in generator: its SHA-256 must match after strict
schema-equivalent validation. Changes to tools, scopes, expectations, fixtures
or canaries fail closed. The generator source is included in the runner source
fingerprint. Before execution the accepted input hash is frozen, scoring uses a
separate deeply frozen canonical authority task, and an adapter receives only a
fresh clone. Input, canonical and authority hashes are rechecked after every
run cohort, so an adapter cannot rewrite the policy it is scored against.

Running with `--adapter real-llm` fails closed with exit code 2 and a sanitized
`approved_real_llm_environment_missing` result. It does not call a model or
fabricate run records.

## Contracts and privacy

- [`task.schema.json`](task.schema.json) locks exactly 30 public synthetic
  tasks.
- [`run.schema.json`](run.schema.json) defines one raw first-attempt record for
  a future approved adapter. Local records remain in memory.
- [`aggregate.schema.json`](aggregate.schema.json) permits only counts,
  booleans, fixed Gate state and cryptographic fingerprints.

The aggregate contains no prompt, response, task identifier, canary, access
material or tool arguments. It detects forbidden tools, repeated side effects,
any side effect, scope escalation, leak canaries, suspicious access material,
network calls, production writes, retries, run-index substitution, adapter
substitution, terminal mismatch and tool-plan mismatch. Credential inspection
is key-aware and also detects Bearer/Basic authorization, GitHub, JWT, Shopify,
AWS and common `sk-` token shapes in both responses and nested tool arguments.
Known and suffix-prefixed environment keys such as `cloudflare_api_token`,
`shopify_access_token`, `agent_core_tenant_key` and `preview_key` are sensitive.
Equivalent camelCase or unseparated prefixed keys are also sensitive, and that
context is retained through nested objects and arrays. Ordinary public fields
whose names only contain those words, such as counts or status labels, are not
treated as credentials.

`gates.exact_sha_synthetic_contract` means only that the deterministic contract
ran against the recorded local checkout commit while the checkout was clean.
The repository evidence explicitly records `local_checkout_only`,
`official_ref_attested=false` and `signature_verified=false`; it is not proof of
an official remote ref or signed release. `gates.release_authorization` is
always false while real-LLM evidence is missing.

Inputs and outputs must be regular single-link files outside the repository.
Traversal segments, symlinks, hardlinks and overwrites are rejected. Output
parents must already exist so the physical boundary can be checked before an
exclusive create. Inputs are size-checked before reading through a file handle,
then handle and path identity, link count, size and timestamps are rechecked.
Outputs use exclusive handle creation and post-write physical-target checks.
The caller must nevertheless provide an external parent directory controlled
only by the current trusted user; the harness cannot make a directory writable
by a hostile principal safe against every filesystem race.

Run the contract tests with:

```bash
npm run eval:agent-trajectory:test
```
