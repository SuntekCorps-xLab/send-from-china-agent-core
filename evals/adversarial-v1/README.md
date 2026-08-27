# Adversarial Eval v1

This offline harness provides exactly 50 public synthetic safety cases across
ten attack classes. The included deterministic adapter validates refusal and
safety accounting only. It makes no production-quality claim about a language
model.

The attack classes cover prompt injection, forbidden writes, scope escalation,
access-material exfiltration, repeated side effects, tool confusion, private
field requests, terminal-state coercion, cross-tenant requests and encoded
instructions.

## Run the public synthetic contract

Create both files outside the checkout and use fresh filenames:

```powershell
$adversarialDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-adversarial-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $adversarialDir | Out-Null
npm run eval:adversarial:fixture -- --output (Join-Path $adversarialDir "tasks.json")
npm run eval:adversarial -- --tasks (Join-Path $adversarialDir "tasks.json") --output (Join-Path $adversarialDir "aggregate.json") --adapter deterministic
```

The adapter runs once per case, does not retry, does not call the network and
does not invoke tools or writes. `--adapter real-llm` emits a sanitized blocked
artifact and exits with code 2 because this repository does not contain an
approved model execution environment. The runner accepts only the canonical
JSON value produced by the checked-in generator; schema-valid changes to tools,
scopes, expectations, fixtures or canaries are rejected by SHA-256 comparison,
and the generator source is part of the runner fingerprint. Scoring uses a
deeply frozen canonical authority task while the adapter receives a fresh
clone; accepted-input, canonical and authority hashes are checked again after
execution.

[`task.schema.json`](task.schema.json), [`run.schema.json`](run.schema.json)
and [`aggregate.schema.json`](aggregate.schema.json) lock the three contracts.
Raw prompts and run responses are never written by the local runner. The
aggregate contains only totals and fingerprints; it contains no prompt,
response, case identifier, canary or access material.

`gates.exact_sha_synthetic_contract` is limited to a clean local checkout and
does not attest an official ref or signature. Those facts are explicit in the
repository object. `gates.release_authorization` remains false because real-LLM
evidence is missing; a deterministic 50/50 result is not a release Gate.

Input and output paths fail closed on repository placement, traversal,
symlinks, hardlinks, oversize input or overwrite. Reads and writes recheck file
handle and physical-path identity. The external parent directory remains a
trusted-parent requirement: only the current trusted user may be able to mutate
it while a run is in progress. Run contract tests with:

```bash
npm run eval:adversarial:test
```
