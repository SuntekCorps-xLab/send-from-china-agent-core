import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");
const [readme, security, skill, scope] = await Promise.all([
  read("README.md"),
  read("docs/SECURITY_MODEL.md"),
  read("skills/send-from-china-catalog/SKILL.md"),
  read("docs/WHAT_IT_IS.md"),
]);

test("README links the capability boundary and separates managed from self-hosted auth", () => {
  assert.match(readme, /docs\/WHAT_IT_IS\.md/u);
  assert.match(readme, /bundled local and self-hosted Worker\s+profiles, every `tools\/call` requires a tenant credential/u);
  assert.match(readme, /managed public\s+endpoint described in section 1 separately allows the five named catalog-read\s+tools without a credential/u);
  assert.doesNotMatch(readme, /skill does not contain an endpoint/iu);
});

test("security and Skill docs agree with the managed anonymous-read contract", () => {
  assert.match(security, /five documented catalog-read tools anonymously/u);
  assert.match(skill, /https:\/\/wp-api\.sendfromchina\.ai\/mcp/u);
  assert.match(readme, /skill names the managed public MCP\s+endpoint for its five anonymous read tools/u);
});

test("scope page lists all public tools and rejects transaction and attribution claims", () => {
  for (const tool of [
    "product_search", "search_catalog", "browse_catalog", "ask_catalog", "get_product",
  ]) assert.match(scope, new RegExp(`\\b${tool}\\b`, "u"));
  assert.match(scope, /not a checkout, order, payment, refund/u);
  assert.match(scope, /does not prove that a checkout completed/u);
  assert.match(scope, /Durable per-partner attribution and store-side order\s+capture.+not part of version\s+1\.2\.0/su);
  assert.match(scope, /Never paste a production token/u);
});
