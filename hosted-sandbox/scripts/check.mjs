import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(root, "public");
const expectedAssets = ["app.js", "index.html", "styles.css"];
const actualAssets = (await readdir(publicRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
assert.deepEqual(actualAssets, expectedAssets, "public assets must match the deployment allowlist exactly");

const publicSource = (await Promise.all(expectedAssets.map((name) => readFile(resolve(publicRoot, name), "utf8")))).join("\n");
assert.doesNotMatch(publicSource, /document\.cookie|localStorage|sessionStorage|indexedDB|cookieStore|serviceWorker/iu);
assert.doesNotMatch(publicSource, /https?:\/\/(?!sandbox\.example)/iu);
assert.doesNotMatch(publicSource, /x-shopify-(?:storefront-)?access-token/iu);

const workerFiles = ["src/index.js", "src/access.js", "src/rate-limit.js", "src/responses.js", "src/shopify-provider.js"];
const workerSource = (await Promise.all(workerFiles.map((name) => readFile(resolve(root, name), "utf8")))).join("\n");
assert.doesNotMatch(workerSource, /\bmutation\b/iu);
assert.doesNotMatch(workerSource, /console\.(?:log|info|warn|error)|SHOPIFY_STOREFRONT_ACCESS_TOKEN\s*=/u);

const config = await readFile(resolve(root, "wrangler.toml"), "utf8");
for (const fragment of [
  'workers_dev = false',
  'preview_urls = false',
  'run_worker_first = true',
  'binding = "ASSETS"',
  'name = "SANDBOX_RATE_LIMITER"',
  'SANDBOX_ACCESS_MODE = "protected"',
]) assert.match(config, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
assert.doesNotMatch(config, /SHOPIFY_STORE_DOMAIN|SHOPIFY_STOREFRONT_ACCESS_TOKEN|SANDBOX_INVITE_SHA256/u);

for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (file.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative(root, file.parentPath)}`);
}
console.log("PASS: hosted sandbox static allowlist and deployment boundary");
