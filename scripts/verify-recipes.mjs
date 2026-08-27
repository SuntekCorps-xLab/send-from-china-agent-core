import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runSearchV2 } from "../recipes/javascript/search-v2.mjs";
import { startSandbox } from "../sandbox/server.mjs";
import { searchSyntheticCatalog } from "../starters/agent-core-js/src/index.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));
const curlBody = JSON.parse(await readFile(resolve(root, "recipes/curl/search-v2.json"), "utf8"));
const mcpBody = JSON.parse(await readFile(resolve(root, "recipes/mcp/product-search.json"), "utf8"));
assert.equal(curlBody.contract_version, "2.0");
assert.equal(mcpBody.method, "tools/call");
assert.equal(mcpBody.params.name, "product_search");

const sandbox = await startSandbox({ port: 0 });
try {
  const v2 = await runSearchV2({ baseUrl: sandbox.baseUrl });
  assert.equal(v2.mode, "synthetic_local_sandbox");
  assert.equal(v2.purchasable, false);
  assert.ok(v2.results.length > 0);

  const curlResponse = await fetch(`${sandbox.baseUrl}/sandbox/api/search/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(curlBody),
  });
  const curl = await curlResponse.json();
  assert.equal(curlResponse.status, 200);
  assert.equal(curl.mode, "synthetic_local_sandbox");
  assert.equal(curl.purchasable, false);

  const starter = await searchSyntheticCatalog("desk organizer", { baseUrl: sandbox.baseUrl });
  assert.equal(starter.mode, "synthetic_local_sandbox");
  assert.equal(starter.purchasable, false);

  const mcpResponse = await fetch(`${sandbox.baseUrl}/sandbox/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mcpBody),
  });
  const mcp = await mcpResponse.json();
  assert.equal(mcpResponse.status, 200);
  assert.equal(mcp.result.structuredContent.products[0].mode, "synthetic_local_sandbox");
  assert.equal(mcp.result.structuredContent.products[0].purchasable, false);
} finally {
  await sandbox.close();
}

console.log("PASS: copyable recipes and JavaScript starter");
