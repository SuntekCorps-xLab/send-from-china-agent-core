import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// The opt-in Linux CI step owns both real npm launchers and their process groups.
// Routine verification uses ephemeral ports instead of claiming these defaults.
const workerUrl = "http://127.0.0.1:8787";
const sandboxUrl = "http://127.0.0.1:8790";
const artifacts = "artifacts/local-profiles";
const [example, local] = await Promise.all([
  readFile("governance-worker/.dev.vars.example", "utf8"),
  readFile("governance-worker/.dev.vars", "utf8"),
]);
assert.ok(local === example, "Real-launcher verification requires the unchanged synthetic local fixture configuration");
assert.match(await readFile(`${artifacts}/worker.log`, "utf8"), /Ready on http:\/\/127\.0\.0\.1:8787\b/u);
assert.match(await readFile(`${artifacts}/sandbox.log`, "utf8"), /Agent Core synthetic sandbox: http:\/\/127\.0\.0\.1:8790\/sandbox/u);

const sandboxHealthResponse = await fetch(`${sandboxUrl}/health`);
const sandboxHealth = await sandboxHealthResponse.json();
assert.equal(sandboxHealth.mode, "synthetic_local_sandbox");
assert.equal(sandboxHealth.data_source, "synthetic_fixture");
assert.equal(sandboxHealthResponse.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");
const workerHealth = await (await fetch(`${workerUrl}/health`)).json();
assert.equal(workerHealth.mode, "published_snapshot_gateway");
assert.equal(workerHealth.writes_enabled, false);

const tenantKey = "key_test_alpha_1234567890";
const workerSearch = await fetch(`${workerUrl}/api/search?q=desk&limit=5`, {
  headers: { authorization: `Bearer ${tenantKey}` },
});
assert.equal(workerSearch.status, 200);
assert.equal((await workerSearch.json()).items[0].slug, "modular-desk-organizer");
const sandboxSearch = await (await fetch(`${sandboxUrl}/sandbox/api/search?q=desk&limit=5`)).json();
assert.equal(sandboxSearch.items[0].slug, "modular-desk-organizer");
assert.equal(sandboxSearch.items[0].purchasable, false);

function smoke(args) {
  const result = spawnSync("npm", ["run", "smoke", ...args], {
    encoding: "utf8",
    env: { ...process.env, TENANT_KEY: tenantKey, AGENT_CORE_URL: "" },
    timeout: 15000,
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}
const correctSmoke = smoke([]);
await writeFile(`${artifacts}/worker-smoke.log`, correctSmoke.stdout + correctSmoke.stderr);
assert.equal(correctSmoke.status, 0, correctSmoke.stderr);
assert.ok(correctSmoke.stdout.includes(`"base_url": "${workerUrl}"`));
const wrongSmoke = smoke(["--", "--url", sandboxUrl]);
await writeFile(`${artifacts}/sandbox-smoke-rejection.log`, wrongSmoke.stdout + wrongSmoke.stderr);
assert.notEqual(wrongSmoke.status, 0);
assert.match(wrongSmoke.stderr, /Worker profile required; the selected URL serves a synthetic sandbox/u);

const receipt = {
  ok: true,
  node: process.version,
  actual_npm_launchers: true,
  fixture_only: true,
  worker_url: workerUrl,
  worker_health_mode: workerHealth.mode,
  sandbox_url: sandboxUrl,
  sandbox_health_mode: sandboxHealth.mode,
  authenticated_worker_search: "passed",
  unauthenticated_synthetic_sandbox_search: "passed",
  default_worker_smoke: "passed",
  sandbox_smoke_rejected: true,
  deployment_performed: false,
};
await writeFile(`${artifacts}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
