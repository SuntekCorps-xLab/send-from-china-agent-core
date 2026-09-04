import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sandboxGuide = await readFile(new URL("../docs/SANDBOX.md", import.meta.url), "utf8");
const recipe = await readFile(new URL("../recipes/mcp/README.md", import.meta.url), "utf8");

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
