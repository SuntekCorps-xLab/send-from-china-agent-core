import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { projectSearchContractV2Response } from "../../sdk/src/search-contract-v2.js";
import { createShopifyReadOnlyProvider } from "../shopify-provider.mjs";
import { startVerifiedShopifySandbox } from "../shopify-server.mjs";
import { startSandbox } from "../server.mjs";
import { validateSandboxStatus } from "../status-contract.mjs";
import {
  catalogPayload,
  FIXED_NOW,
  FIXTURE_STORE,
  FIXTURE_TOKEN,
  healthPayload,
  productNode,
  productPayload,
  searchRequest,
  sequenceFetch,
} from "./helpers/shopify-fixtures.mjs";

function requestJson(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : String(options.body);
    const request = httpRequest(new URL(pathname, baseUrl), {
      method: options.method || "GET",
      headers: {
        ...(body === null ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        }),
        ...(options.headers || {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { parsed = null; }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text,
          body: parsed,
        });
      });
    });
    request.on("error", reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertLiveResponseBoundary(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["x-send-from-china-sandbox-mode"], "shopify_read_only");
  assert.doesNotMatch(JSON.stringify({ headers: response.headers, body: response.body }), new RegExp(FIXTURE_TOKEN, "u"));
}

test("live server exposes only verified status and compatible read-only search/product shapes", async () => {
  const fixtureProduct = productNode();
  const recording = sequenceFetch([
    healthPayload(),
    catalogPayload([]),
    catalogPayload([fixtureProduct]),
    productPayload(fixtureProduct),
  ]);
  const provider = createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE,
    accessToken: FIXTURE_TOKEN,
    fetchImpl: recording.fetchImpl,
    now: () => FIXED_NOW,
  });
  const started = await startVerifiedShopifySandbox({ provider, port: 0 });
  const live = started.sandbox;
  const synthetic = await startSandbox({ port: 0 });
  assert.ok(live);
  try {
    const status = await requestJson(live.baseUrl, "/sandbox/status?mode=synthetic_local_sandbox", {
      headers: { "x-sandbox-mode": "synthetic_local_sandbox" },
    });
    assert.equal(status.status, 200);
    assert.equal(validateSandboxStatus(status.body), true);
    assert.equal(status.body.mode, "shopify_read_only");
    assert.equal(status.body.verified, true);
    assert.equal(status.body.credential_state, "succeeded");
    assert.equal(status.body.writes, false);
    assert.equal(status.body.capabilities.cart, false);
    assert.equal(status.body.capabilities.product_mutation, false);
    assertLiveResponseBoundary(status);

    const liveSearch = await requestJson(live.baseUrl, "/sandbox/api/search/v2", {
      method: "POST",
      body: JSON.stringify(searchRequest()),
    });
    assert.equal(liveSearch.status, 200);
    assert.equal(liveSearch.body.results[0].handle, fixtureProduct.handle);
    assert.deepEqual(liveSearch.body.results[0].price, { amount: 19.95, currency: "USD" });
    assert.equal(liveSearch.body.results[0].availableForSale, fixtureProduct.availableForSale);
    assert.equal(liveSearch.body.results[0].product_url, fixtureProduct.onlineStoreUrl);
    assert.equal(liveSearch.body.results[0].shopify_verified_at, "2026-08-31T00:00:00.000Z");
    assert.equal(liveSearch.body.results[0].non_transactional, true);
    assert.equal(liveSearch.body.results[0].writes, false);
    assert.equal(projectSearchContractV2Response(liveSearch.body).mode, "shopify_read_only");
    assertLiveResponseBoundary(liveSearch);

    const liveProduct = await requestJson(live.baseUrl, `/sandbox/api/products/${fixtureProduct.handle}`);
    assert.equal(liveProduct.status, 200);
    assert.equal(liveProduct.body.product.handle, fixtureProduct.handle);
    assert.equal(liveProduct.body.product.product_url, fixtureProduct.onlineStoreUrl);
    assert.equal(liveProduct.body.product.shopify_verified_at, "2026-08-31T00:00:00.000Z");
    assert.equal(liveProduct.body.product.transaction_boundary, "catalog_read_only_non_transactional");
    assertLiveResponseBoundary(liveProduct);

    const publicText = JSON.stringify({ status: status.body, search: liveSearch.body, product: liveProduct.body });
    assert.doesNotMatch(publicText, /vendor|metafield|cost_price|internal_product_id|raw_response/iu);

    const syntheticSearch = await requestJson(synthetic.baseUrl, "/sandbox/api/search/v2", {
      method: "POST",
      body: JSON.stringify(searchRequest({
        product_identity: {
          name: "product_identity",
          value: "desk organizer",
          source: "explicit",
          scope: "product",
          hardness: "hard",
        },
      })),
    });
    const syntheticProduct = await requestJson(synthetic.baseUrl, "/sandbox/api/products/modular-desk-organizer");
    assert.equal(syntheticSearch.status, 200);
    assert.equal(syntheticProduct.status, 200);
    assert.deepEqual(sortedKeys(liveSearch.body), sortedKeys(syntheticSearch.body));
    assert.deepEqual(sortedKeys(liveProduct.body), sortedKeys(syntheticProduct.body));
    assert.equal(typeof liveSearch.body.results[0].handle, typeof syntheticSearch.body.results[0].handle);
    assert.equal(typeof liveProduct.body.product.availableForSale, typeof syntheticProduct.body.product.availableForSale);

    const callsBeforeRejectedRoutes = recording.calls.length;
    for (const [method, pathname, body] of [
      ["GET", "/sandbox/mcp", null],
      ["POST", "/sandbox/mcp", "{}"],
      ["POST", "/sandbox/api/quote", "{}"],
      ["POST", "/sandbox/api/cart", "{}"],
      ["POST", "/sandbox/api/mutation", "{}"],
      ["POST", "/sandbox/graphql", "{}"],
      ["POST", "/sandbox/proxy", "{}"],
      ["POST", "/sandbox/api/graphql", "{}"],
      ["POST", "/sandbox/api/proxy", "{}"],
      ["POST", `/sandbox/api/products/${fixtureProduct.handle}`, "{}"],
      ["POST", "/sandbox/api/search/v2", JSON.stringify({
        ...searchRequest(),
        query: "mutation Forbidden { productUpdate(input: {}) { product { handle } } }",
      })],
      ["POST", "/sandbox/api/search/v2?mode=synthetic_local_sandbox", JSON.stringify(searchRequest())],
      ["GET", `/sandbox/api/products/${fixtureProduct.handle}?mode=synthetic_local_sandbox`, null],
      ["GET", "/api/search?q=demo", null],
    ]) {
      const response = await requestJson(live.baseUrl, pathname, { method, ...(body === null ? {} : { body }) });
      assert.ok([400, 404].includes(response.status), `${method} ${pathname}`);
      assert.doesNotMatch(response.text, new RegExp(FIXTURE_TOKEN, "u"));
    }
    assert.equal(recording.calls.length, callsBeforeRejectedRoutes);
  } finally {
    await Promise.all([live.close(), synthetic.close()]);
  }
});

test("missing Shopify credentials prevent startup with no synthetic fallback or fetch", async () => {
  let calls = 0;
  const started = await startVerifiedShopifySandbox({
    environment: {},
    fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
    port: 0,
  });
  assert.equal(started.sandbox, null);
  assert.equal(started.status.mode, "shopify_read_only");
  assert.equal(started.status.verified, false);
  assert.equal(started.status.credential_state, "credential_missing");
  assert.equal(started.status.error_code, "CREDENTIAL_MISSING");
  assert.equal(calls, 0);
});

test("default synthetic server makes zero outbound fetches and cannot be switched by browser input", async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("unexpected external request");
  };
  let sandbox;
  try {
    sandbox = await startSandbox({ port: 0 });
    const status = await requestJson(sandbox.baseUrl, "/sandbox/status?mode=shopify_read_only", {
      headers: {
        "x-sandbox-mode": "shopify_read_only",
        "x-shopify-sandbox-mode": "shopify_read_only",
      },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.mode, "synthetic_local_sandbox");
    assert.equal(status.body.credential_state, "mock_ready");

    const search = await requestJson(sandbox.baseUrl, "/sandbox/api/search/v2", {
      method: "POST",
      headers: { "x-sandbox-mode": "shopify_read_only" },
      body: JSON.stringify(searchRequest({
        product_identity: {
          name: "product_identity",
          value: "desk organizer",
          source: "explicit",
          scope: "product",
          hardness: "hard",
        },
      })),
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.mode, "synthetic_local_sandbox");
    assert.equal(search.headers["cache-control"], "no-store");
    assert.equal(search.headers["set-cookie"], undefined);
    assert.doesNotMatch(search.text, new RegExp(sandbox.token, "u"));

    const product = await requestJson(sandbox.baseUrl, "/sandbox/api/products/modular-desk-organizer");
    assert.equal(product.status, 200);
    assert.equal(product.headers["cache-control"], "no-store");
    assert.equal(product.headers["set-cookie"], undefined);
    assert.doesNotMatch(product.text, new RegExp(sandbox.token, "u"));

    const bodySwitch = await requestJson(sandbox.baseUrl, "/sandbox/api/search/v2", {
      method: "POST",
      body: JSON.stringify({ ...searchRequest(), mode: "shopify_read_only" }),
    });
    assert.equal(bodySwitch.status, 400);
    assert.notEqual(bodySwitch.body?.mode, "shopify_read_only");
    assert.equal(externalCalls, 0);
  } finally {
    await sandbox?.close();
    globalThis.fetch = originalFetch;
  }
});
