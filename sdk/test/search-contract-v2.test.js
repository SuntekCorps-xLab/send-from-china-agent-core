import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  createSendFromChinaClient,
  normalizeSearchContractV2Request,
  parseSearchContractV2Request,
  SEARCH_CONTRACT_VERSION,
} from "../src/index.js";

const baseRequest = {
  contract_version: "2.0",
  product_identity: {
    name: "product_identity", value: "water bottle", source: "explicit", scope: "product", hardness: "hard",
  },
  hard_constraints: [], soft_context: [], transaction_context: [], limit: 20, cursor: null,
};

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function toolResult(id, value) {
  return response({ jsonrpc: "2.0", id, result: { structuredContent: value, isError: false } });
}

test("publishes strict v2 request and response schemas", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-request.schema.json", import.meta.url)));
  const responseSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-response.schema.json", import.meta.url)));
  assert.equal(requestSchema.properties.contract_version.const, "2.0");
  assert.deepEqual(requestSchema.properties.hard_constraints.items.allOf[1].properties.source, { const: "explicit" });
  assert.deepEqual(responseSchema.properties.status.enum, ["results", "needs_clarification", "no_match", "degraded"]);
  assert.ok(responseSchema.required.includes("trace_id"));
  assert.ok(responseSchema.required.includes("search_scope"));
  const noMatchScope = responseSchema.allOf[0].then.properties.search_scope.properties;
  assert.deepEqual(noMatchScope.scan_limit_reached, { const: false });
  assert.equal("source" in responseSchema.$defs.product.properties, false);
});

test("normalization demotes inferred filters and preserves explicit transaction context", () => {
  const request = normalizeSearchContractV2Request({
    product_identity: "desk",
    hard_constraints: [
      { name: "material", value: "wood", source: "explicit", scope: "product", hardness: "hard" },
      { name: "recipient", value: "friend", source: "inferred", scope: "session", hardness: "hard" },
    ],
    soft_context: [],
    transaction_context: [
      { name: "ship_to", value: "US", source: "explicit", scope: "transaction", hardness: "hard" },
      { name: "quantity", value: 1, source: "default", scope: "transaction", hardness: "hard" },
    ],
  });
  assert.equal(request.contract_version, SEARCH_CONTRACT_VERSION);
  assert.deepEqual(request.hard_constraints.map((item) => item.name), ["material"]);
  assert.deepEqual(request.soft_context.map((item) => [item.name, item.hardness]), [["recipient", "soft"]]);
  assert.deepEqual(request.transaction_context.map((item) => [item.name, item.hardness]), [
    ["ship_to", "hard"], ["quantity", "informational"],
  ]);
});

test("wire parser rejects SDK shorthand and unknown request fields", () => {
  assert.throws(() => parseSearchContractV2Request({ product_identity: "desk" }), /missing contract_version|unknown field/);
  assert.throws(() => parseSearchContractV2Request({ ...baseRequest, unexpected: true }), /unknown field/);
  assert.throws(() => parseSearchContractV2Request({
    ...baseRequest,
    soft_context: [{
      name: "ship_to", value: "US", source: "explicit", scope: "transaction", hardness: "soft",
    }],
  }), /soft_context/);
  assert.throws(() => parseSearchContractV2Request({
    ...baseRequest,
    transaction_context: [{
      name: "quantity", value: 1, source: "default", scope: "transaction", hardness: "hard",
    }],
  }), /transaction_context/);
  assert.deepEqual(parseSearchContractV2Request(baseRequest), normalizeSearchContractV2Request(baseRequest));
});

test("v1 adapter retrieves by product identity and maps only supported explicit constraints", () => {
  const adapted = adaptSearchContractV2RequestToV1({
    ...baseRequest,
    hard_constraints: [
      { name: "material", value: ["steel"], source: "explicit", scope: "product", hardness: "hard" },
      { name: "size", value: "large", source: "explicit", scope: "product", hardness: "hard" },
    ],
    soft_context: [
      { name: "recipient", value: "friend", source: "explicit", scope: "session", hardness: "soft" },
    ],
    transaction_context: [
      { name: "ship_to", value: "us", source: "explicit", scope: "transaction", hardness: "hard" },
    ],
  }, { operation: "confirm_search" });
  assert.equal(adapted.arguments.query, "water bottle");
  assert.deepEqual(adapted.arguments.criteria, { materials: ["steel"], ship_to: "US" });
  assert.equal(adapted.arguments.operation, "confirm_search");
  assert.deepEqual(adapted.relaxations.map((item) => item.condition), ["size", "recipient"]);
});

test("v1 response becomes no_match only with a complete non-truncated search proof", () => {
  const terminal = adaptSearchContractV1ResponseToV2({
    status: "no_match", products: [], exhaustive: true, search_scope_exhausted: true, truncated: false,
  }, { request: baseRequest, traceId: "trace-terminal" });
  assert.equal(terminal.status, "no_match");
  assert.equal(terminal.search_scope.scope_exhausted, true);

  const bounded = adaptSearchContractV1ResponseToV2({
    status: "no_match", products: [], exhaustive: true, search_scope_exhausted: true, truncated: true,
  }, { request: baseRequest, traceId: "trace-bounded" });
  assert.equal(bounded.status, "degraded");
  assert.equal(bounded.search_scope.scan_limit_reached, true);
});

test("v2 compatibility cursors cannot be reused with another intent", () => {
  const first = adaptSearchContractV1ResponseToV2({
    status: "catalog_match", products: [{ title: "Bottle" }], next_cursor: "legacy-page-2", has_more: true,
  }, { request: baseRequest, traceId: "trace-first" });
  assert.match(first.pagination.next_cursor, /^sc2_[0-9a-f]{16}_/);
  const next = adaptSearchContractV2RequestToV1({ ...baseRequest, cursor: first.pagination.next_cursor });
  assert.equal(next.arguments.cursor, "legacy-page-2");
  assert.throws(() => adaptSearchContractV2RequestToV1({
    ...baseRequest, product_identity: "desk", cursor: first.pagination.next_cursor,
  }), /cursor does not belong/);
});

test("v1 response adapter strips fields outside the public product presentation", () => {
  const result = adaptSearchContractV1ResponseToV2({
    status: "catalog_match", products: [{
      public_id: "A1b2C3d4E5f6G7h8J9k0Lm", title: "Steel Bottle", availability_band: "in_stock",
      price: { amount: 19, currency: "USD" }, source: "private-source",
      supplier_url: "not-public", cost_price: 1,
      attributes: {
        material: "steel", supplier_url: "https://supplier.invalid/item",
        nested: { api_key: "hidden" }, cost_price: 1,
      },
    }], exhaustive: false, search_scope_exhausted: false,
  }, { request: baseRequest, traceId: "trace-result" });
  assert.equal(result.status, "results");
  assert.equal(result.results.length, 1);
  assert.equal("supplier_url" in result.results[0], false);
  assert.equal("cost_price" in result.results[0], false);
  assert.equal("source" in result.results[0], false);
  assert.deepEqual(result.results[0].attributes, { material: "steel" });
});

test("v1 pagination never promises another page without a cursor", () => {
  const result = adaptSearchContractV1ResponseToV2({
    status: "catalog_match", products: [{ title: "Bottle" }], has_more: true, next_cursor: null,
  }, { request: baseRequest, traceId: "trace-incomplete-pagination" });
  assert.equal(result.pagination.has_more, false);
  assert.equal(result.pagination.next_cursor, null);
});

test("client calls the authenticated Search Contract v2 endpoint", async () => {
  let called;
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (url, init) => {
      called = { url, body: JSON.parse(init.body) };
      return response({
        contract_version: "2.0", trace_id: "trace-direct", status: "results",
        normalized_intent: {}, relaxations: [], missing_criteria: [], results: [{ title: "Compact Desk" }],
        pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
        search_scope: { plan_complete: false, scope_exhausted: false, global_catalog_exhaustive: false, scan_limit_reached: false, degraded: false },
      });
    },
  });
  const result = await client.searchContractV2({ ...baseRequest, product_identity: "compact desk" });
  assert.equal(called.url, "https://agent.example.test/api/search/v2");
  assert.equal(called.body.product_identity.value, "compact desk");
  assert.equal(result.contract_version, "2.0");
  assert.equal(result.status, "results");
});

test("client keeps the explicit v1 compatibility path", async () => {
  let called;
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (_url, init) => {
      const payload = JSON.parse(init.body);
      called = payload.params;
      return toolResult(payload.id, {
        search_id: "search_demo_public_trace_1234567890", status: "catalog_match",
        products: [{ title: "Compact Desk", availability_band: "in_stock" }], count: 1,
        exhaustive: false, search_scope_exhausted: false, has_more: false, next_cursor: null,
      });
    },
  });
  const result = await client.searchContractV2ViaV1({ ...baseRequest, product_identity: "compact desk" });
  assert.equal(called.name, "product_search");
  assert.equal(called.arguments.query, "compact desk");
  assert.equal(result.compatibility.adapter, "product_search_v1");
});
