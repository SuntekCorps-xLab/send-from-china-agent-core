import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createSandboxServer, startSandbox } from "../server.mjs";

let sandbox;

before(async () => {
  sandbox = await startSandbox({ port: 0 });
});

after(async () => {
  await sandbox?.close();
});

async function json(path, init = {}) {
  const response = await fetch(`${sandbox.baseUrl}${path}`, init);
  return { response, body: await response.json() };
}

function authHeaders() {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${sandbox.token}`);
  return headers;
}

async function sandboxTool(id, name, args) {
  return json("/sandbox/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

test("the server factory refuses missing and non-loopback listen addresses", () => {
  const missingHost = createSandboxServer();
  assert.throws(() => missingHost.listen(0), /explicit loopback/);

  const unspecifiedV4 = createSandboxServer();
  assert.throws(() => unspecifiedV4.listen(0, ["0", "0", "0", "0"].join(".")), /explicit loopback/);

  const unspecifiedV6 = createSandboxServer();
  assert.throws(() => unspecifiedV6.listen({ port: 0, host: "::" }), /explicit loopback/);
});

test("the page and status expose boundaries but never the ephemeral token", async () => {
  assert.match(sandbox.token, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(sandbox.browserCredentialExposed, false);

  const pageResponse = await fetch(`${sandbox.baseUrl}/sandbox`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Run the real guarded contract/);
  assert.match(page, /No carrier rates/);
  assert.doesNotMatch(page, new RegExp(sandbox.token, "u"));

  const statusResponse = await fetch(`${sandbox.baseUrl}/sandbox/status`);
  const statusText = await statusResponse.text();
  const status = JSON.parse(statusText);
  assert.deepEqual(status, {
    mode: "synthetic_local_sandbox",
    data_source: "synthetic_fixture",
    purchasable: false,
    shipping_rates: false,
    commerce_writes: false,
    credential_exposed: false,
  });
  assert.equal(statusResponse.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");
  assert.doesNotMatch(statusText, new RegExp(sandbox.token, "u"));
});

test("canonical routes retain bearer authentication", async () => {
  const denied = await json("/api/search?q=desk");
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.error.code, "MISSING_CREDENTIAL");

  const allowed = await json("/api/search?q=desk&limit=3", { headers: authHeaders() });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.items[0].slug, "modular-desk-organizer");
  assert.equal(allowed.body.items[0].availability_band, "in_stock");
  assert.equal(allowed.body.items[0].purchasable, true);
  assert.match(allowed.body.items[0].images[0].url, /^https:\/\//);
  assert.equal(allowed.response.headers.get("x-send-from-china-sandbox-mode"), null);

  const enumeration = await json("/api/catalog", { headers: authHeaders() });
  assert.equal(enumeration.response.status, 403);
  assert.equal(enumeration.body.error.code, "ENUMERATION_NOT_ALLOWED");
});

test("the browser-safe HTTP wrapper injects scope and applies a conservative projection", async () => {
  const search = await json("/sandbox/api/search?q=desk&limit=3");
  const text = JSON.stringify(search.body);
  assert.equal(search.response.status, 200);
  assert.equal(search.body.items.length, 1);
  assert.equal(search.body.items[0].slug, "modular-desk-organizer");
  assert.equal(search.body.mode, "synthetic_local_sandbox");
  assert.equal(search.body.illustrative_only, true);
  assert.equal(search.body.purchasable, false);
  assert.equal(search.body.items[0].availability_band, "demo_only");
  assert.equal(search.body.items[0].purchasable, false);
  assert.equal(search.body.items[0].available, false);
  assert.deepEqual(search.body.items[0].images, []);
  assert.equal(search.response.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");
  assert.match(search.response.headers.get("x-send-from-china-sandbox-boundary"), /no-commerce-writes/);
  assert.doesNotMatch(text, new RegExp(sandbox.token, "u"));
  assert.doesNotMatch(text, /supplier_name|internal_product_id|warehouse_code|cost_price|api_key|"source"/iu);

  const v2 = await json("/sandbox/api/search/v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_version: "2.0",
      product_identity: {
        name: "product_identity", value: "desk organizer", source: "explicit", scope: "product", hardness: "hard",
      },
      hard_constraints: [],
      soft_context: [],
      transaction_context: [],
      limit: 3,
      cursor: null,
    }),
  });
  assert.equal(v2.response.status, 200);
  assert.equal(v2.body.contract_version, "2.0");
  assert.equal(v2.body.results[0].slug, "modular-desk-organizer");
  assert.equal(v2.body.mode, "synthetic_local_sandbox");
  assert.equal(v2.body.results[0].availability_band, "demo_only");
  assert.equal(v2.body.results[0].purchasable, false);
  assert.doesNotMatch(JSON.stringify(v2.body), new RegExp(sandbox.token, "u"));

  const product = await json("/sandbox/api/products/modular-desk-organizer");
  assert.equal(product.response.status, 200);
  assert.equal(product.body.product.availability_band, "demo_only");
  assert.equal(product.body.product.purchasable, false);
  assert.equal(product.body.product.available, false);
  assert.deepEqual(product.body.product.images, []);

  const quote = await json("/sandbox/api/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      public_id: "A1b2C3d4E5f6G7h8J9k0Lm", quantity: 1, ship_to: "US",
    }),
  });
  assert.equal(quote.response.status, 200);
  assert.equal(quote.body.mode, "synthetic_local_sandbox");
  assert.equal(quote.body.availability, "demo_only");
  assert.equal(quote.body.binding, false);
  assert.equal(quote.body.purchasable, false);
  assert.equal(quote.body.available, false);

  const chat = await json("/sandbox/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "desk organizer" }] }),
  });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.body.mode, "synthetic_local_sandbox");
  assert.equal(chat.body.products[0].availability_band, "demo_only");
  assert.equal(chat.body.products[0].purchasable, false);
  assert.doesNotMatch(JSON.stringify({ search: search.body, product: product.body, quote: quote.body, chat: chat.body }), /https?:\/\//iu);
});

test("sandbox discovery points agents at the injected-scope MCP route", async () => {
  const canonical = await json("/.well-known/send-from-china.json");
  assert.equal(canonical.body.mcp.path, "/mcp");
  assert.equal(canonical.body.mcp.tool_auth, "bearer_tenant_key");
  assert.equal(canonical.body.mode, "self_hosted_reference");

  const discovery = await json("/sandbox/.well-known/send-from-china.json");
  assert.equal(discovery.body.mode, "synthetic_local_sandbox");
  assert.equal(discovery.body.mcp.path, "/sandbox/mcp");
  assert.equal(discovery.body.mcp.tool_auth, "local_server_injected_ephemeral_scope");
  assert.equal(discovery.body.registration.required, false);
  assert.equal(discovery.body.canonical_deployment.mcp_path, "/mcp");
  assert.equal(discovery.body.canonical_deployment.tool_auth, "bearer_tenant_key");
  assert.equal(discovery.body.purchasable, false);
  assert.doesNotMatch(JSON.stringify(discovery.body), new RegExp(sandbox.token, "u"));

  const initialize = await json("/sandbox/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize" }),
  });
  assert.equal(initialize.response.status, 200);
  assert.equal(initialize.body.result.sandbox.mcp_path, "/sandbox/mcp");
  assert.equal(initialize.body.result.sandbox.tool_auth, "local_server_injected_ephemeral_scope");
  assert.equal(initialize.body.result.sandbox.canonical_deployment.tool_auth, "bearer_tenant_key");
  assert.match(initialize.body.result.instructions, /without supplying a tenant credential/);
  assert.match(initialize.body.result.instructions, /canonical \/mcp deployment still requires a bearer/iu);
  assert.doesNotMatch(JSON.stringify(initialize.body), new RegExp(sandbox.token, "u"));
});

test("the wrapper rejects enumeration, arbitrary proxies, invalid JSON, and large bodies", async () => {
  const enumeration = await json("/sandbox/api/catalog");
  assert.equal(enumeration.response.status, 404);
  assert.equal(enumeration.response.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");
  assert.equal((await json("/sandbox/api/unknown")).response.status, 404);

  const invalid = await json("/sandbox/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_JSON");

  const oversized = await json("/sandbox/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(33 * 1024) }] }),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("MCP discovery and guarded tool calls work without a browser credential", async () => {
  const discovery = await json("/sandbox/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
  });
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.body.result.tools.length, 8);
  assert.equal(discovery.response.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");

  const denied = await json("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "denied", method: "tools/call",
      params: { name: "product_search", arguments: { query: "desk" } },
    }),
  });
  assert.equal(denied.body.result.structuredContent.error, "MISSING_CREDENTIAL");

  const search = await sandboxTool("search", "product_search", {
    query: "desk organizer",
    criteria: { price_max: 40 },
    operation: "search",
    limit: 3,
  });
  assert.equal(search.response.status, 200);
  assert.equal(search.body.result.structuredContent.products[0].slug, "modular-desk-organizer");
  assert.equal(search.body.result.structuredContent.products[0].availability_band, "demo_only");
  assert.equal(search.body.result.structuredContent.products[0].purchasable, false);
  assert.equal(search.body.result.structuredContent.products[0].available, false);
  assert.equal(
    search.body.result.content[0].text,
    JSON.stringify(search.body.result.structuredContent),
  );
  assert.doesNotMatch(search.body.result.content[0].text, /https?:\/\//iu);
  assert.doesNotMatch(JSON.stringify(search.body), new RegExp(sandbox.token, "u"));
});

test("sourcing requires a terminal proof and explicit confirmation and remains illustrative", async () => {
  const query = "custom walnut desk organizer with cable management";
  const criteria = {
    category: "office storage",
    materials: ["walnut"],
    must_have: ["cable management"],
    price_max: 40,
    ship_to: "US",
  };
  const search = await sandboxTool("confirmed-search", "product_search", {
    query, criteria, operation: "confirm_search", limit: 5,
  });
  const proof = search.body.result.structuredContent;
  assert.equal(proof.status, "no_match");
  assert.equal(proof.search_scope_exhausted, true);
  assert.match(proof.search_id, /^search_demo_/);

  const unconfirmed = await sandboxTool("unconfirmed", "create_sourcing_task", {
    query, criteria, search_id: proof.search_id, confirmed: false,
    plan_id: "preview", idempotency_key: "sandbox-preview:unconfirmed",
  });
  assert.equal(unconfirmed.body.result.structuredContent.error, "USER_CONFIRMATION_REQUIRED");

  const created = await sandboxTool("create", "create_sourcing_task", {
    query, criteria, search_id: proof.search_id, confirmed: true,
    plan_id: "preview", idempotency_key: "sandbox-preview:confirmed-001",
  });
  const task = created.body.result.structuredContent.task;
  assert.equal(task.mode, "synthetic_local_sandbox");
  assert.equal(task.illustrative_only, true);
  assert.equal(task.billable, false);
  assert.equal(task.status, "RESULTS_READY");

  const listed = await sandboxTool("results", "list_sourcing_results", { task_id: task.id, limit: 3 });
  const results = listed.body.result.structuredContent.results;
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.match_status === "illustrative_only"));
  assert.ok(results.every((result) => result.purchasable === false && result.available === false));
  assert.ok(results.every((result) => !("product_url" in result) && !("add_to_cart_url" in result)));
});
