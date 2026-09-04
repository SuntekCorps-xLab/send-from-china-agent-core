import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "..");
const config = await readFile(resolve(root, "wrangler.toml"), "utf8");
const readme = await readFile(resolve(root, "README.md"), "utf8");
const packageDocument = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const stagingStart = config.indexOf("[env.staging]");
const rootConfig = config.slice(0, stagingStart);
const stagingConfig = config.slice(stagingStart);

test("default deployment cannot use workers.dev and only staging can", () => {
  assert.ok(stagingStart > 0, "a closed staging environment must exist");
  assert.match(rootConfig, /^name = "send-from-china-hosted-shopify-sandbox"$/mu);
  assert.match(rootConfig, /^workers_dev = false$/mu);
  assert.match(rootConfig, /^preview_urls = false$/mu);
  assert.doesNotMatch(rootConfig, /^workers_dev = true$/mu);

  assert.match(stagingConfig, /^name = "send-from-china-hosted-shopify-sandbox-staging"$/mu);
  assert.match(stagingConfig, /^workers_dev = true$/mu);
  assert.match(stagingConfig, /^preview_urls = false$/mu);
  assert.doesNotMatch(stagingConfig, /^workers_dev = false$/mu);
  assert.equal((config.match(/^workers_dev = true$/gmu) || []).length, 1);
  assert.equal((config.match(/^workers_dev = false$/gmu) || []).length, 1);
});

test("staging repeats protected vars, assets, and a separate rate-limit namespace", () => {
  for (const fragment of [
    'SANDBOX_DEPLOYMENT_MODE = "public"',
    'SANDBOX_ACCESS_MODE = "protected"',
    'SANDBOX_RATE_LIMIT_LIMIT = "60"',
    'SANDBOX_RATE_LIMIT_PERIOD = "60"',
    'binding = "ASSETS"',
    'run_worker_first = true',
    'name = "SANDBOX_RATE_LIMITER"',
  ]) {
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.equal((config.match(new RegExp(escaped, "gu")) || []).length, 2, `${fragment} must exist in both environments`);
  }
  assert.match(rootConfig, /^namespace_id = "26083101"$/mu);
  assert.match(stagingConfig, /^namespace_id = "26083102"$/mu);
  assert.match(stagingConfig, /^simple = \{ limit = 60, period = 60 \}$/mu);
});

test("configuration has no route, custom domain, secret value, or production environment", () => {
  assert.doesNotMatch(config, /^\s*(?:route|routes|custom_domain|custom_domains|zone_id)\s*=/imu);
  assert.doesNotMatch(config, /^\[env\.production(?:\]|\.)/imu);
  assert.doesNotMatch(config, /SHOPIFY_STORE_DOMAIN|SHOPIFY_STOREFRONT_ACCESS_TOKEN|SANDBOX_INVITE_SHA256/u);
  assert.doesNotMatch(config, /https?:\/\//iu);
});

test("automation only dry-runs both environments and exposes no production deploy script", () => {
  for (const command of Object.values(packageDocument.scripts || {})) {
    assert.doesNotMatch(command, /\bwrangler(?:\.js)?\s+deploy\b/iu);
  }
  const deployLines = workflow.split(/\r?\n/u).filter((line) => /wrangler\.js deploy/iu.test(line));
  assert.equal(deployLines.length, 2);
  assert.ok(deployLines.every((line) => line.includes("--dry-run")));
  assert.ok(deployLines.some((line) => line.includes("--env staging")));
  assert.ok(deployLines.some((line) => line.includes('--env=""')));
});

test("documentation authorizes only named staging secrets and forbids operating-store use", () => {
  for (const name of [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_STOREFRONT_ACCESS_TOKEN",
    "SANDBOX_INVITE_SHA256",
  ]) {
    assert.match(readme, new RegExp(`secret put ${name} --env staging`, "u"));
    assert.doesNotMatch(readme, new RegExp(`${name}\\s*=`, "u"));
  }
  assert.match(readme, /deploy --env staging --config hosted-sandbox\/wrangler\.toml/u);
  assert.match(readme, /Never connect this candidate to[\s\S]*operating merchant store/u);
  assert.doesNotMatch(readme, /https:\/\/[^\s`]*workers\.dev/iu);
});
