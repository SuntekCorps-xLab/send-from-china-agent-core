import assert from "node:assert/strict";
import { setImmediate as delayTurn } from "node:timers/promises";
import { test } from "node:test";

import { projectSearchContractV2Response } from "../../sdk/src/search-contract-v2.js";
import {
  createShopifyReadOnlyProvider,
  SHOPIFY_CATALOG_QUERY,
  SHOPIFY_HEALTH_QUERY,
  SHOPIFY_PRODUCT_QUERY,
  SHOPIFY_STOREFRONT_API_VERSION,
} from "../shopify-provider.mjs";
import { validateSandboxStatus } from "../status-contract.mjs";
import {
  catalogPayload,
  FIXED_NOW,
  FIXTURE_STORE,
  FIXTURE_TOKEN,
  healthPayload,
  jsonResponse,
  productNode,
  productPayload,
  searchRequest,
  sequenceFetch,
} from "./helpers/shopify-fixtures.mjs";

function createProvider(sequence, options = {}) {
  const recording = sequenceFetch(sequence);
  const provider = createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: FIXTURE_TOKEN,
    fetchImpl: recording.fetchImpl,
    now: () => FIXED_NOW,
    ...options,
  });
  return { provider, calls: recording.calls };
}

function publicKeys(value, forbidden) {
  if (Array.isArray(value)) {
    for (const item of value) publicKeys(item, forbidden);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key.toLowerCase()), false, `forbidden public key: ${key}`);
    publicKeys(child, forbidden);
  }
}

test("missing or unsafe server credentials fail closed without reading fetch", async () => {
  let calls = 0;
  const provider = createShopifyReadOnlyProvider({
    storeDomain: "",
    accessToken: "",
    fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
    now: () => FIXED_NOW,
  });
  const status = await provider.getStatus({ force: true });
  assert.equal(validateSandboxStatus(status), true);
  assert.equal(status.verified, false);
  assert.equal(status.credential_state, "credential_missing");
  assert.equal(status.error_code, "CREDENTIAL_MISSING");
  await assert.rejects(provider.search(searchRequest()), { publicCode: "CREDENTIAL_MISSING" });
  await assert.rejects(provider.getProduct("public-demo-product"), { publicCode: "CREDENTIAL_MISSING" });
  assert.equal(calls, 0);

  for (const storeDomain of [
    "http://fixture.myshopify.com",
    "localhost.myshopify.com",
    [["127", "0", "0", "1"].join("."), "myshopify", "com"].join("."),
    "fixture.myshopify.com.example",
    "fixture.myshopify.com:443",
  ]) {
    const unsafe = createShopifyReadOnlyProvider({
      storeDomain,
      accessToken: FIXTURE_TOKEN,
      fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
      now: () => FIXED_NOW,
    });
    assert.equal((await unsafe.getStatus({ force: true })).credential_state, "credential_missing");
  }
  assert.equal(calls, 0);
  assert.throws(() => createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: FIXTURE_TOKEN,
    endpoint: "https://example.com/graphql",
  }), /Unsupported Shopify sandbox provider option/);
  assert.throws(() => createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: FIXTURE_TOKEN,
    query: "mutation Forbidden { productUpdate(input: {}) { product { handle } } }",
  }), /Unsupported Shopify sandbox provider option/);
});

test("readiness requires the fixed health and catalog documents", async () => {
  const { provider, calls } = createProvider([healthPayload(), catalogPayload([])]);
  const status = await provider.getStatus({ force: true });
  assert.equal(validateSandboxStatus(status), true);
  assert.equal(status.verified, true);
  assert.equal(status.credential_state, "succeeded");
  assert.equal(status.api_version, SHOPIFY_STOREFRONT_API_VERSION);
  assert.equal(status.quota.remaining, status.quota.limit - 2);
  assert.equal(calls.length, 2);

  const expectedUrl = `https://${FIXTURE_STORE}/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`;
  assert.deepEqual(calls.map((call) => call.url), [expectedUrl, expectedUrl]);
  assert.deepEqual(calls.map((call) => call.body.operationName), ["ShopifySandboxHealth", "ShopifySandboxCatalog"]);
  assert.equal(calls[0].body.query, SHOPIFY_HEALTH_QUERY);
  assert.equal(calls[1].body.query, SHOPIFY_CATALOG_QUERY);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.headers["x-shopify-storefront-access-token"], FIXTURE_TOKEN);
    assert.doesNotMatch(call.body.query, /\bmutation\b|\bvendor\b|\bmetafield\b|\bcustomer\b|\border\b|\binventory\b/iu);
  }
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FIXTURE_TOKEN, "u"));
  assert.doesNotMatch(JSON.stringify(calls.map((call) => call.body)), new RegExp(FIXTURE_TOKEN, "u"));
});

test("readiness maps only public authentication, permission, quota, and service states", async (t) => {
  for (const [statusCode, state, code] of [
    [401, "authentication_failed", "AUTHENTICATION_FAILED"],
    [403, "permission_required", "PERMISSION_REQUIRED"],
    [429, "quota_exceeded", "QUOTA_EXCEEDED"],
    [503, "service_unavailable", "SERVICE_UNAVAILABLE"],
  ]) {
    await t.test(`HTTP ${statusCode}`, async () => {
      const { provider } = createProvider([jsonResponse({}, { status: statusCode })]);
      const status = await provider.getStatus({ force: true });
      assert.equal(status.verified, false);
      assert.equal(status.credential_state, state);
      assert.equal(status.error_code, code);
    });
  }

  const graphQl = createProvider([jsonResponse({
    data: null,
    errors: [{ message: `${FIXTURE_TOKEN}: upstream detail`, extensions: { code: "THROTTLED" } }],
  })]);
  const status = await graphQl.provider.getStatus({ force: true });
  assert.equal(status.credential_state, "quota_exceeded");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FIXTURE_TOKEN, "u"));

  const catalogDenied = createProvider([
    healthPayload(),
    jsonResponse({}, { status: 403 }),
  ]);
  const denied = await catalogDenied.provider.getStatus({ force: true });
  assert.equal(denied.verified, false);
  assert.equal(denied.credential_state, "permission_required");
  assert.equal(catalogDenied.calls.length, 2);
});

test("strict responses reject unknown fields, redirects, content-type drift, oversized bodies, and timeouts", async (t) => {
  await t.test("unknown response field", async () => {
    const { provider } = createProvider([{ data: { shop: { name: "Fixture", unexpected: true } } }]);
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
  });

  await t.test("redirect", async () => {
    const redirected = jsonResponse(healthPayload(), { redirected: true });
    const { provider } = createProvider([redirected]);
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");

    const changedUrl = jsonResponse(healthPayload(), { url: "https://example.com/graphql" });
    const changed = createProvider([changedUrl]);
    assert.equal((await changed.provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
  });

  await t.test("declared oversize", async () => {
    const oversized = jsonResponse(healthPayload(), { headers: { "content-length": "1024" } });
    const { provider } = createProvider([oversized], { maxResponseBytes: 64 });
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
  });

  await t.test("streamed oversize", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(healthPayload()));
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.enqueue(bytes);
        controller.close();
      },
    }), { headers: { "content-type": "application/json" } });
    const { provider } = createProvider([response], { maxResponseBytes: bytes.length + 1 });
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
  });

  await t.test("non-canonical JSON content types", async () => {
    for (const contentType of [
      "application/jsonp",
      "text/application/json",
      "application/json,text/html",
      "application/json; charset=utf-8; profile=unexpected",
    ]) {
      const response = jsonResponse(healthPayload(), { headers: { "content-type": contentType } });
      const { provider } = createProvider([response]);
      assert.equal(
        (await provider.getStatus({ force: true })).error_code,
        "SERVICE_UNAVAILABLE",
        contentType,
      );
    }
  });

  await t.test("timeout", { timeout: 1_000 }, async () => {
    const provider = createShopifyReadOnlyProvider({
      storeDomain: FIXTURE_STORE,
      accessToken: FIXTURE_TOKEN,
      fetchImpl: async () => new Promise(() => {}),
      timeoutMs: 5,
      now: () => FIXED_NOW,
    });
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
  });

  await t.test("timeout keeps a concurrency slot until an abort-ignoring operation settles", { timeout: 1_000 }, async () => {
    let calls = 0;
    const provider = createShopifyReadOnlyProvider({
      storeDomain: FIXTURE_STORE,
      accessToken: FIXTURE_TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return new Promise(() => {});
      },
      concurrencyLimit: 1,
      timeoutMs: 5,
      now: () => FIXED_NOW,
    });
    assert.equal((await provider.getStatus({ force: true })).error_code, "SERVICE_UNAVAILABLE");
    assert.equal((await provider.getStatus({ force: true })).error_code, "QUOTA_EXCEEDED");
    assert.equal(calls, 1);
  });
});

test("quota and concurrency limits reject before another outbound call", async () => {
  const quota = createProvider([healthPayload(), catalogPayload([])], { quotaLimit: 2 });
  assert.equal((await quota.provider.getStatus({ force: true })).verified, true);
  await assert.rejects(quota.provider.search(searchRequest()), { publicCode: "QUOTA_EXCEEDED" });
  assert.equal(quota.calls.length, 2);

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const calls = [];
  const provider = createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: FIXTURE_TOKEN,
    now: () => FIXED_NOW,
    concurrencyLimit: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      count += 1;
      if (count === 1) return jsonResponse(healthPayload());
      if (count === 2) return jsonResponse(catalogPayload([]));
      if (count === 3) return pending;
      throw new Error("unexpected extra fetch");
    },
  });
  assert.equal((await provider.getStatus({ force: true })).verified, true);
  const first = provider.search(searchRequest());
  while (calls.length < 3) await delayTurn();
  await assert.rejects(provider.search(searchRequest()), { publicCode: "QUOTA_EXCEEDED" });
  assert.equal(calls.length, 3);
  release(jsonResponse(catalogPayload([])));
  await first;
});

test("search and product detail expose only current public Storefront facts", async () => {
  const searchNode = productNode({
    title: "Current search title",
    onlineStoreUrl: "https://shop.example/products/current-search",
    handle: "current-search",
    availableForSale: true,
    priceRange: { minVariantPrice: { amount: "21.50", currencyCode: "EUR" } },
  });
  const detailNode = productNode({
    title: "Current detail title",
    onlineStoreUrl: "https://shop.example/products/current-detail",
    handle: "current-detail",
    availableForSale: false,
    priceRange: { minVariantPrice: { amount: "22.75", currencyCode: "GBP" } },
  });
  const { provider, calls } = createProvider([
    healthPayload(),
    catalogPayload([]),
    catalogPayload([searchNode]),
    productPayload(detailNode),
  ]);
  assert.equal((await provider.getStatus({ force: true })).verified, true);
  const search = await provider.search(searchRequest());
  const product = await provider.getProduct("current-detail");
  assert.equal(calls.length, 4);
  assert.equal(calls[2].body.query, SHOPIFY_CATALOG_QUERY);
  assert.equal(calls[3].body.query, SHOPIFY_PRODUCT_QUERY);
  assert.equal(search.results[0].handle, searchNode.handle);
  assert.deepEqual(search.results[0].price, { amount: 21.5, currency: "EUR" });
  assert.equal(search.results[0].availableForSale, searchNode.availableForSale);
  assert.equal(search.results[0].product_url, searchNode.onlineStoreUrl);
  assert.equal(product.product.handle, detailNode.handle);
  for (const projected of [search.results[0], product.product]) {
    assert.deepEqual(projected.images, [{
      url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", alt: "Public demo product",
    }]);
    assert.deepEqual(projected.attributes, { material: "Stainless steel", model: "DEMO-20", color: "Silver" });
    assert.equal(projected.category, "Demo accessories");
  }
  assert.deepEqual(product.product.price, { amount: 22.75, currency: "GBP" });
  assert.equal(product.product.availableForSale, detailNode.availableForSale);
  assert.equal(product.product.product_url, detailNode.onlineStoreUrl);
  for (const result of [search.results[0], product.product]) {
    assert.equal(result.shopify_verified_at, "2026-08-31T00:00:00.000Z");
    assert.equal(result.non_transactional, true);
    assert.equal(result.transaction_boundary, "catalog_read_only_non_transactional");
    assert.equal(result.writes, false);
    assert.equal(result.purchasable, false);
  }
  assert.equal(projectSearchContractV2Response(search).mode, "shopify_read_only");
  publicKeys({ search, product }, new Set([
    "vendor", "cost", "cost_price", "id", "metafield", "customer", "order", "raw", "response", "token",
  ]));
  assert.doesNotMatch(JSON.stringify({ search, product }), new RegExp(FIXTURE_TOKEN, "u"));
});

test("a reflected server credential is rejected instead of reaching a result", async () => {
  const reflected = productNode({ description: `unsafe ${FIXTURE_TOKEN}` });
  const { provider } = createProvider([
    healthPayload(), catalogPayload([]), catalogPayload([reflected]),
  ]);
  await provider.getStatus({ force: true });
  await assert.rejects(provider.search(searchRequest()), { publicCode: "SERVICE_UNAVAILABLE" });

  const cursorReflection = createProvider([
    healthPayload(),
    catalogPayload([]),
    catalogPayload([productNode()], { hasNextPage: true, endCursor: FIXTURE_TOKEN }),
  ]);
  await cursorReflection.provider.getStatus({ force: true });
  await assert.rejects(cursorReflection.provider.search(searchRequest()), {
    publicCode: "SERVICE_UNAVAILABLE",
  });

  const encodedToken = "fixture/server/credential?value=1";
  const encodedRecording = sequenceFetch([
    healthPayload(),
    catalogPayload([]),
    catalogPayload([productNode()], {
      hasNextPage: true,
      endCursor: encodeURIComponent(encodedToken),
    }),
  ]);
  const encodedProvider = createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: encodedToken,
    fetchImpl: encodedRecording.fetchImpl,
    now: () => FIXED_NOW,
  });
  await encodedProvider.getStatus({ force: true });
  await assert.rejects(encodedProvider.search(searchRequest()), {
    publicCode: "SERVICE_UNAVAILABLE",
  });
});

test("product detail rejects a response for a different handle", async () => {
  const { provider } = createProvider([
    healthPayload(),
    catalogPayload([]),
    productPayload(productNode({ handle: "different-product" })),
  ]);
  await provider.getStatus({ force: true });
  await assert.rejects(provider.getProduct("public-demo-product"), {
    publicCode: "SERVICE_UNAVAILABLE",
  });
});

function createProjectionProvider(sequence) {
  return createProvider(sequence).provider;
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
  const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload([candidate])]);
  const search = await provider.search(searchRequest());
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
    ["image reflected credential", { images: { nodes: [{ ...image, altText: FIXTURE_TOKEN }] } }],
    ["option unknown field", { options: [{ name: "Material", values: ["Steel"], id: "fixture-private" }] }],
    ["option values shape", { options: [{ name: "Material", values: { value: "Steel" } }] }],
    ["option duplicate name", { options: [{ name: "Material", values: ["Steel"] }, { name: "material", values: ["Wood"] }] }],
    ["option value bound", { options: [{ name: "Material", values: ["x".repeat(301)] }] }],
    ["option reflected credential", { options: [{ name: "Material", values: [FIXTURE_TOKEN] }] }],
  ];
  for (const [name, overrides] of unsafe) {
    await t.test(name, async () => {
      const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload([productNode(overrides)])]);
      await assert.rejects(provider.search(searchRequest()), { publicCode: "SERVICE_UNAVAILABLE" });
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
  const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload(candidates)]);
  const result = await provider.search({ ...searchRequest(), limit: 20, hard_constraints: [
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
  const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload()]);
  const result = await provider.search({ ...searchRequest(), hard_constraints: [hardCondition("price_max", 1)] });
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
      const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload(candidates)]);
      const result = await provider.search({ ...searchRequest(), hard_constraints: [condition] });
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
  const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload([productNode()], {
    hasNextPage: true, endCursor: "fixture-next-page",
  })]);
  const result = await provider.search({ ...searchRequest(), hard_constraints: [hardCondition("price_max", 1)],
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
      const provider = createProjectionProvider([healthPayload(), catalogPayload([]), catalogPayload([productNode({ options })])]);
      const result = await provider.search({ ...searchRequest(), hard_constraints: [
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
