import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import { apiRequest, catalog, detail, health, INVITE, requestBody, sequenceFetch, testEnv, TOKEN } from "./helpers.mjs";

async function responseJson(response) {
  return { response, body: await response.json() };
}

test("static asset routing is an exact allowlist and never publishes server or test files", async () => {
  const requested = [];
  const env = testEnv(async () => { throw new Error("no upstream"); }, {
    ASSETS: { fetch: async (request) => { requested.push(new URL(request.url).pathname); return new Response("asset"); } },
  });
  for (const [path, expected] of [["/", "/index.html"], ["/sandbox", "/index.html"], ["/sandbox/app.js", "/app.js"], ["/sandbox/styles.css", "/styles.css"]]) {
    const response = await worker.fetch(new Request(`https://sandbox.example${path}`), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/u);
    assert.equal(requested.at(-1), expected);
  }
  for (const path of ["/sandbox/src/index.js", "/sandbox/test/worker.test.mjs", "/sandbox/wrangler.toml", "/sandbox/mcp", "/sandbox/api/chat", "/sandbox/api/quote"]) {
    const result = await responseJson(await worker.fetch(new Request(`https://sandbox.example${path}`), env));
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error.code, "SANDBOX_ROUTE_NOT_ALLOWED");
  }
});

test("protected API rejects missing invite, cross-origin input, credential headers, and rate-limit failure before upstream", async () => {
  let upstreamCalls = 0;
  const fetch = async () => { upstreamCalls += 1; throw new Error("not expected"); };
  const env = testEnv(fetch);
  let result = await responseJson(await worker.fetch(new Request("https://sandbox.example/sandbox/status"), env));
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error.code, "INVITE_REQUIRED");

  result = await responseJson(await worker.fetch(apiRequest("/sandbox/status", { headers: { origin: "https://other.example" } }), env));
  assert.equal(result.response.status, 403);
  result = await responseJson(await worker.fetch(apiRequest("/sandbox/status", { headers: { authorization: "blocked-browser-value" } }), env));
  assert.equal(result.response.status, 403);
  result = await responseJson(await worker.fetch(apiRequest("/sandbox/status", { headers: { cookie: "session=browser-value" } }), env));
  assert.equal(result.response.status, 403);

  const denied = testEnv(fetch, { SANDBOX_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  result = await responseJson(await worker.fetch(apiRequest("/sandbox/status"), denied));
  assert.equal(result.response.status, 429);
  assert.equal(result.body.error.code, "QUOTA_EXCEEDED");
  assert.equal(upstreamCalls, 0);
});

test("pre-auth rate limiting uses one global key before any invite-specific key", async () => {
  const keys = [];
  const env = testEnv(async () => { throw new Error("not expected"); }, {
    SANDBOX_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } },
  });
  const invalid = apiRequest("/sandbox/status", { headers: { "x-sandbox-invite": "different-invalid-preview-proof-12345" } });
  const response = await worker.fetch(invalid, env);
  assert.equal(response.status, 401);
  assert.deepEqual(keys, ["hosted-sandbox-preauth"]);
});

test("status, search, and product are the only live API routes and keep the token server-side", async () => {
  const upstream = sequenceFetch([health(), catalog(), catalog(), detail()]);
  const env = testEnv(upstream.fetch);
  const status = await responseJson(await worker.fetch(apiRequest("/sandbox/status"), env));
  assert.equal(status.response.status, 200);
  assert.equal(status.body.verified, true);

  const search = await responseJson(await worker.fetch(apiRequest("/sandbox/api/search/v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody()),
  }), env));
  assert.equal(search.response.status, 200);
  assert.equal(search.body.results.length, 1);

  const product = await responseJson(await worker.fetch(apiRequest("/sandbox/api/products/public-demo-product"), env));
  assert.equal(product.response.status, 200);
  assert.equal(product.body.product.handle, "public-demo-product");
  for (const result of [status, search, product]) {
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("set-cookie"), null);
    assert.equal(result.response.headers.get("access-control-allow-origin"), null);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(TOKEN, "u"));
  }
});

test("search request parser rejects wrong method, query strings, content type, unknown fields, and oversized bodies", async () => {
  const upstream = sequenceFetch([]);
  const env = testEnv(upstream.fetch);
  const cases = [
    apiRequest("/sandbox/api/search/v2", { method: "GET" }),
    apiRequest("/sandbox/api/search/v2?mode=live", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    apiRequest("/sandbox/api/search/v2", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
    apiRequest("/sandbox/api/search/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...requestBody(), unknown: true }) }),
    apiRequest("/sandbox/api/search/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(40_000) }) }),
  ];
  const expected = [404, 400, 400, 400, 413];
  for (let index = 0; index < cases.length; index += 1) {
    const response = await worker.fetch(cases[index], env);
    assert.equal(response.status, expected[index]);
  }
  assert.equal(upstream.calls.length, 0);
});

test("public deployment fails closed when assets, rate limit, access hash, or Shopify credentials are absent", async () => {
  const base = testEnv(async () => { throw new Error("no upstream"); }, { SANDBOX_DEPLOYMENT_MODE: "public" });
  let response = await worker.fetch(apiRequest("/sandbox/status"), { ...base, ASSETS: undefined });
  assert.equal(response.status, 503);
  response = await worker.fetch(apiRequest("/sandbox/status"), { ...base, SANDBOX_RATE_LIMITER: undefined });
  assert.equal(response.status, 503);
  response = await worker.fetch(apiRequest("/sandbox/status"), { ...base, SANDBOX_INVITE_SHA256: undefined });
  assert.equal(response.status, 401);
  const missingShopify = { ...base, SHOPIFY_STORE_DOMAIN: undefined, SHOPIFY_STOREFRONT_ACCESS_TOKEN: undefined };
  const result = await responseJson(await worker.fetch(apiRequest("/sandbox/status"), missingShopify));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.verified, false);
  assert.equal(result.body.credential_state, "credential_missing");
  assert.equal(result.body.credential_exposed, false);
  assert.equal(INVITE.length >= 20, true);
});
