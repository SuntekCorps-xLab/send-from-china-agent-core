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
