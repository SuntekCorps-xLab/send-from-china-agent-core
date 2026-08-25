import assert from "node:assert/strict";
import test from "node:test";
import { createSendFromChinaClient, resolvePurchaseHandoff, SendFromChinaError } from "../src/index.js";

function response(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
}

function toolResult(id, value, isError = false) {
  return response({ jsonrpc: "2.0", id, result: { structuredContent: value, isError } });
}

test("discovers public capabilities without sending the tenant token", async () => {
  let seen;
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "secret-not-for-output",
    fetch: async (url, init) => {
      seen = { url, headers: new Headers(init.headers) };
      return response({ service: "send-from-china-agent-core", capabilities: { catalog_search: true } });
    },
  });
  const capabilities = await client.getCapabilities();
  assert.equal(capabilities.capabilities.catalog_search, true);
  assert.equal(seen.url, "https://agent.example.test/.well-known/send-from-china.json");
  assert.equal(seen.headers.has("authorization"), false);
});

test("calls MCP tools with bearer authentication and returns structured content", async () => {
  let seen;
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test/", token: "tenant_test_token",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      seen = { url, init, body };
      return toolResult(body.id, { status: "catalog_match", count: 2 });
    },
  });
  assert.deepEqual(await client.productSearch({ query: "desk organizer", limit: 2 }), {
    status: "catalog_match", count: 2,
  });
  assert.equal(seen.url, "https://agent.example.test/mcp");
  assert.equal(new Headers(seen.init.headers).get("authorization"), "Bearer tenant_test_token");
  assert.equal(seen.body.params.name, "product_search");
});

test("returns safe tool errors without reflecting credentials or upstream messages", async () => {
  const token = "credential-that-must-not-leak";
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token,
    fetch: async (_url, init) => toolResult(JSON.parse(init.body).id, { error: "FREE_PREVIEW_DAILY_LIMIT" }, true),
  });
  await assert.rejects(client.createSourcingTask({}), (error) => {
    assert.ok(error instanceof SendFromChinaError);
    assert.equal(error.code, "FREE_PREVIEW_DAILY_LIMIT");
    assert.equal(String(error).includes(token), false);
    return true;
  });
});

test("polls sourcing to a terminal state and emits only status changes", async () => {
  const states = ["QUEUED", "QUEUED", "SOURCING", "RESULTS_READY"];
  const observed = [];
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (_url, init) => toolResult(JSON.parse(init.body).id, {
      task: { id: "task_1", status: states.shift() },
    }),
  });
  const task = await client.waitForSourcingTask("task_1", {
    pollIntervalMs: 1, timeoutMs: 2_000, onStatus: (value) => observed.push(value.status),
  });
  assert.equal(task.status, "RESULTS_READY");
  assert.deepEqual(observed, ["QUEUED", "SOURCING", "RESULTS_READY"]);
});

test("collects paginated sourcing results", async () => {
  const pages = [
    { results: [{ id: "one" }], next_cursor: "next" },
    { results: [{ id: "two" }], next_cursor: null },
  ];
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (_url, init) => toolResult(JSON.parse(init.body).id, pages.shift()),
  });
  assert.deepEqual(await client.listAllSourcingResults("task_1"), [{ id: "one" }, { id: "two" }]);
});

test("allows only explicit customer-facing commerce origins", () => {
  const product = {
    checkout_url: "https://supplier.example/secret-order",
    add_to_cart_url: "https://shop.example/cart/add?id=1",
    product_url: "https://shop.example/products/item",
  };
  assert.deepEqual(resolvePurchaseHandoff(product, { commerceOrigins: ["https://shop.example"] }), {
    kind: "add_to_cart", url: "https://shop.example/cart/add?id=1", requires_user: true,
  });
  assert.equal(resolvePurchaseHandoff(product, { commerceOrigins: ["https://different.example"] }), null);
  assert.equal(resolvePurchaseHandoff({ product_url: "http://shop.example/products/item" }, {
    commerceOrigins: ["https://shop.example"],
  }), null);
  assert.equal(resolvePurchaseHandoff({ product_url: "https://user:pass@shop.example/products/item" }, {
    commerceOrigins: ["https://shop.example"],
  }), null);
});

test("rejects insecure non-local service URLs", () => {
  assert.throws(() => createSendFromChinaClient({ baseUrl: "http://agent.example.test" }), /HTTPS/);
  assert.doesNotThrow(() => createSendFromChinaClient({ baseUrl: "http://127.0.0.1:8787" }));
});

test("rejects service URLs with embedded request state or credentials", () => {
  assert.throws(() => createSendFromChinaClient({ baseUrl: "https://user:pass@agent.example.test" }), /credentials/);
  assert.throws(() => createSendFromChinaClient({ baseUrl: "https://agent.example.test?tenant=one" }), /query/);
  assert.throws(() => createSendFromChinaClient({ baseUrl: "https://agent.example.test#tools" }), /fragment/);
});

test("removes polling abort listeners after a successful wait", async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(name, listener) {
      assert.equal(name, "abort");
      listeners.add(listener);
    },
    removeEventListener(name, listener) {
      assert.equal(name, "abort");
      listeners.delete(listener);
    },
  };
  const states = ["QUEUED", "RESULTS_READY"];
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (_url, init) => toolResult(JSON.parse(init.body).id, {
      task: { id: "task_1", status: states.shift() },
    }),
  });
  const task = await client.waitForSourcingTask("task_1", {
    signal, pollIntervalMs: 1, timeoutMs: 2_000,
  });
  assert.equal(task.status, "RESULTS_READY");
  assert.equal(listeners.size, 0);
});
