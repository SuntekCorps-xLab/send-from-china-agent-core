import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("zero-credential first run is complete and copy-pasteable", () => {
  const section = readme.match(/## 2\. Run the zero-account local sandbox(?<body>[\s\S]*?)### Explicit Shopify read-only mode/u)?.groups?.body;
  assert.ok(section, "zero-account sandbox section is missing");
  for (const literal of [
    "Node.js 22.x",
    "npm 10.x",
    "git clone --depth 1 https://github.com/SuntekCorps-xLab/send-from-china-agent-core.git",
    "cd send-from-china-agent-core",
    "npm ci",
    "npm run test:sandbox",
    "npm run sandbox",
    "Agent Core synthetic sandbox: http://127.0.0.1:8787/sandbox",
    "curl -fsS http://127.0.0.1:8787/sandbox/status",
    'mode: "synthetic_local_sandbox"',
    'data_source: "synthetic_fixture"',
    "writes: false",
    "verified: true",
  ]) assert.ok(section.includes(literal), `missing first-run instruction: ${literal}`);
});

test("zero-account and credentialed Shopify paths remain visibly separated", () => {
  const localPosition = readme.indexOf("## 2. Run the zero-account local sandbox");
  const shopifyPosition = readme.indexOf("### Explicit Shopify read-only mode");
  assert.ok(localPosition >= 0 && shopifyPosition > localPosition);
  const shopify = readme.slice(shopifyPosition, readme.indexOf("### Invite-only hosted", shopifyPosition));
  assert.match(shopify, /separate, credentialed operator path/u);
  assert.match(shopify, /do not put its token in browser code, shell\s+history, source files, logs, or issue reports/u);
});
