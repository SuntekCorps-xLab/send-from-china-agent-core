import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_ATTRIBUTE_NAMES as WORKER_PUBLIC_ATTRIBUTE_NAMES,
  PUBLIC_ATTRIBUTE_POLICY_VERSION as WORKER_PUBLIC_ATTRIBUTE_POLICY_VERSION,
} from "../../governance-worker/src/field-policy.js";
import coreWorker from "../../governance-worker/src/index.js";
import { ALPHA_KEY, ENV as CORE_ENV } from "../../governance-worker/test/test-env.js";
import {
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  createSendFromChinaClient,
  normalizeSearchContractV2Request,
  parseSearchContractV2Request,
  projectSearchContractV2Response,
  PUBLIC_ATTRIBUTE_NAMES,
  PUBLIC_ATTRIBUTE_POLICY_VERSION,
  SEARCH_CONTRACT_VERSION,
} from "../src/index.js";

test("Worker and SDK use one versioned public attribute schema", async () => {
  const canonical = JSON.parse(await readFile(new URL("../../contracts/public-product-attribute-policy.v1.json", import.meta.url)));
  assert.equal(PUBLIC_ATTRIBUTE_POLICY_VERSION, "public-product-attributes/v1");
  assert.equal(PUBLIC_ATTRIBUTE_POLICY_VERSION, WORKER_PUBLIC_ATTRIBUTE_POLICY_VERSION);
  assert.equal(PUBLIC_ATTRIBUTE_POLICY_VERSION, canonical.schema_version);
  assert.deepEqual(PUBLIC_ATTRIBUTE_NAMES, WORKER_PUBLIC_ATTRIBUTE_NAMES);
  assert.deepEqual(PUBLIC_ATTRIBUTE_NAMES, canonical.enum);
});

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

function pointerValue(document, pointer) {
  return pointer.split("/").slice(1).reduce((value, part) => (
    value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  ), document);
}

function schemaMatches(schema, value, root, documents) {
  if (schema.$ref) {
    const [documentName, fragment = ""] = schema.$ref.split("#");
    const referencedRoot = documentName ? documents.get(documentName) : root;
    if (!referencedRoot) throw new Error(`Unknown schema reference: ${schema.$ref}`);
    return schemaMatches(fragment ? pointerValue(referencedRoot, fragment) : referencedRoot, value, referencedRoot, documents);
  }
  if (schema.allOf && !schema.allOf.every((item) => schemaMatches(item, value, root, documents))) return false;
  if (schema.oneOf && schema.oneOf.filter((item) => schemaMatches(item, value, root, documents)).length !== 1) return false;
  if (schema.not && schemaMatches(schema.not, value, root, documents)) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((item) => Object.is(value, item))) return false;
  if (Array.isArray(schema.type)
    && !schema.type.some((type) => schemaMatches({ ...schema, type }, value, root, documents))) return false;
  if (schema.type === "array") {
    if (!Array.isArray(value) || (schema.minItems !== undefined && value.length < schema.minItems)
      || (schema.maxItems !== undefined && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && !value.every((item) => schemaMatches(schema.items, item, root, documents))) return false;
  } else if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  } else if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength !== undefined && value.length < schema.minLength)
      || (schema.maxLength !== undefined && value.length > schema.maxLength)
      || (schema.pattern && !new RegExp(schema.pattern, "u").test(value))) return false;
  } else if (schema.type === "integer" && (!Number.isInteger(value)
    || (schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value)
    || (schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  else if (schema.type === "boolean" && typeof value !== "boolean") return false;
  else if (schema.type === "null" && value !== null) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required && !schema.required.every((name) => Object.hasOwn(value, name))) return false;
    if (schema.additionalProperties === false
      && Object.keys(value).some((name) => !Object.hasOwn(schema.properties || {}, name))) return false;
    for (const [name, property] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, name) && !schemaMatches(property, value[name], root, documents)) return false;
    }
  }
  if (schema.if && schemaMatches(schema.if, value, root, documents)
    && schema.then && !schemaMatches(schema.then, value, root, documents)) return false;
  return true;
}

test("publishes strict v2 request and response schemas", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-request.schema.json", import.meta.url)));
  const responseSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-response.schema.json", import.meta.url)));
  assert.equal(requestSchema.properties.contract_version.const, "2.0");
  assert.deepEqual(requestSchema.properties.hard_constraints.items.allOf[1].properties.source, { const: "explicit" });
  const transactionName = requestSchema.properties.transaction_context.items.allOf[1].properties.name;
  assert.deepEqual(transactionName.enum, ["ship_to", "quantity", "delivery_days_max"]);
  const hardClauses = requestSchema.properties.hard_constraints.items.allOf;
  assert.deepEqual(hardClauses[2].if.properties.name.enum, ["price_min", "price_max"]);
  assert.equal(hardClauses[2].then.properties.value.type, "number");
  assert.deepEqual(hardClauses[1].properties.name.enum,
    ["price_min", "price_max", "material", "color", "model", "must_have", "exclude"]);
  assert.deepEqual(hardClauses[3].if.properties.name.enum, ["material", "color", "model", "must_have", "exclude"]);
  assert.equal(hardClauses[3].then.properties.value.$ref, "#/$defs/textCriterionValue");
  assert.deepEqual(responseSchema.properties.status.enum, ["results", "needs_clarification", "no_match", "degraded"]);
  assert.ok(responseSchema.required.includes("trace_id"));
  assert.ok(responseSchema.required.includes("search_scope"));
  assert.equal(responseSchema.$defs.normalizedIntent.properties.hard_constraints.$ref,
    "./search-v2-request.schema.json#/properties/hard_constraints");
  assert.equal(responseSchema.$defs.normalizedIntent.properties.soft_context.$ref,
    "./search-v2-request.schema.json#/properties/soft_context");
  assert.equal(responseSchema.$defs.normalizedIntent.properties.transaction_context.$ref,
    "./search-v2-request.schema.json#/properties/transaction_context");
  assert.equal(responseSchema.$defs.relaxation.properties.from.$ref,
    "./search-v2-request.schema.json#/$defs/condition/properties/value");
  assert.equal(responseSchema.$defs.relaxation.properties.to.$ref,
    "./search-v2-request.schema.json#/$defs/condition/properties/value");
  assert.equal(responseSchema.$defs.product.properties.product_url.pattern, "^https://");
  assert.equal(responseSchema.$defs.product.properties.product_url.maxLength, 2048);
  assert.equal(responseSchema.$defs.product.properties.add_to_cart_url.pattern, "^https://");
  assert.equal(responseSchema.$defs.product.properties.add_to_cart_url.maxLength, 2048);
  const noMatchScope = responseSchema.allOf[0].then.properties.search_scope.properties;
  assert.deepEqual(noMatchScope.scan_limit_reached, { const: false });
  assert.equal("source" in responseSchema.$defs.product.properties, false);
});

test("request schema enforces field-specific hard and transaction values", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-request.schema.json", import.meta.url)));
  const documents = new Map();
  const hard = (name, value) => ({ name, value, source: "explicit", scope: "product", hardness: "hard" });
  const transaction = (name, value) => ({
    name, value, source: "explicit", scope: "transaction", hardness: "hard",
  });
  const valid = {
    ...baseRequest,
    hard_constraints: [
      hard("price_min", 0), hard("price_max", 30), hard("material", "steel"),
      hard("color", ["navy", "white"]), hard("must_have", "dishwasher safe"),
      hard("exclude", ["refurbished"]), hard("model", ["PB-100", "PB-200"]),
    ],
    transaction_context: [
      transaction("ship_to", "US"), transaction("quantity", 2), transaction("delivery_days_max", 7),
    ],
  };
  assert.equal(schemaMatches(requestSchema, valid, requestSchema, documents), true);
  assert.deepEqual(parseSearchContractV2Request(valid), normalizeSearchContractV2Request(valid));

  const invalidCases = [
    ["numeric maximum price as text", { hard_constraints: [hard("price_max", "30")] }],
    ["negative minimum price", { hard_constraints: [hard("price_min", -1)] }],
    ["numeric material", { hard_constraints: [hard("material", 304)] }],
    ["numeric model", { hard_constraints: [hard("model", 100)] }],
    ["mixed color list", { hard_constraints: [hard("color", ["navy", 5])] }],
    ["empty exclusion", { hard_constraints: [hard("exclude", "   ")] }],
    ["too many exclusions", { hard_constraints: [hard("exclude", Array.from({ length: 21 }, (_, index) => `item-${index}`))] }],
    ["unknown hard constraint", { hard_constraints: [hard("size", "large")] }],
    ["unknown transaction name", { transaction_context: [transaction("postal_code", "22202")] }],
    ["blank destination", { transaction_context: [transaction("ship_to", "   ")] }],
    ["one-character destination", { transaction_context: [transaction("ship_to", "U")] }],
    ["quantity as text", { transaction_context: [transaction("quantity", "2")] }],
    ["zero quantity", { transaction_context: [transaction("quantity", 0)] }],
    ["fractional quantity", { transaction_context: [transaction("quantity", 1.5)] }],
    ["delivery days as text", { transaction_context: [transaction("delivery_days_max", "3")] }],
    ["zero delivery days", { transaction_context: [transaction("delivery_days_max", 0)] }],
  ];
  for (const [label, changes] of invalidCases) {
    const candidate = {
      ...baseRequest,
      hard_constraints: changes.hard_constraints || [],
      transaction_context: changes.transaction_context || [],
    };
    assert.equal(schemaMatches(requestSchema, candidate, requestSchema, documents), false, label);
    assert.throws(() => parseSearchContractV2Request(candidate), /Invalid Search Contract v2 request/, label);
  }
});

test("response normalized intent preserves request group semantics", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-request.schema.json", import.meta.url)));
  const responseSchema = JSON.parse(await readFile(new URL("../../contracts/search-v2-response.schema.json", import.meta.url)));
  const documents = new Map([["./search-v2-request.schema.json", requestSchema]]);
  const valid = {
    product_identity: baseRequest.product_identity,
    hard_constraints: [{
      name: "material", value: "steel", source: "explicit", scope: "product", hardness: "hard",
    }],
    soft_context: [{
      name: "recipient", value: "friend", source: "inferred", scope: "session", hardness: "soft",
    }],
    transaction_context: [{
      name: "ship_to", value: "US", source: "explicit", scope: "transaction", hardness: "hard",
    }],
  };
  const normalizedIntent = responseSchema.$defs.normalizedIntent;
  assert.equal(schemaMatches(normalizedIntent, valid, responseSchema, documents), true);

  const invalidCases = [
    {
      label: "inferred hard constraint",
      value: { ...valid, hard_constraints: [{
        name: "material", value: "steel", source: "inferred", scope: "product", hardness: "hard",
      }] },
    },
    {
      label: "unknown hard constraint",
      value: { ...valid, hard_constraints: [{
        name: "size", value: "large", source: "explicit", scope: "product", hardness: "hard",
      }] },
    },
    {
      label: "hard soft context",
      value: { ...valid, soft_context: [{
        name: "recipient", value: "friend", source: "explicit", scope: "session", hardness: "hard",
      }] },
    },
    {
      label: "product-scoped transaction context",
      value: { ...valid, transaction_context: [{
        name: "ship_to", value: "US", source: "explicit", scope: "product", hardness: "hard",
      }] },
    },
  ];
  for (const invalidCase of invalidCases) {
    assert.equal(schemaMatches(normalizedIntent, invalidCase.value, responseSchema, documents), false, invalidCase.label);
  }
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
  assert.throws(() => parseSearchContractV2Request({ ...baseRequest, limit: "20" }), /limit/);
  assert.throws(() => parseSearchContractV2Request({ ...baseRequest, cursor: 2 }), /cursor/);
  assert.throws(() => parseSearchContractV2Request({
    ...baseRequest,
    hard_constraints: [{
      name: "Price_Max", value: 30, source: "explicit", scope: "product", hardness: "hard",
    }],
  }), /lower_snake_case/);
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
      { name: "color", value: "navy", source: "explicit", scope: "product", hardness: "hard" },
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
  assert.deepEqual(adapted.relaxations.map((item) => item.condition), ["color", "recipient"]);
});

test("v1 compatibility preserves flat condition arrays through the public v2 projection", () => {
  const adapted = adaptSearchContractV2RequestToV1({
    ...baseRequest,
    hard_constraints: [
      { name: "color", value: ["navy", "blue"], source: "explicit", scope: "product", hardness: "hard" },
    ],
  });
  const responseV2 = adaptSearchContractV1ResponseToV2({
    status: "catalog_match", products: [{ title: "Navy organizer" }],
    exhaustive: false, search_scope_exhausted: false,
  }, {
    request: adapted.request, relaxations: adapted.relaxations, traceId: "trace-array-round-trip",
  });
  const projected = projectSearchContractV2Response(responseV2);
  assert.deepEqual(projected.relaxations, [{
    condition: "color",
    from: ["navy", "blue"],
    reason: "The v1 compatibility path cannot enforce this condition.",
  }]);
  assert.equal(Object.isFrozen(projected.relaxations[0].from), true);
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
        material: "steel", brand: "Public Brand", model: "PB-100", width_cm: 8,
        supplier_url: "https://supplier.invalid/item", accessToken: "hidden",
        clientSecret: "hidden", customerEmail: "hidden@example.invalid",
        supplierId: "hidden", actionUrl: "https://checkout.invalid",
        unknown_future_key: "not reviewed", nested: { api_key: "hidden" }, cost_price: 1,
      },
    }], exhaustive: false, search_scope_exhausted: false,
  }, { request: baseRequest, traceId: "trace-result" });
  assert.equal(result.status, "results");
  assert.equal(result.results.length, 1);
  assert.equal("supplier_url" in result.results[0], false);
  assert.equal("cost_price" in result.results[0], false);
  assert.equal("source" in result.results[0], false);
  assert.deepEqual(result.results[0].attributes, {
    material: "steel", brand: "Public Brand", model: "PB-100", width_cm: 8,
  });
});

test("v1 response adapter drops sensitive values under approved attribute names", () => {
  const privateKeyMarker = ["-----BEGIN", ["PRIVATE", "KEY-----"].join(" ")].join(" ");
  const githubToken = ["ghp", "abcdefghijklmnop"].join("_");
  const shopifyToken = ["shpat", "abcdefghijklmnop"].join("_");
  const cloudAccessKey = ["AK", "IA1234567890ABCDEF"].join("");
  const documentationHost = ["192", "0", "2", "10"].join(".");
  const result = adaptSearchContractV1ResponseToV2({
    status: "catalog_match", products: [{
      title: "Public Product",
      attributes: {
        material: privateKeyMarker,
        brand: githubToken,
        model: shopifyToken,
        compatibility: cloudAccessKey,
        features: "Bearer fictional-secret-token",
        finish: "eyJabcdefgh.ijklmnop.qrstuvwx",
        use_case: "client_secret=fictional-secret",
        style: "owner@example.invalid",
        power: "https://catalog.internal/private/item",
        certification: "basic aluminum",
        dimensions: `https://${documentationHost}/public/specification`,
        voltage: "https://www.example.com/public/specification",
        width_cm: 24,
      },
    }], exhaustive: false, search_scope_exhausted: false,
  }, { request: baseRequest, traceId: "trace-sensitive-attribute-values" });
  assert.deepEqual(result.results[0].attributes, {
    certification: "basic aluminum",
    dimensions: `https://${documentationHost}/public/specification`,
    voltage: "https://www.example.com/public/specification",
    width_cm: 24,
  });
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
  const githubToken = ["ghp", "abcdefghijklmnop"].join("_");
  const client = createSendFromChinaClient({
    baseUrl: "https://agent.example.test", token: "tenant_test_token",
    fetch: async (url, init) => {
      called = { url, body: JSON.parse(init.body) };
      return response({
        contract_version: "2.0", trace_id: "trace-direct", status: "results",
        normalized_intent: {
          product_identity: called.body.product_identity,
          hard_constraints: [], soft_context: [], transaction_context: [],
        },
        relaxations: [{
          condition: "color", from: ["navy", "blue"],
          reason: "The hosted path retained a public multi-value condition.",
        }], missing_criteria: [], internal_trace: "must-not-leave",
        results: [{
          title: "Compact Desk", internal_id: "hidden",
          images: [{
            url: "https://www.example.com/images/desk.jpg", alt: "Compact desk", supplierId: "nested-leak",
          }],
          price: { amount: 29, currency: "USD", tier: "public", cost: 0.1 },
          attributes: {
            material: "wood", accessToken: "hidden", customerEmail: "hidden@example.invalid",
            model: githubToken,
          },
        }],
        pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
        search_scope: {
          plan_complete: false, scope_exhausted: false, global_catalog_exhaustive: false,
          scan_limit_reached: false, degraded: false, degraded_reason: null,
        },
      });
    },
  });
  const result = await client.searchContractV2({ ...baseRequest, product_identity: "compact desk" });
  assert.equal(called.url, "https://agent.example.test/api/search/v2");
  assert.equal(called.body.product_identity.value, "compact desk");
  assert.equal(result.contract_version, "2.0");
  assert.equal(result.status, "results");
  assert.deepEqual(result.relaxations[0].from, ["navy", "blue"]);
  assert.equal("internal_trace" in result, false);
  assert.equal("internal_id" in result.results[0], false);
  assert.deepEqual(result.results[0].images, [{
    url: "https://www.example.com/images/desk.jpg", alt: "Compact desk",
  }]);
  assert.deepEqual(result.results[0].price, { amount: 29, currency: "USD", tier: "public" });
  assert.deepEqual(result.results[0].attributes, { material: "wood" });
});

test("direct v2 projection rejects nested metadata outside public product fields", () => {
  const valid = {
    contract_version: "2.0", trace_id: "trace-safe", status: "results",
    normalized_intent: {
      product_identity: baseRequest.product_identity,
      hard_constraints: [], soft_context: [], transaction_context: [],
    },
    relaxations: [], missing_criteria: [], results: [{ title: "Safe product" }],
    pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
    search_scope: {
      plan_complete: false, scope_exhausted: false, global_catalog_exhaustive: false,
      scan_limit_reached: false, degraded: false, degraded_reason: null,
    },
  };
  assert.throws(() => projectSearchContractV2Response({
    ...valid,
    normalized_intent: {
      ...valid.normalized_intent,
      product_identity: { ...baseRequest.product_identity, value: { supplierId: "nested-leak" } },
    },
  }), /Invalid Search Contract v2/);
  assert.throws(() => projectSearchContractV2Response({
    ...valid,
    relaxations: [{ condition: "material", from: { token: "nested-leak" }, reason: "safe reason" }],
  }), /Invalid Search Contract v2/);
  assert.throws(() => projectSearchContractV2Response({
    ...valid,
    relaxations: [{ condition: "material", from: [["nested-leak"]], reason: "safe reason" }],
  }), /Invalid Search Contract v2/);
  assert.throws(() => projectSearchContractV2Response({
    ...valid,
    relaxations: [{ condition: "material", from: ["safe", { token: "nested-leak" }], reason: "safe reason" }],
  }), /Invalid Search Contract v2/);
  assert.throws(() => projectSearchContractV2Response({
    ...valid,
    pagination: { ...valid.pagination, cursor: { token: "nested-leak" } },
  }), /Invalid Search Contract v2/);
});

test("direct v2 projection removes unsafe URL semantics and preserves ordinary public URLs", () => {
  const loopbackHost = ["127", "0", "0", "1"].join(".");
  const responseBase = {
    contract_version: "2.0", trace_id: "trace-url-policy", status: "results",
    normalized_intent: {
      product_identity: baseRequest.product_identity,
      hard_constraints: [], soft_context: [], transaction_context: [],
    },
    relaxations: [], missing_criteria: [],
    pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
    search_scope: {
      plan_complete: false, scope_exhausted: false, global_catalog_exhaustive: false,
      scan_limit_reached: false, degraded: false, degraded_reason: null,
    },
  };
  const unsafeUrls = [
    "https://shop.example/product#access_token=secretvalue123",
    "https://shop.example/product#accesstoken=secretvalue123",
    "https://shop.example/product?x-api-key=secretvalue123",
    "https://shop.example/product?token=secretvalue123",
    "https://shop.example/product#authorization=Basic%20YWJjZGVmZ2hpams=.",
    "https://shop.example/product#authorization=Basic%20dXNlcjpwYXNzd29yZA==:",
    "https://catalog.office.lan/product",
    "https://catalog.office.corp/product",
    "https://supplierportal.example/product",
    "https://shop.example/sourcereceipt/1",
    "https://shop.example/%252573ourceReceipt/1",
    "https://shop.example/sourcereceiptv2/1",
    "https://supplierportalv2.example/product",
    "https://shop.example/sourcereceipts/1",
    "https://suppliersportal.example/product",
    "https://source.example/product",
    "https://vendorportal.example/product",
    `https://shop.example/proxy?url=http%3A%2F%2F${loopbackHost}%2Fprivate`,
    "https://shop.example/proxy?url=https%3A%2F%2Frouter.lan%2Fprivate",
    "https://shop.example/%ZZ/%73ourceReceipt/1",
    "https://router.localdomain/product",
    "https://router.home.arpa/product",
    "https://[fec0::1]/product",
    "https://[ff00::1]/product",
  ];
  for (const url of unsafeUrls) {
    const projected = projectSearchContractV2Response({
      ...responseBase,
      results: [{
        title: "Safe title", product_url: url, add_to_cart_url: url,
        images: [{ url }], attributes: { material: url, width_cm: 24 },
      }],
    });
    assert.deepEqual(projected.results[0], {
      title: "Safe title", attributes: { width_cm: 24 },
    }, url);
  }

  const publicUrl = "https://www.example.com/products/item?variant=1#details";
  const projected = projectSearchContractV2Response({
    ...responseBase,
    results: [{
      title: "Safe title", product_url: publicUrl, add_to_cart_url: publicUrl,
      images: [{ url: publicUrl, alt: "Public product" }],
      attributes: { material: "basic aluminum", voltage: publicUrl },
    }],
  });
  assert.deepEqual(projected.results[0], {
    title: "Safe title", product_url: publicUrl, add_to_cart_url: publicUrl,
    images: [{ url: publicUrl, alt: "Public product" }],
    attributes: { material: "basic aluminum", voltage: publicUrl },
  });

  for (const url of [
    "https://shop.example/products/secret-compartment",
    "https://shop.example/products/token-ring",
    "https://shop.example/products/password-journal",
    "https://shop.example/products/session-chair",
    "https://shop.example/products/secret",
    "https://shop.example/products/token",
    "https://shop.example/search?q=secret-compartment",
  ]) {
    const ordinary = projectSearchContractV2Response({
      ...responseBase,
      results: [{ title: "Safe title", product_url: url, images: [{ url }] }],
    });
    assert.equal(ordinary.results[0].product_url, url);
    assert.equal(ordinary.results[0].images[0].url, url);
  }
});

test("direct v2 projection preserves the closed read-only sandbox truth fields", () => {
  const verifiedAt = "2026-08-31T00:00:00.000Z";
  const response = adaptSearchContractV1ResponseToV2({
    status: "catalog_match",
    products: [{
      public_id: "A1b2C3d4E5f6G7h8J9k0Lm",
      slug: "public-item",
      handle: "public-item",
      title: "Public item",
      price: { amount: 19.95, currency: "USD" },
      purchasable: false,
      availableForSale: true,
      shopify_verified_at: verifiedAt,
      non_transactional: true,
      transaction_boundary: "catalog_read_only_non_transactional",
      writes: false,
      mode: "shopify_read_only",
      data_source: "shopify_storefront_graphql",
      illustrative_only: false,
      available: false,
    }],
    exhaustive: true,
    search_scope_exhausted: true,
  }, { request: baseRequest });
  const projected = projectSearchContractV2Response({
    ...response,
    mode: "shopify_read_only",
    data_source: "shopify_storefront_graphql",
    illustrative_only: false,
    purchasable: false,
    available: false,
    writes: false,
    non_transactional: true,
    transaction_boundary: "catalog_read_only_non_transactional",
    shopify_verified_at: verifiedAt,
  });
  assert.equal(projected.mode, "shopify_read_only");
  assert.equal(projected.shopify_verified_at, verifiedAt);
  assert.equal(projected.results[0].handle, "public-item");
  assert.equal(projected.results[0].availableForSale, true);
  assert.equal(projected.results[0].writes, false);
  assert.equal(projected.results[0].non_transactional, true);
});

test("direct v2 projection removes sensitive values from every public text surface", () => {
  const loopbackHost = ["127", "0", "0", "1"].join(".");
  const responseBase = {
    contract_version: "2.0", trace_id: "trace-public-text-policy", status: "results",
    normalized_intent: {
      product_identity: baseRequest.product_identity,
      hard_constraints: [], soft_context: [], transaction_context: [],
    },
    relaxations: [], missing_criteria: [],
    pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
    search_scope: {
      plan_complete: false, scope_exhausted: false, global_catalog_exhaustive: false,
      scan_limit_reached: false, degraded: false, degraded_reason: null,
    },
  };
  const unsafeValues = [
    "Bearer s3cr3t",
    "Basic dXNlcjpwYXNz",
    "Basic dXNlcjo+",
    "Basic Og==",
    "owner@example.com",
    `See http://${loopbackHost}/private`,
    "meta/accessToken=secretvalue123",
    "meta:accessToken=secretvalue123",
    "meta.accessToken=secretvalue123",
    "meta-accessToken=secretvalue123",
    "meta(accessToken=secretvalue123)",
    "meta,accessToken=secretvalue123",
    "{accessToken:secretvalue123}",
    "api.key=secretvalue123",
    "x api key=secretvalue123",
    "token secretvalue123",
    "%252561ccessToken%25253Dsecretvalue123",
    "%ZZ&%61ccessToken%3Dsecretvalue123",
    "sourceReceipt=receipt123",
    "supplierPortal=internal123",
  ];
  const publicImage = "https://www.example.com/images/product.jpg";
  for (const value of unsafeValues) {
    const projected = projectSearchContractV2Response({
      ...responseBase,
      results: [{
        title: "Safe title", description: value, category: value, tags: [value],
        images: [{ url: publicImage, alt: value }],
        price: { amount: 1, currency: "USD", tier: value },
        attributes: { material: value, width_cm: 24 },
      }],
    });
    assert.deepEqual(projected.results[0], {
      title: "Safe title", attributes: { width_cm: 24 },
    }, value);
    const unsafeTitle = projectSearchContractV2Response({
      ...responseBase, results: [{ title: value }],
    });
    assert.equal(unsafeTitle.results.length, 0, value);
  }

  const safe = projectSearchContractV2Response({
    ...responseBase,
    results: [{
      title: "Session chair with secret compartment",
      description: "Token ring motif and password journal cover",
      category: "Source code learning cards",
      tags: ["open-source", "supplier-friendly"],
      images: [{
        url: "https://www.example.com/images/product.jpg",
        alt: "Basic QWx1bWludW0= aluminum finish",
      }],
      price: { amount: 1, currency: "USD", tier: "secret compartment edition" },
      attributes: { material: "basic aluminum", compatibility: "keyboard session stand" },
    }],
  });
  assert.deepEqual(safe.results[0], {
    title: "Session chair with secret compartment",
    description: "Token ring motif and password journal cover",
    category: "Source code learning cards",
    tags: ["open-source", "supplier-friendly"],
    images: [{
      url: "https://www.example.com/images/product.jpg",
      alt: "Basic QWx1bWludW0= aluminum finish",
    }],
    price: { amount: 1, currency: "USD", tier: "secret compartment edition" },
    attributes: { material: "basic aluminum", compatibility: "keyboard session stand" },
  });
});

test("direct v2 projection rejects sensitive server-generated response strings", () => {
  const loopbackHost = ["127", "0", "0", "1"].join(".");
  const responseBase = {
    contract_version: "2.0", trace_id: "trace-public-response", status: "results",
    normalized_intent: {
      product_identity: baseRequest.product_identity,
      hard_constraints: [], soft_context: [], transaction_context: [],
    },
    relaxations: [], missing_criteria: [], results: [],
    pagination: { limit: 20, cursor: null, next_cursor: null, has_more: false },
    search_scope: {
      plan_complete: true, scope_exhausted: true, global_catalog_exhaustive: false,
      scan_limit_reached: false, degraded: false, degraded_reason: null,
    },
  };
  const unsafeCases = [
    { ...responseBase, trace_id: "Bearer leak-token" },
    {
      ...responseBase,
      relaxations: [{ condition: "material", from: "safe", to: "safe", reason: "api_key=leakvalue" }],
    },
    {
      ...responseBase,
      relaxations: [{ condition: "material", from: "owner@example.com", to: "safe", reason: "Safe reason" }],
    },
    {
      ...responseBase,
      relaxations: [{ condition: "material", from: "safe", to: `http://${loopbackHost}/private`, reason: "Safe reason" }],
    },
    {
      ...responseBase, status: "degraded",
      search_scope: {
        ...responseBase.search_scope, plan_complete: false, scope_exhausted: false,
        degraded: true, degraded_reason: "client_secret=leakvalue",
      },
    },
    {
      ...responseBase,
      compatibility: { adapter: "product_search_v1", legacy_status: "Bearer legacy-leak" },
    },
  ];
  for (const unsafe of unsafeCases) {
    assert.throws(() => projectSearchContractV2Response(unsafe), /Invalid Search Contract v2/);
  }

  const requestDerived = projectSearchContractV2Response({
    ...responseBase,
    normalized_intent: {
      ...responseBase.normalized_intent,
      product_identity: { ...baseRequest.product_identity, value: "owner@example.com" },
    },
    pagination: { ...responseBase.pagination, cursor: "opaque.cursor.token", next_cursor: null },
  });
  assert.equal(requestDerived.normalized_intent.product_identity.value, "owner@example.com");
  assert.equal(requestDerived.pagination.cursor, "opaque.cursor.token");
});

test("v1 adapter replaces or drops sensitive upstream metadata", () => {
  const loopbackHost = ["127", "0", "0", "1"].join(".");
  const adapted = adaptSearchContractV1ResponseToV2({
    status: "Bearer legacy-leak",
    trace_id: "Basic dXNlcjpwYXNz",
    exhaustive: false,
    search_scope_exhausted: false,
    products: [],
    relaxations: [{
      condition: "material", from: "owner@example.com", to: `http://${loopbackHost}/private`,
      reason: "sourceReceipt=receipt123",
    }],
  }, { request: baseRequest });
  assert.equal(adapted.trace_id, "compat-v1-trace-unavailable");
  assert.equal(adapted.compatibility.legacy_status, "unrecognized");
  assert.deepEqual(adapted.relaxations, []);
});

test("SDK projection accepts the exact Agent Core Search v2 handler response", async () => {
  const request = normalizeSearchContractV2Request({ ...baseRequest, product_identity: "desk organizer" });
  const upstream = await coreWorker.fetch(new Request("https://core.contract.invalid/api/search/v2", {
    method: "POST",
    headers: { "Authorization": `Bearer ${ALPHA_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }), CORE_ENV);
  assert.equal(upstream.status, 200);
  const projected = projectSearchContractV2Response(await upstream.json());
  assert.equal(projected.contract_version, "2.0");
  assert.equal(projected.status, "results");
  assert.ok(projected.results.length > 0);
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

test("explicit model conditions remain additive and v1 records their unsupported evaluation", () => {
  const request = normalizeSearchContractV2Request({
    ...baseRequest,
    hard_constraints: [{ name: "model", value: "PB-100", source: "explicit", scope: "product", hardness: "hard" }],
  });
  assert.deepEqual(parseSearchContractV2Request(request), request);
  const adapted = adaptSearchContractV2RequestToV1(request);
  assert.deepEqual(adapted.arguments.criteria, {});
  assert.deepEqual(adapted.relaxations.map((entry) => entry.condition), ["model"]);
  const response = adaptSearchContractV1ResponseToV2({ status: "searching", products: [] }, {
    request, relaxations: adapted.relaxations,
  });
  assert.deepEqual(projectSearchContractV2Response(response).normalized_intent.hard_constraints,
    request.hard_constraints);
});

test("explicit degraded v1 responses cannot become results or terminal no_match", () => {
  for (const state of [{ status: "degraded" }, { status: "no_match", degraded: true },
    { status: "catalog_match", degraded: true }]) {
    for (const products of [[], [{ title: "Public candidate" }]]) {
      const response = adaptSearchContractV1ResponseToV2({
        ...state, products, exhaustive: true, search_scope_exhausted: true,
      }, { request: baseRequest });
      assert.equal(response.status, "degraded");
      assert.equal(response.search_scope.degraded, true);
      assert.equal(response.search_scope.plan_complete, false);
      assert.equal(response.search_scope.scope_exhausted, false);
      assert.match(response.search_scope.degraded_reason, /reported degraded/u);
      assert.equal(projectSearchContractV2Response(response).status, "degraded");
    }
  }
});
