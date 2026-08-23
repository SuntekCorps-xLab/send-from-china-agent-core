import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { resetTenantState, resolveTenant } from "../src/tenant.js";
import { ALPHA_KEY, BETA_KEY, ENV, authorization } from "./test-env.js";

beforeEach(() => resetTenantState());

function call(path, options = {}, env = ENV) {
  return worker.fetch(new Request(`https://worker.example${path}`, options), env);
}

test("a valid key resolves its bounded tenant scope", () => {
  const tenant = resolveTenant(`Bearer ${ALPHA_KEY}`, ENV);
  assert.equal(tenant.tenant_id, "tenant_alpha");
  assert.equal(tenant.allowed_product_ids.size, 5);
  assert.equal(tenant.allow_full_enumeration, false);
});

test("health and MCP discovery remain public while catalog data requires a key", async () => {
  assert.equal((await call("/health")).status, 200);
  assert.equal((await call("/api/search?q=desk")).status, 401);
  const list = await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).result.tools.length, 8);
});

test("invalid credentials fail closed", async () => {
  const response = await call("/api/search?q=desk", { headers: authorization("key_test_wrong_123456789") });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "INVALID_CREDENTIAL");
});

test("tenant scopes prevent cross-tenant product reads", async () => {
  const alpha = await call("/api/products/modular-desk-organizer", { headers: authorization(ALPHA_KEY) });
  const beta = await call("/api/products/modular-desk-organizer", { headers: authorization(BETA_KEY) });
  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 404);
});

test("unauthenticated MCP tool calls return a tool-level error", async () => {
  const response = await call("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_catalog", arguments: { query: "desk" } } }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.error, "MISSING_CREDENTIAL");
});
