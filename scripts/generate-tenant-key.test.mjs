import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("tenant key generator emits a random deployer-managed configuration", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-tenant-key.mjs", "tenant_example"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.tenant_key, /^key_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(JSON.parse(output.tenant_keys_json)[output.tenant_key], {
    tenant_id: "tenant_example",
    max_page_size: 5,
    daily_quota: 100,
  });
  assert.match(output.warning, /Never commit/);
});

test("tenant key generator rejects invalid tenant identifiers", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-tenant-key.mjs", "not valid"], {
    encoding: "utf8",
    shell: false,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage/);
});
