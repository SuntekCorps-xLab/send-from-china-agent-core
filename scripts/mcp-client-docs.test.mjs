import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sandboxGuide = await readFile(new URL("../docs/SANDBOX.md", import.meta.url), "utf8");
const recipe = await readFile(new URL("../recipes/mcp/README.md", import.meta.url), "utf8");
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
