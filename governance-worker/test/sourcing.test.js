import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { resetDemoSourcingState } from "../src/sourcing.js";

const TOKEN = "local-test-token-not-for-production";
const ENV = {
  ALLOWED_ORIGINS: "https://app.example.com",
  DEMO_AGENT_TOKEN: TOKEN,
};

beforeEach(() => resetDemoSourcingState());

async function mcp(name, args = {}, { token = TOKEN, env = ENV } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await worker.fetch(new Request("https://worker.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }), env);
  return { response, body: await response.json() };
}

function request(overrides = {}) {
  return {
    query: "a walnut desk organizer with cable management",
    criteria: {
      category: "office storage",
      materials: ["walnut"],
      must_have: ["cable management"],
      price_max: 40,
      ship_to: "US",
    },
    plan_id: "preview",
    idempotency_key: "fixture-request:walnut-organizer:001",
    ...overrides,
  };
}

test("product_search reaches a truthful terminal catalog miss", async () => {
  const { body } = await mcp("product_search", {
    query: "zirconium telescope mount",
    criteria: { category: "astronomy", ship_to: "US" },
    operation: "confirm_search",
  });
  const result = body.result.structuredContent;
  assert.equal(result.status, "no_match");
  assert.equal(result.count, 0);
  assert.equal(result.has_more, false);
  assert.equal(result.exhaustive, true);
  assert.equal(result.search_scope_exhausted, true);
  assert.equal(result.dynamic_request_recommended, true);
});

test("agent access exposes explicit scopes and no transactional permission", async () => {
  const { body } = await mcp("get_agent_access");
  const access = body.result.structuredContent;
  assert.deepEqual(access.agent.scopes, ["catalog:read", "sourcing:read", "sourcing:write"]);
  assert.deepEqual(access.transactional_permissions, {
    cart: false,
    checkout: false,
    order: false,
    payment: false,
  });
  assert.equal(access.preview_access.remaining_today, 3);
});

test("sourcing authentication fails closed when missing, invalid, or disabled", async () => {
  const missing = await mcp("get_agent_access", {}, { token: "" });
  assert.equal(missing.body.result.isError, true);
  assert.equal(missing.body.result.structuredContent.error, "INVALID_AGENT_TOKEN");

  const invalid = await mcp("get_agent_access", {}, { token: "wrong-token-value" });
  assert.equal(invalid.body.result.structuredContent.error, "INVALID_AGENT_TOKEN");

  const disabled = await mcp("get_agent_access", {}, { token: "", env: { ALLOWED_ORIGINS: "" } });
  assert.equal(disabled.body.result.structuredContent.error, "SOURCING_DEMO_DISABLED");
});

test("identical sourcing submissions reuse one task and conflicting reuse fails", async () => {
  const first = await mcp("create_sourcing_task", request());
  const second = await mcp("create_sourcing_task", request());
  assert.equal(first.body.result.isError, false);
  assert.equal(first.body.result.structuredContent.idempotent, false);
  assert.equal(second.body.result.structuredContent.idempotent, true);
  assert.equal(first.body.result.structuredContent.task.id, second.body.result.structuredContent.task.id);
  assert.doesNotMatch(JSON.stringify(first.body), /local-test-token-not-for-production/);
  assert.equal("idempotency_key" in first.body.result.structuredContent.task, false);

  const conflict = await mcp("create_sourcing_task", request({ query: "a different request" }));
  assert.equal(conflict.body.result.isError, true);
  assert.equal(conflict.body.result.structuredContent.error, "IDEMPOTENCY_CONFLICT");
});

test("task status and paginated governed previews preserve the non-commerce boundary", async () => {
  const created = await mcp("create_sourcing_task", request());
  const taskId = created.body.result.structuredContent.task.id;
  const task = (await mcp("get_sourcing_task", { task_id: taskId })).body.result.structuredContent.task;
  assert.equal(task.status, "RESULTS_READY");
  assert.deepEqual(task.status_history, ["QUEUED", "SOURCING", "GOVERNING", "RESULTS_READY"]);
  assert.equal(task.billable, false);
  assert.equal(task.durable, false);

  const first = (await mcp("list_sourcing_results", { task_id: taskId, limit: 2 })).body.result.structuredContent;
  const second = (await mcp("list_sourcing_results", {
    task_id: taskId,
    limit: 2,
    cursor: first.next_cursor,
  })).body.result.structuredContent;
  const results = [...first.results, ...second.results];
  assert.equal(results.length, 3);
  assert.equal(first.exhaustive, false);
  assert.equal(second.exhaustive, true);
  assert.equal(second.next_cursor, null);
  for (const result of results) {
    assert.equal(result.source, "synthetic_demo");
    assert.equal(result.purchasable, false);
    assert.equal(result.available, false);
    assert.equal(result.product_url, null);
    assert.equal(result.add_to_cart_url, null);
  }
});

test("preview input requires destination, structured intent, stable key, and free plan", async () => {
  const paid = await mcp("create_sourcing_task", request({ plan_id: "focused" }));
  assert.equal(paid.body.result.structuredContent.error, "DEMO_PREVIEW_ONLY");

  const noDestination = await mcp("create_sourcing_task", request({
    criteria: { category: "office storage" },
    idempotency_key: "fixture-request:no-destination",
  }));
  assert.equal(noDestination.body.result.structuredContent.error, "SOURCING_DESTINATION_REQUIRED");

  const noIntent = await mcp("create_sourcing_task", request({
    criteria: { ship_to: "US" },
    idempotency_key: "fixture-request:no-intent",
  }));
  assert.equal(noIntent.body.result.structuredContent.error, "SOURCING_INTENT_REQUIRED");

  const created = await mcp("create_sourcing_task", request());
  const taskId = created.body.result.structuredContent.task.id;
  const invalidLimit = await mcp("list_sourcing_results", { task_id: taskId, limit: 101 });
  assert.equal(invalidLimit.body.result.structuredContent.error, "INVALID_LIMIT");
});
