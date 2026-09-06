import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleMcp } from "../governance-worker/src/mcp.js";

const sandboxGuide = await readFile(new URL("../docs/SANDBOX.md", import.meta.url), "utf8");
const recipe = await readFile(new URL("../recipes/mcp/README.md", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const hostedQuickstart = await readFile(new URL("../docs/HOSTED_PLATFORM_QUICKSTART.md", import.meta.url), "utf8");
const sourcingQuickstart = await readFile(new URL("../docs/SOURCING_QUICKSTART.md", import.meta.url), "utf8");
const sdkReadme = await readFile(new URL("../sdk/README.md", import.meta.url), "utf8");
const sourcingRuntime = await readFile(new URL("../governance-worker/src/sourcing.js", import.meta.url), "utf8");
const catalogSkill = await readFile(new URL("../skills/send-from-china-catalog/SKILL.md", import.meta.url), "utf8");
const catalogContracts = await readFile(
  new URL("../skills/send-from-china-catalog/references/contracts.md", import.meta.url),
  "utf8",
);

test("MCP guide keeps explicit client configuration and transport boundaries", () => {
  for (const required of [
    "### Claude Code CLI or desktop app",
    "claude mcp add --transport http",
    '"type": "http"',
    "### Claude Desktop consumer app",
    "%APPDATA%\\Claude\\claude_desktop_config.json",
    "scripts\\\\mcp-stdio-bridge.mjs",
    "### Cursor",
    ".cursor/mcp.json",
    "### Windsurf",
    ".codeium/windsurf/mcp_config.json",
    "### Other stdio-only clients",
    "### Verify and troubleshoot",
  ]) {
    assert.match(sandboxGuide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("copyable MCP recipe declares HTTP rather than an implicit stdio entry", () => {
  assert.match(recipe, /"type": "http"/u);
  assert.match(recipe, /client-specific setup and troubleshooting guide/u);
});

test("root onboarding presents live MCP, local sandbox, and self-hosting in that order", () => {
  const live = readme.indexOf("## 1. Try live read-only MCP");
  const local = readme.indexOf("## 2. Run the zero-account local sandbox");
  const selfHost = readme.indexOf("## 3. Self-host with your own catalog");
  assert.ok(live > 0 && local > live && selfHost > local);
  assert.match(readme, /https:\/\/wp-api\.sendfromchina\.ai\/mcp/u);
  for (const tool of ["product_search", "search_catalog", "browse_catalog", "ask_catalog", "get_product"]) {
    assert.match(readme, new RegExp(`\\b${tool}\\b`, "u"));
  }
  assert.match(readme, /price,\s*publication, and availability as point-in-time Shopify facts/u);
  assert.doesNotMatch(readme, /world[ -]products/iu);
});

test("terminal MCP miss quickstart uses executable response fields", () => {
  assert.match(hostedQuickstart, /const canSource = Boolean\(/u);
  for (const field of [
    'search.status === "no_match"',
    "search.exhaustive === true",
    "search.search_scope_exhausted === true",
    "search.search_id",
  ]) {
    assert.match(hostedQuickstart, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(hostedQuickstart, /expires after 15 minutes/u);
  assert.match(hostedQuickstart, /restart, deployment, isolate change, or expiry invalidates it/u);
  assert.match(hostedQuickstart, /same idempotency key/u);
});

test("sourcing docs and runtime keep key-order-independent proof matching", () => {
  assert.match(sourcingQuickstart, /JSON object key order is\s+not significant/u);
  assert.match(sourcingQuickstart, /SEARCH_PROOF_MISMATCH/u);
  assert.match(sourcingRuntime, /criteriaEqual\(proof\.criteria, request\.criteria\)/u);
  assert.doesNotMatch(sourcingRuntime, /JSON\.stringify\(proof\.criteria\)/u);
});

test("SDK docs use results and state the sandbox purchase-handoff boundary", () => {
  const javascriptExamples = [...sdkReadme.matchAll(/```js\s+([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join("\n");
  assert.match(sdkReadme, /for \(const product of search\.results\)/u);
  assert.doesNotMatch(javascriptExamples, /search\.items/u);
  assert.match(sdkReadme, /resolvePurchaseHandoff\(\)` returns `null` there by\s+design/u);
  assert.match(sdkReadme, /exactly\s+matches a `commerceOrigins` entry/u);
});

test("local search docs explain required query, tenant limit, and non-enumeration", () => {
  assert.match(readme, /`q` is required and must contain 1–300 characters/u);
  assert.match(readme, /`limit` cannot\s+exceed the tenant's `max_page_size`/u);
  assert.match(readme, /Restricted tenants deliberately cannot enumerate their entire visible set/u);
  for (const query of ["desk", "garden", "blocks", "cable", "lunch"]) {
    assert.match(readme, new RegExp(`\\b${query}\\b`, "u"));
  }
  assert.doesNotMatch(readme, /## 60-second local run/u);
  assert.match(readme, /first setup installs locked dependencies and can take several minutes/u);
  assert.match(readme, /PYTHON=\/absolute\/path\/to\/python3\.11/u);
});

test("catalog skill connects public reads to the managed production MCP profile", () => {
  for (const document of [catalogSkill, catalogContracts]) {
    assert.match(document, /https:\/\/wp-api\.sendfromchina\.ai\/mcp/u);
  }

  for (const tool of ["product_search", "search_catalog", "browse_catalog", "ask_catalog", "get_product"]) {
    assert.match(catalogContracts, new RegExp(`(?:^|\\W)${tool}(?:$|\\W)`, "u"));
  }

  assert.match(catalogSkill, /do not require a Bearer credential/u);
  assert.match(catalogSkill, /Do not call `get_agent_access` before these public reads/u);
});

test("catalog skill keeps hosted public reads separate from protected and self-hosted calls", () => {
  assert.match(catalogContracts, /runtime in this repository requires that credential for every `tools\/call`/u);
  assert.match(catalogContracts, /bundled catalog is synthetic/u);
  assert.match(catalogContracts, /Account, quote, sourcing, and write-capable operations require a deployment-issued key/u);
  assert.doesNotMatch(catalogContracts, /^MCP `initialize` and `tools\/list` are public\. Every `tools\/call` requires/mu);
});

test("managed-live and self-hosted get_product examples use their own schemas", async () => {
  const liveStart = readme.indexOf("## 1. Try live read-only MCP");
  const liveEnd = readme.indexOf("## What you can build with it", liveStart);
  assert.ok(liveStart >= 0 && liveEnd > liveStart);
  const liveSection = readme.slice(liveStart, liveEnd);
  const liveBodies = [...liveSection.matchAll(/--data '([^'\r\n]+)'/gu)]
    .map((match) => JSON.parse(match[1]));
  const liveProductCall = liveBodies.find((body) => body.params?.name === "get_product");
  assert.ok(liveProductCall, "managed-live quickstart must include get_product");
  assert.deepEqual(Object.keys(liveProductCall.params.arguments), ["handle"]);
  assert.equal(liveProductCall.params.arguments.handle, "<returned-handle>");
  assert.doesNotMatch(liveSection, /\bslug\b/iu);

  const discovery = await handleMcp({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
  const selfHostedSchema = discovery.body.result.tools
    .find((tool) => tool.name === "get_product")?.inputSchema;
  assert.ok(selfHostedSchema, "self-hosted tools/list must include get_product");
  assert.deepEqual(Object.keys(selfHostedSchema.properties), ["slug"]);
  assert.deepEqual(selfHostedSchema.required, ["slug"]);
  assert.equal(selfHostedSchema.additionalProperties, false);

  const localAndSelfHostedSections = readme.slice(liveEnd);
  assert.match(localAndSelfHostedSections, /Read one product by public slug:/u);
  assert.match(localAndSelfHostedSections, /`get_product` \| Product detail by public slug/u);

  assert.match(catalogSkill, /managed live[\s\S]*?`get_product` with the `handle` returned by search/iu);
  assert.match(catalogSkill, /local synthetic or self-hosted[\s\S]*?`get_product` with the returned public `slug`/iu);
  assert.match(catalogContracts, /Managed live public catalog[\s\S]*?`get_product` with the `handle` returned by search/iu);
  assert.match(catalogContracts, /Local synthetic and self-hosted deployments[\s\S]*?`get_product` with the returned public `slug`/iu);
});
