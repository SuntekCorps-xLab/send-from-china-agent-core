import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { resetTenantState } from "../src/tenant.js";
import { ALPHA_KEY, ENV, INTERNAL_KEY, authorization } from "./test-env.js";

beforeEach(() => resetTenantState());

function call(path, options = {}, env = ENV) {
  return worker.fetch(new Request(`https://worker.example${path}`, options), env);
}

test("health exposes snapshot freshness without requiring a credential", async () => {
  const response = await call("/health");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.mode, "published_snapshot_gateway");
  assert.equal(body.writes_enabled, false);
  assert.equal(body.product_count, 12);
  assert.match(body.catalog_generated_at, /^\d{4}-/);
});

test("well-known metadata states authentication and unsupported transaction capabilities", async () => {
  const response = await call("/.well-known/send-from-china.json");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mcp.discovery_auth_required, false);
  assert.equal(body.mcp.tool_auth, "bearer_tenant_key");
  assert.equal(body.registration.self_service, false);
  assert.equal(body.version, "1.1.0");
  assert.equal(body.capabilities.catalog_estimate, true);
  assert.equal(body.capabilities.search_contract_v2, true);
  assert.equal(body.capabilities.shipping_rates, false);
  assert.equal(body.capabilities.order, false);
});

test("authorized catalog output uses only public snapshot fields", async () => {
  const response = await call("/api/catalog?limit=2", { headers: authorization(INTERNAL_KEY) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 2);
  for (const product of body.items) {
    assert.match(product.public_id, /^[A-Za-z0-9]{22}$/);
    assert.match(product.as_of, /^\d{4}-/);
    assert.equal("id" in product, false);
    assert.equal("handle" in product, false);
  }
  assert.ok(body.next_cursor);
});

test("catalog cursor paginates without overlap", async () => {
  const headers = authorization(INTERNAL_KEY);
  const first = await (await call("/api/catalog?limit=5", { headers })).json();
  const second = await (await call(`/api/catalog?limit=5&cursor=${first.next_cursor}`, { headers })).json();
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.public_id)).size, 10);
});

test("search validates inputs and returns ranked tenant matches", async () => {
  const headers = authorization(ALPHA_KEY);
  assert.equal((await call("/api/search", { headers })).status, 400);
  const response = await call("/api/search?q=desk%20organizer", { headers });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items[0].slug, "modular-desk-organizer");
});

test("Search Contract v2 delegates to the existing catalog kernel", async () => {
  const response = await call("/api/search/v2", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({
      contract_version: "2.0",
      product_identity: {
        name: "product_identity", value: "desk organizer", source: "explicit", scope: "product", hardness: "hard",
      },
      hard_constraints: [],
      soft_context: [{
        name: "recipient", value: "friend", source: "explicit", scope: "session", hardness: "soft",
      }],
      transaction_context: [], limit: 20, cursor: null,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.contract_version, "2.0");
  assert.equal(body.status, "results");
  assert.equal(body.results[0].slug, "modular-desk-organizer");
  assert.equal(body.relaxations[0].condition, "recipient");
  assert.equal(body.trace_id, response.headers.get("x-request-id"));
});

test("Search Contract v2 reports truthful terminal and degraded states", async () => {
  const headers = { ...authorization(ALPHA_KEY), "Content-Type": "application/json" };
  const request = {
    contract_version: "2.0", product_identity: {
      name: "product_identity", value: "product that is absent from the fixture",
      source: "explicit", scope: "product", hardness: "hard",
    },
    hard_constraints: [], soft_context: [], transaction_context: [], limit: 5, cursor: null,
  };
  const terminal = await call("/api/search/v2", { method: "POST", headers, body: JSON.stringify(request) });
  const body = await terminal.json();
  assert.equal(terminal.status, 200);
  assert.equal(body.status, "no_match");
  assert.equal(body.search_scope.plan_complete, true);
  assert.equal(body.search_scope.scope_exhausted, true);
  assert.equal(body.search_scope.global_catalog_exhaustive, false);
  assert.equal(body.search_scope.degraded, false);
  assert.deepEqual(body.results, []);
});

test("Search Contract v2 validates requests and requires authentication", async () => {
  const missingCredential = await call("/api/search/v2", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(missingCredential.status, 401);
  const invalid = await call("/api/search/v2", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_SEARCH_CONTRACT");
  const shorthand = await call("/api/search/v2", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ product_identity: "desk organizer", unexpected: "must not be ignored" }),
  });
  assert.equal(shorthand.status, 400);
  assert.equal((await shorthand.json()).error.code, "INVALID_SEARCH_CONTRACT");
  const oversized = await call("/api/search/v2", {
    method: "POST",
    headers: {
      ...authorization(ALPHA_KEY), "Content-Type": "application/json", "Content-Length": "40000",
    },
    body: "{}",
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("Search Contract v2 cursors are bound to the normalized intent", async () => {
  const headers = { ...authorization(INTERNAL_KEY), "Content-Type": "application/json" };
  const request = (identity, cursor = null) => ({
    contract_version: "2.0",
    product_identity: {
      name: "product_identity", value: identity, source: "explicit", scope: "product", hardness: "hard",
    },
    hard_constraints: [], soft_context: [], transaction_context: [], limit: 1, cursor,
  });
  const firstResponse = await call("/api/search/v2", {
    method: "POST", headers, body: JSON.stringify(request("a")),
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.match(first.pagination.next_cursor, /^sc2_[0-9a-f]{16}_/);

  const nextResponse = await call("/api/search/v2", {
    method: "POST", headers, body: JSON.stringify(request("a", first.pagination.next_cursor)),
  });
  assert.equal(nextResponse.status, 200);
  assert.equal((await nextResponse.json()).status, "results");

  const wrongIntent = await call("/api/search/v2", {
    method: "POST", headers, body: JSON.stringify(request("desk organizer", first.pagination.next_cursor)),
  });
  assert.equal(wrongIntent.status, 400);
  assert.equal((await wrongIntent.json()).error.code, "INVALID_SEARCH_CONTRACT");
});

test("Search Contract v2 reports global scope only for full-catalog tenants", async () => {
  const headers = { ...authorization(INTERNAL_KEY), "Content-Type": "application/json" };
  const response = await call("/api/search/v2", {
    method: "POST", headers,
    body: JSON.stringify({
      contract_version: "2.0",
      product_identity: {
        name: "product_identity", value: "absent fixture product",
        source: "explicit", scope: "product", hardness: "hard",
      },
      hard_constraints: [], soft_context: [], transaction_context: [], limit: 20, cursor: null,
    }),
  });
  const body = await response.json();
  assert.equal(body.status, "no_match");
  assert.equal(body.search_scope.global_catalog_exhaustive, true);
});

test("product lookup validates slugs and reports missing products", async () => {
  const headers = authorization(ALPHA_KEY);
  assert.equal((await call("/api/products/modular-desk-organizer", { headers })).status, 200);
  assert.equal((await call("/api/products/missing", { headers })).status, 404);
  assert.equal((await call("/api/products/not%20valid", { headers })).status, 400);
});

test("chat remains deterministic and read-only", async () => {
  const response = await call("/api/chat", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "desk storage" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "deterministic_fixture");
  assert.equal(body.products[0].slug, "modular-desk-organizer");
});

test("chat applies browser-supplied structured criteria as hard filters", async () => {
  const response = await call("/api/chat", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "desk organizer" }],
      criteria: { category: "Office", price_max: 15, ship_to: "US" },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.products, []);
  assert.equal(body.dynamic_request_recommended, true);
  assert.deepEqual(body.criteria_evaluation.informational, ["ship_to"]);
});

test("invalid and oversized JSON fail closed", async () => {
  const headers = { ...authorization(ALPHA_KEY), "Content-Type": "application/json" };
  assert.equal((await call("/api/chat", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await call("/api/chat", { method: "POST", headers: { ...headers, "Content-Length": "40000" }, body: "{}" })).status, 413);
});

test("CORS allowlist accepts known origins and rejects unknown origins", async () => {
  const allowed = await call("/health", { headers: { Origin: "https://app.example.com" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
  const denied = await call("/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
});

test("MCP discovery is public and catalog calls are tenant-scoped", async () => {
  const list = await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const listBody = await list.json();
  assert.deepEqual(listBody.result.tools.map((tool) => tool.name), [
    "product_search", "search_catalog", "get_product", "get_quote", "get_agent_access",
    "create_sourcing_task", "get_sourcing_task", "list_sourcing_results",
  ]);
  const search = await call("/mcp", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_catalog", arguments: { query: "garden" } } }),
  });
  assert.equal((await search.json()).result.structuredContent.items[0].slug, "compact-garden-trowel");
});

test("responses do not contain private commerce fields", async () => {
  const response = await call("/api/search?q=desk", { headers: authorization(ALPHA_KEY) });
  const text = await response.text();
  assert.doesNotMatch(text, /supplier_name|internal_product_id|warehouse_code|margin_rate|source_url|cost_price|api_key|"source"/i);
});
