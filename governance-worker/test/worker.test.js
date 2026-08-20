import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const ENV = { ALLOWED_ORIGINS: "https://app.example.com,http://localhost:8787" };

async function call(path, options = {}, env = ENV) {
  return worker.fetch(new Request(`https://worker.example${path}`, options), env);
}

test("health distinguishes production writes from the optional synthetic sourcing demo", async () => {
  const response = await call("/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id"), /.+/);
  assert.deepEqual(await response.json(), {
    ok: true,
    mode: "synthetic_demo",
    writes_enabled: false,
    sourcing_demo_enabled: false,
    sourcing_state: "ephemeral_synthetic",
  });
});

test("catalog exposes only synthetic non-purchasable products", async () => {
  const response = await call("/api/catalog?limit=2");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 2);
  for (const product of body.items) {
    assert.equal(product.source, "synthetic_demo");
    assert.equal(product.availability, "demo_only");
    assert.equal(product.purchasable, false);
  }
  assert.ok(body.next_cursor);
});

test("catalog cursor paginates without overlap", async () => {
  const first = await (await call("/api/catalog?limit=2")).json();
  const second = await (await call(`/api/catalog?limit=2&cursor=${first.next_cursor}`)).json();
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
  assert.equal(second.next_cursor, null);
});

test("search validates inputs and returns ranked matches", async () => {
  assert.equal((await call("/api/search")).status, 400);
  assert.equal((await call("/api/search?q=desk&limit=999")).status, 400);
  const response = await call("/api/search?q=desk%20organizer");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items[0].handle, "demo-desk-organizer");
});

test("product lookup validates handles and reports missing products", async () => {
  assert.equal((await call("/api/products/demo-desk-organizer")).status, 200);
  assert.equal((await call("/api/products/missing")).status, 404);
  assert.equal((await call("/api/products/not%20valid")).status, 400);
});

test("chat is deterministic and never claims a live model", async () => {
  const response = await call("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "desk storage" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "deterministic_demo");
  assert.equal(body.products[0].handle, "demo-desk-organizer");
  assert.equal(body.next_actions.length, 3);
});

test("invalid and oversized JSON fail closed", async () => {
  const invalid = await call("/api/chat", { method: "POST", body: "{" });
  assert.equal(invalid.status, 400);
  const oversized = await call("/api/chat", {
    method: "POST",
    headers: { "Content-Length": "40000" },
    body: "{}",
  });
  assert.equal(oversized.status, 413);
});

test("CORS allowlist accepts known origins and rejects unknown origins", async () => {
  const allowed = await call("/health", { headers: { Origin: "https://app.example.com" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
  const denied = await call("/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("MCP lists bounded catalog tools and explicit synthetic sourcing tools", async () => {
  const list = await call("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const listBody = await list.json();
  assert.deepEqual(listBody.result.tools.map((tool) => tool.name), [
    "product_search",
    "search_catalog",
    "get_product",
    "get_agent_access",
    "create_sourcing_task",
    "get_sourcing_task",
    "list_sourcing_results",
  ]);
  assert.deepEqual(
    listBody.result.tools.find((tool) => tool.name === "create_sourcing_task").inputSchema.properties.plan_id.enum,
    ["preview"],
  );

  const search = await call("/mcp", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_catalog", arguments: { query: "garden", limit: 2 } },
    }),
  });
  const searchBody = await search.json();
  assert.equal(searchBody.result.structuredContent.items[0].handle, "demo-garden-trowel");
  assert.equal(searchBody.result.isError, false);
});

test("MCP rejects unknown tools and malformed requests", async () => {
  const unknown = await call("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_order" } }),
  });
  assert.equal(unknown.status, 404);
  const malformed = await call("/mcp", { method: "POST", body: JSON.stringify({ id: 4 }) });
  assert.equal(malformed.status, 400);
});

test("responses do not contain credential or private-integration fields", async () => {
  const response = await call("/api/catalog");
  const text = await response.text();
  assert.doesNotMatch(text, /token|secret|password|customer|address|phone/i);
});
