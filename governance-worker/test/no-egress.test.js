import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { resetDemoSourcingState } from "../src/sourcing.js";
import { resetTenantState } from "../src/tenant.js";
import { ALPHA_KEY, ENV, INTERNAL_KEY, authorization } from "./test-env.js";

function request(path, options = {}) {
  return worker.fetch(new Request(`https://worker.example${path}`, options), ENV);
}

function mcp(method, params, key = ALPHA_KEY) {
  const headers = { "Content-Type": "application/json" };
  if (key) Object.assign(headers, authorization(key));
  return request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("all HTTP routes and MCP tools execute with outbound fetch disabled", async () => {
  resetTenantState();
  resetDemoSourcingState();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("outbound request blocked by test"); };
  try {
    await request("/health");
    await request("/api/catalog?limit=2", { headers: authorization(INTERNAL_KEY) });
    await request("/api/search?q=desk", { headers: authorization(ALPHA_KEY) });
    await request("/api/products/modular-desk-organizer", { headers: authorization(ALPHA_KEY) });
    await request("/api/quote", { method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" }, body: JSON.stringify({ public_id: "A1b2C3d4E5f6G7h8J9k0Lm", quantity: 1, ship_to: "US" }) });
    await request("/api/chat", { method: "POST", headers: { ...authorization(ALPHA_KEY), "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "desk storage" }] }) });
    await mcp("initialize", undefined, "");
    await mcp("tools/list", undefined, "");
    await mcp("tools/call", { name: "product_search", arguments: { query: "desk" } });
    await mcp("tools/call", { name: "search_catalog", arguments: { query: "desk" } });
    await mcp("tools/call", { name: "get_product", arguments: { slug: "modular-desk-organizer" } });
    await mcp("tools/call", { name: "get_quote", arguments: { public_id: "A1b2C3d4E5f6G7h8J9k0Lm", quantity: 1, ship_to: "US" } });
    await mcp("tools/call", { name: "get_agent_access", arguments: {} });
    const created = await mcp("tools/call", { name: "create_sourcing_task", arguments: {
      query: "walnut desk organizer", criteria: { category: "office", ship_to: "US" },
      plan_id: "preview", idempotency_key: "fixture-request:no-egress:001",
    } });
    const taskId = (await created.json()).result.structuredContent.task.id;
    await mcp("tools/call", { name: "get_sourcing_task", arguments: { task_id: taskId } });
    await mcp("tools/call", { name: "list_sourcing_results", arguments: { task_id: taskId } });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
