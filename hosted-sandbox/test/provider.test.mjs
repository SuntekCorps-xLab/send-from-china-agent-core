import { projectSearchContractV2Response } from "../../sdk/src/search-contract-v2.js";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHostedShopifyProvider,
  HostedShopifyError,
  SHOPIFY_CATALOG_QUERY,
  SHOPIFY_HEALTH_QUERY,
  SHOPIFY_PRODUCT_QUERY,
} from "../src/shopify-provider.js";
import { catalog, detail, DOMAIN, health, jsonResponse, productNode, requestBody, sequenceFetch, TOKEN } from "./helpers.mjs";

const quota = { limit: 60, remaining: 0, window_seconds: 60, concurrency_limit: 0, reset_at: null };

test("provider uses only three fixed read queries and returns allowlisted non-transactional fields", async () => {
  const upstream = sequenceFetch([health(), catalog(), catalog(), detail()]);
  const provider = createHostedShopifyProvider({
    SHOPIFY_STORE_DOMAIN: DOMAIN,
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
  }, { fetchImpl: upstream.fetch, now: () => Date.parse("2026-08-31T00:00:00.000Z"), quota });
  const status = await provider.getStatus();
  const search = await provider.search(requestBody());
  const product = await provider.getProduct("public-demo-product");
  assert.equal(status.verified, true);
  assert.equal(search.results.length, 1);
  assert.match(search.results[0].public_id, /^[a-f0-9]{22}$/u);
  assert.equal(search.results[0].writes, false);
  assert.equal(search.results[0].purchasable, false);
  assert.equal(product.product.handle, "public-demo-product");
  for (const projected of [search.results[0], product.product]) {
    assert.deepEqual(projected.images, [{
      url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", alt: "Public demo product",
    }]);
    assert.deepEqual(projected.attributes, { material: "Stainless steel", model: "DEMO-20", color: "Silver" });
    assert.equal(projected.category, "Demo accessories");
  }
  assert.deepEqual(upstream.calls.map((call) => call.body.operationName), [
    "ShopifySandboxHealth", "ShopifySandboxCatalog", "ShopifySandboxCatalog", "ShopifySandboxProduct",
  ]);
  for (const call of upstream.calls) {
    assert.equal(call.url, `https://${DOMAIN}/api/2026-07/graphql.json`);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["x-shopify-storefront-access-token"], TOKEN);
    assert.doesNotMatch(call.body.query, /\bmutation\b/iu);
  }
  const output = JSON.stringify({ status, search, product });
  assert.doesNotMatch(output, new RegExp(TOKEN, "u"));
  const forbiddenProductFields = new Set(["vendor", "metafields", "customers", "orders", "inventory"]);
  assert.equal(Object.keys(search.results[0]).some((key) => forbiddenProductFields.has(key)), false);
  assert.equal(Object.keys(product.product).some((key) => forbiddenProductFields.has(key)), false);
});

test("provider fails closed for missing credential without fetch", async () => {
  let calls = 0;
  const provider = createHostedShopifyProvider({}, { fetchImpl: async () => { calls += 1; }, quota });
  const status = await provider.getStatus();
  assert.equal(status.verified, false);
  assert.equal(status.credential_state, "credential_missing");
  await assert.rejects(provider.search(requestBody()), (error) => (
    error instanceof HostedShopifyError && error.publicCode === "CREDENTIAL_MISSING"
  ));
  assert.equal(calls, 0);
});

test("strict upstream parser rejects MIME drift, redirects, unknown fields, private URLs, and credential reflection", async () => {
  const badResponses = [
    jsonResponse(health(), { headers: { "content-type": "application/jsonp" } }),
    jsonResponse(health(), { redirected: true }),
    jsonResponse({ data: { shop: { name: "Fixture", unknown: true } } }),
    jsonResponse(health()),
    jsonResponse(catalog([productNode({ onlineStoreUrl: "https://localhost/products/demo" })])),
    jsonResponse(health()),
    jsonResponse(catalog([productNode({ description: `reflected ${TOKEN}` })])),
  ];
  for (let index = 0; index < badResponses.length;) {
    const first = badResponses[index];
    const sequence = index === 0 || index === 1 || index === 2 ? [first] : [first, badResponses[index + 1]];
    index += sequence.length;
    const upstream = sequenceFetch(sequence);
    const provider = createHostedShopifyProvider({
      SHOPIFY_STORE_DOMAIN: DOMAIN, SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
    }, { fetchImpl: upstream.fetch, quota });
    const status = await provider.getStatus({ force: true });
    assert.equal(status.verified, false);
    assert.equal(status.error_code, "SERVICE_UNAVAILABLE");
  }
});

test("fixed operations and variables contain no caller-controlled GraphQL", () => {
  for (const query of [SHOPIFY_HEALTH_QUERY, SHOPIFY_CATALOG_QUERY, SHOPIFY_PRODUCT_QUERY]) {
    assert.match(query, /^query /u);
    assert.doesNotMatch(query, /\bmutation\b|customer|order|cart|checkout|payment|inventory|metafield|vendor/iu);
  }
});

test("deadline fails closed when fetch ignores AbortSignal forever", async () => {
  let capturedSignal;
  let releaseFetch;
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    capturedSignal = init.signal;
    return new Promise((resolve) => { releaseFetch = resolve; });
  };
  const provider = createHostedShopifyProvider({
    SHOPIFY_STORE_DOMAIN: DOMAIN,
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
  }, { fetchImpl, quota, requestTimeoutMs: 20 });

  const startedAt = performance.now();
  const status = await provider.getStatus({ force: true });
  const elapsed = performance.now() - startedAt;
  assert.equal(status.verified, false);
  assert.equal(status.error_code, "SERVICE_UNAVAILABLE");
  assert.equal(capturedSignal.aborted, true);
  assert.equal(calls, 1);
  assert.ok(elapsed < 500, `deadline took ${elapsed}ms`);

  releaseFetch(jsonResponse(health()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(await provider.getStatus(), status);
  assert.equal(calls, 1);
});

test("deadline fails closed when the response body reader stalls forever", async () => {
  let capturedSignal;
  let releaseRead;
  let readCalls = 0;
  let cancelCalls = 0;
  const reader = {
    read() {
      readCalls += 1;
      return new Promise((resolve) => { releaseRead = resolve; });
    },
    cancel() {
      cancelCalls += 1;
      return new Promise(() => {});
    },
  };
  const fetchImpl = async (url, init) => {
    capturedSignal = init.signal;
    return {
      status: 200,
      ok: true,
      redirected: false,
      url: String(url),
      headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
      body: { getReader: () => reader },
    };
  };
  const provider = createHostedShopifyProvider({
    SHOPIFY_STORE_DOMAIN: DOMAIN,
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
  }, { fetchImpl, quota, requestTimeoutMs: 20 });

  const startedAt = performance.now();
  const status = await provider.getStatus({ force: true });
  const elapsed = performance.now() - startedAt;
  assert.equal(status.verified, false);
  assert.equal(status.error_code, "SERVICE_UNAVAILABLE");
  assert.equal(capturedSignal.aborted, true);
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.ok(elapsed < 500, `deadline took ${elapsed}ms`);

  releaseRead({ done: false, value: new TextEncoder().encode(JSON.stringify(health())) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(await provider.getStatus(), status);
  assert.equal(readCalls, 1);
});

function createProjectionProvider(sequence) {
  const upstream = sequenceFetch(sequence);
  return createHostedShopifyProvider({
    SHOPIFY_STORE_DOMAIN: DOMAIN, SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
  }, { fetchImpl: upstream.fetch, quota });
}

test("public option projection drops unapproved names and preserves only safe values", async () => {
  const candidate = productNode({
    images: { nodes: [{ url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", altText: null }] },
    options: [
      { name: "Material", values: ["Stainless steel", "Aluminum"] },
      { name: "Compatible Models", values: ["DEMO-20"] },
      { name: "Vendor", values: ["Private fixture"] },
      { name: "Internal ID", values: ["fixture-private"] },
      { name: "Custom", values: ["Undocumented extension"] },
      { name: "Feature", values: ["token=fixture-value"] },
    ],
  });
  const provider = createProjectionProvider([health(), catalog([]), catalog([candidate])]);
  const search = await provider.search(requestBody());
  assert.deepEqual(search.results[0].images, [{
    url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", alt: "",
  }]);
  assert.deepEqual(search.results[0].attributes, {
    material: "Stainless steel, Aluminum", compatible_models: "DEMO-20",
  });
  assert.doesNotMatch(JSON.stringify(search.results), /Private fixture|fixture-private|Undocumented extension|fixture-value/u);
});

test("new upstream image and option fields fail closed on shape, URL, and credential violations", async (t) => {
  const image = { url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", altText: "Demo" };
  const unsafe = [
    ["vendor field", { vendor: "Private fixture" }],
    ["internal identifier", { id: "fixture-private" }],
    ["metafields", { metafields: [] }],
    ["raw response", { raw: {} }],
    ["image identifier", { images: { nodes: [{ ...image, id: "fixture-private" }] } }],
    ["image unknown shape", { images: { edges: [] } }],
    ["too many images", { images: { nodes: Array(9).fill(image) } }],
    ["image alt bound", { images: { nodes: [{ ...image, altText: "x".repeat(301) }] } }],
    ["image HTTP URL", { images: { nodes: [{ ...image, url: "http://cdn.shopify.com/demo.jpg" }] } }],
    ["image private URL", { images: { nodes: [{ ...image, url: "https://localhost/demo.jpg" }] } }],
    ["image non-CDN URL", { images: { nodes: [{ ...image, url: "https://shop.example/demo.jpg" }] } }],
    ["image URL userinfo", { images: { nodes: [{ ...image, url: "https://fixture@cdn.shopify.com/demo.jpg" }] } }],
    ["image URL fragment", { images: { nodes: [{ ...image, url: "https://cdn.shopify.com/demo.jpg#fragment" }] } }],
    ["image URL private query", { images: { nodes: [{ ...image, url: "https://cdn.shopify.com/demo.jpg?token=fixture-value" }] } }],
    ["image reflected credential", { images: { nodes: [{ ...image, altText: TOKEN }] } }],
    ["option unknown field", { options: [{ name: "Material", values: ["Steel"], id: "fixture-private" }] }],
    ["option values shape", { options: [{ name: "Material", values: { value: "Steel" } }] }],
    ["option duplicate name", { options: [{ name: "Material", values: ["Steel"] }, { name: "material", values: ["Wood"] }] }],
    ["option value bound", { options: [{ name: "Material", values: ["x".repeat(301)] }] }],
    ["option reflected credential", { options: [{ name: "Material", values: [TOKEN] }] }],
  ];
  for (const [name, overrides] of unsafe) {
    await t.test(name, async () => {
      const provider = createProjectionProvider([health(), catalog([]), catalog([productNode(overrides)])]);
      await assert.rejects(provider.search(requestBody()), { publicCode: "SERVICE_UNAVAILABLE" });
    });
  }
});

function hardCondition(name, value) {
  return { name, value, source: "explicit", scope: "product", hardness: "hard" };
}

test("search deterministically enforces price, material, model, required terms, and exclusions", async () => {
  const options = (material = "Stainless steel", model = "DEMO-20") => [
    { name: "Material", values: [material] },
    { name: "Model", values: [model] },
    { name: "Color", values: ["Silver"] },
  ];
  const candidates = [
    productNode(),
    productNode({ handle: "too-expensive", priceRange: { minVariantPrice: { amount: "21.00", currencyCode: "USD" } } }),
    productNode({ handle: "wrong-material", options: options("Wood") }),
    productNode({ handle: "wrong-model", options: options("Stainless steel", "DEMO-200") }),
    productNode({ handle: "excluded-component", description: "A demo product with rubber trim." }),
  ];
  const provider = createProjectionProvider([health(), catalog([]), catalog(candidates)]);
  const result = await provider.search({ ...requestBody(), limit: 20, hard_constraints: [
    hardCondition("price_min", 19), hardCondition("price_max", 20),
    hardCondition("material", "stainless steel"), hardCondition("model", "DEMO-20"),
    hardCondition("color", "silver"), hardCondition("must_have", "demo"), hardCondition("exclude", "rubber"),
  ] });
  assert.equal(result.status, "results");
  assert.deepEqual(result.results.map((product) => product.handle), ["public-demo-product"]);
  assert.deepEqual(result.relaxations, []);
  assert.equal(result.search_scope.scope_exhausted, true);
  assert.equal(projectSearchContractV2Response(result).status, "results");
});

test("a completed filtered search reports no_match only when constraints are evaluable", async () => {
  const provider = createProjectionProvider([health(), catalog([]), catalog()]);
  const result = await provider.search({ ...requestBody(), hard_constraints: [hardCondition("price_max", 1)] });
  assert.equal(result.status, "no_match");
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.relaxations, []);
  assert.equal(result.search_scope.plan_complete, true);
  assert.equal(result.search_scope.scope_exhausted, true);
  assert.equal(result.search_scope.degraded, false);
  assert.equal(projectSearchContractV2Response(result).status, "no_match");
});

test("unverifiable constraints stay degraded on a final page, including with candidates", async (t) => {
  for (const [name, candidates, condition, expectedCount] of [
    ["missing public material", [productNode({ options: [] })], hardCondition("material", "steel"), 0],
    ["unsupported operand with candidates", [productNode()], hardCondition("material", "steel or wood"), 1],
    ["unsupported operand with no candidates", [], hardCondition("material", "steel or wood"), 0],
    ["mixed-currency price", [productNode(), productNode({ priceRange: { minVariantPrice: { amount: "9.00", currencyCode: "EUR" } } })], hardCondition("price_max", 20), 2],
  ]) {
    await t.test(name, async () => {
      const provider = createProjectionProvider([health(), catalog([]), catalog(candidates)]);
      const result = await provider.search({ ...requestBody(), hard_constraints: [condition] });
      assert.equal(result.status, "degraded");
      assert.equal(result.results.length, expectedCount);
      assert.equal(result.search_scope.plan_complete, false);
      assert.equal(result.search_scope.scope_exhausted, false);
      assert.equal(result.search_scope.degraded, true);
      assert.equal(result.relaxations.some((entry) => entry.condition === condition.name), true);
      assert.equal(projectSearchContractV2Response(result).status, "degraded");
    });
  }
});

test("filtered pages preserve continuation and unevaluated transaction context", async () => {
  const provider = createProjectionProvider([health(), catalog([]), catalog([productNode()], {
    hasNextPage: true, endCursor: "fixture-next-page",
  })]);
  const result = await provider.search({ ...requestBody(), hard_constraints: [hardCondition("price_max", 1)],
    transaction_context: [{ name: "ship_to", value: "US", source: "explicit", scope: "transaction", hardness: "informational" }],
  });
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.results, []);
  assert.equal(result.pagination.has_more, true);
  assert.equal(typeof result.pagination.next_cursor, "string");
  assert.equal(result.search_scope.scope_exhausted, false);
  assert.equal(result.relaxations.some((entry) => entry.condition === "ship_to"), true);
  assert.equal(projectSearchContractV2Response(result).status, "degraded");
});

test("public option choices cannot prove a price and material variant combination", async (t) => {
  for (const [name, options] of [
    ["multiple material choices", [{ name: "Material", values: ["Stainless steel", "Aluminum"] }]],
    ["unprojected option choices", [{ name: "Material", values: ["Stainless steel"] }, { name: "Custom option", values: ["Small", "Large"] }]],
  ]) {
    await t.test(name, async () => {
      const provider = createProjectionProvider([health(), catalog([]), catalog([productNode({ options })])]);
      const result = await provider.search({ ...requestBody(), hard_constraints: [
        hardCondition("material", "stainless steel"), hardCondition("price_max", 20),
      ] });
      assert.equal(result.status, "degraded");
      assert.deepEqual(result.results, []);
      assert.equal(result.search_scope.scope_exhausted, false);
      assert.ok(result.relaxations.some((entry) => /variant/u.test(entry.reason)));
      assert.doesNotMatch(JSON.stringify(result), /hasVariantChoices|Custom option/u);
      assert.equal(projectSearchContractV2Response(result).status, "degraded");
    });
  }
});
