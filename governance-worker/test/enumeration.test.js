import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import fixture from "../../fixtures/published-catalog.sample.json" with { type: "json" };
import { setCatalogSource } from "../src/catalog.js";
import { resetTenantState } from "../src/tenant.js";
import { ALPHA_KEY, ENV, INTERNAL_KEY, authorization } from "./test-env.js";

beforeEach(() => resetTenantState());

function call(path, options = {}, env = ENV) {
  return worker.fetch(new Request(`https://worker.example${path}`, options), env);
}

test("a restricted tenant cannot enumerate the whole catalog", async () => {
  const response = await call("/api/catalog", { headers: authorization(ALPHA_KEY) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ENUMERATION_NOT_ALLOWED");
});

test("an explicitly configured internal test tenant can list its bounded snapshot", async () => {
  const response = await call("/api/catalog?limit=5", { headers: authorization(INTERNAL_KEY) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 5);
  assert.ok(body.next_cursor);
});

test("tenant page size applies equally to HTTP and MCP", async () => {
  const http = await call("/api/search?q=tool&limit=6", { headers: authorization(ALPHA_KEY) });
  assert.equal(http.status, 400);
  const mcp = await call("/mcp", {
    method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_catalog", arguments: { query: "tool", limit: 6 } } }),
  });
  assert.equal(mcp.status, 400);
});

test("daily quota returns 429 and Retry-After", async () => {
  const limitedEnv = {
    ...ENV,
    TENANT_KEYS: JSON.stringify({ key_test_quota_1234567890: {
      tenant_id: "tenant_alpha", max_page_size: 5, daily_quota: 2,
    } }),
  };
  const options = { headers: authorization("key_test_quota_1234567890") };
  assert.equal((await call("/api/search?q=desk", options, limitedEnv)).status, 200);
  assert.equal((await call("/api/search?q=desk", options, limitedEnv)).status, 200);
  const blocked = await call("/api/search?q=desk", options, limitedEnv);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "QUOTA_EXCEEDED");
  assert.match(blocked.headers.get("retry-after"), /^\d+$/);
});

test("search stops issuing cursors after the bounded result window", async () => {
  const products = Array.from({ length: 205 }, (_, index) => ({
    public_id: `A${String(index).padStart(21, "0")}`,
    slug: `catalog-item-${index}`,
    title: `Catalog Item ${index}`,
    availability_band: "in_stock",
    source: "published_fixture",
    purchasable: true,
  }));
  setCatalogSource({
    schema_version: 1,
    generated_at: "2026-08-23T00:00:00Z",
    valid_until: "2030-08-24T00:00:00Z",
    products,
    tenant_scopes: {},
  });
  try {
    const headers = authorization(INTERNAL_KEY);
    const largePageEnv = {
      ...ENV,
      TENANT_KEYS: JSON.stringify({
        [INTERNAL_KEY]: {
          tenant_id: "tenant_internal",
          product_ids: null,
          price_tier: "test",
          allow_full_enumeration: true,
          max_page_size: 100,
          daily_quota: 100,
        },
      }),
    };
    const firstResponse = await call("/api/search?q=catalog&limit=100", { headers }, largePageEnv);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    const secondResponse = await call(
      `/api/search?q=catalog&limit=100&cursor=${first.next_cursor}`,
      { headers },
      largePageEnv,
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(first.truncated, true);
    assert.equal(second.truncated, true);
    assert.equal(second.items.length, 100);
    assert.equal(second.next_cursor, null);
  } finally {
    setCatalogSource(fixture);
  }
});
