import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { resetDemoSourcingState } from "../src/sourcing.js";
import { resetTenantState } from "../src/tenant.js";
import { ALPHA_KEY, ENV, authorization } from "./test-env.js";

beforeEach(() => { resetDemoSourcingState(); resetTenantState(); });

async function mcp(name, args = {}, key = ALPHA_KEY) {
  const response = await worker.fetch(new Request("https://worker.example/mcp", {
    method: "POST", headers: { ...authorization(key), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), ENV);
  return { response, body: await response.json() };
}

function request(overrides = {}) {
  return {
    query: "a walnut desk organizer with cable management",
    criteria: { category: "office storage", materials: ["walnut"], must_have: ["cable management"], price_max: 40, ship_to: "US" },
    plan_id: "preview", idempotency_key: "fixture-request:walnut-organizer:001", ...overrides,
  };
}

test("product search reaches a truthful terminal catalog miss", async () => {
  const { body } = await mcp("product_search", { query: "zirconium telescope mount", criteria: { category: "astronomy", ship_to: "US" }, operation: "confirm_search" });
  const result = body.result.structuredContent;
  assert.equal(result.status, "no_match");
  assert.equal(result.exhaustive, true);
  assert.equal(result.dynamic_request_recommended, true);
});

test("agent access exposes tenant scope and no transactional permission", async () => {
  const access = (await mcp("get_agent_access")).body.result.structuredContent;
  assert.equal(access.agent.tenant_id, "tenant_alpha");
  assert.deepEqual(access.transactional_permissions, { cart: false, checkout: false, order: false, payment: false });
});

test("identical sourcing submissions reuse one task and conflicting reuse fails", async () => {
  const first = await mcp("create_sourcing_task", request());
  const second = await mcp("create_sourcing_task", request());
  assert.equal(first.body.result.structuredContent.idempotent, false);
  assert.equal(second.body.result.structuredContent.idempotent, true);
  assert.equal(first.body.result.structuredContent.task.id, second.body.result.structuredContent.task.id);
  const conflict = await mcp("create_sourcing_task", request({ query: "a different request" }));
  assert.equal(conflict.body.result.structuredContent.error, "IDEMPOTENCY_CONFLICT");
});

test("task status and paginated previews preserve the non-commerce boundary", async () => {
  const created = await mcp("create_sourcing_task", request());
  const taskId = created.body.result.structuredContent.task.id;
  const task = (await mcp("get_sourcing_task", { task_id: taskId })).body.result.structuredContent.task;
  assert.deepEqual(task.status_history, ["QUEUED", "SOURCING", "GOVERNING", "RESULTS_READY"]);
  const results = (await mcp("list_sourcing_results", { task_id: taskId })).body.result.structuredContent.results;
  assert.ok(results.length > 0 && results.length <= 3);
  for (const result of results) {
    assert.equal(result.purchasable, false);
    assert.equal(result.product_url, null);
    assert.equal(result.add_to_cart_url, null);
  }
});

test("preview input requires destination, structured intent, stable key, and free plan", async () => {
  assert.equal((await mcp("create_sourcing_task", request({ plan_id: "focused" }))).body.result.structuredContent.error, "DEMO_PREVIEW_ONLY");
  assert.equal((await mcp("create_sourcing_task", request({ criteria: { category: "office" }, idempotency_key: "fixture-request:no-destination" }))).body.result.structuredContent.error, "SOURCING_DESTINATION_REQUIRED");
});
