import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

import { validatePairedEvidence } from "./generate-release-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const VERSION = "1.2.0";

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

test("release versions, badge, changelog, and release notes stay aligned", async () => {
  const packages = await Promise.all([
    json("package.json"), json("package-lock.json"), json("governance-worker/package.json"),
    json("governance-worker/package-lock.json"), json("sdk/package.json"),
    json("hosted-sandbox/package.json"), json("hosted-sandbox/package-lock.json")
  ]);
  for (const manifest of packages) assert.equal(manifest.version, VERSION);
  assert.equal(packages[1].packages[""].version, VERSION);
  assert.equal(packages[3].packages[""].version, VERSION);
  assert.equal(packages[6].packages[""].version, VERSION);

  const [readme, changelog, releaseNotes, openapi, workerIndex, mcp, evidenceGenerator] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"), readFile(resolve(root, "CHANGELOG.md"), "utf8"),
    readFile(resolve(root, "docs/releases/v1.2.0.md"), "utf8"), readFile(resolve(root, "contracts/openapi.yaml"), "utf8"),
    readFile(resolve(root, "governance-worker/src/index.js"), "utf8"), readFile(resolve(root, "governance-worker/src/mcp.js"), "utf8"),
    readFile(resolve(root, "scripts/generate-release-evidence.mjs"), "utf8")
  ]);
  assert.match(readme, /img\.shields\.io\/github\/v\/release\/SuntekCorps-xLab\/send-from-china-agent-core/u);
  assert.doesNotMatch(readme, /badge\/release-v[0-9]/u);
  assert.match(changelog, /^## 1\.2\.0 - 2026-09-04$/mu);
  assert.match(releaseNotes, /Release identity is generated at release time/u);
  assert.match(openapi, /^  version: 1\.2\.0$/mu);
  assert.match(workerIndex, /version: "1\.2\.0"/u);
  assert.match(mcp, /serverInfo: \{ name: "send-from-china-agent-core", version: "1\.2\.0" \}/u);
  assert.match(evidenceGenerator, /RELEASE_WORKTREE_NOT_CLEAN/u);
  assert.match(evidenceGenerator, /RELEASE_TAG_NOT_AT_HEAD/u);
});

test("the paired evidence schema recursively closes object definitions", async () => {
  const schema = await json("contracts/paired-release-evidence.v1.schema.json");
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") assert.equal(node.additionalProperties, false);
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
});

test("paired evidence requires exact identity, ten passes, and truthful App Proxy status", () => {
  const sha = "a".repeat(40);
  const tree = "b".repeat(40);
  const base = {
    schema_version: "agent-core-reference-store-paired-e2e/v1",
    generated_at: "2026-09-04T00:00:00.000Z",
    agent_core: { repository: "send-from-china-agent-core", version: VERSION, commit: sha, tree },
    reference_store: { repository: "send-from-china-reference-store", version: "1.1.0", commit: "c".repeat(40), tree: "d".repeat(40) },
    execution: { mode: "synthetic", journeys: 10, passed: 10, failed: 0 },
    gates: { status: "PASS", same_origin_bff: true, browser_credentials: 0, commerce_writes: 0, credential_exposure: 0, app_proxy_live_verified: false }
  };
  assert.equal(validatePairedEvidence(base, { commit: sha, tree }), base);
  assert.throws(() => validatePairedEvidence({ ...base, unexpected: true }, { commit: sha, tree }), /INVALID/u);
  assert.throws(() => validatePairedEvidence({ ...base, execution: { ...base.execution, passed: 9 } }, { commit: sha, tree }), /INVALID/u);
  assert.throws(() => validatePairedEvidence({ ...base, execution: { ...base.execution, mode: "shopify_app_proxy" } }, { commit: sha, tree }), /INVALID/u);
  const live = { ...base, execution: { ...base.execution, mode: "shopify_app_proxy" }, gates: { ...base.gates, app_proxy_live_verified: true } };
  assert.equal(validatePairedEvidence(live, { commit: sha, tree }), live);
  assert.throws(() => validatePairedEvidence(base, { commit: "e".repeat(40), tree }), /INVALID/u);
});
