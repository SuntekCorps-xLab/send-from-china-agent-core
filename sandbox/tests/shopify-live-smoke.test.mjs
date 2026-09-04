import assert from "node:assert/strict";
import { test } from "node:test";

import { runShopifyKnownQuerySmoke } from "../shopify-live-smoke.mjs";
import { createShopifyReadOnlyProvider } from "../shopify-provider.mjs";
import {
  catalogPayload, FIXED_NOW, FIXTURE_STORE, FIXTURE_TOKEN, healthPayload,
  productNode, sequenceFetch,
} from "./helpers/shopify-fixtures.mjs";

const gates = { SHOPIFY_LIVE_SMOKE: "1", SHOPIFY_DEVELOPMENT_STORE_CONFIRMED: "1" };
function knownCases() {
  return Array.from({ length: 20 }, (_, index) => ({ query: `known fixture ${index + 1}`, expected_handles: ["public-demo-product"] }));
}
function configured(recording) {
  return createShopifyReadOnlyProvider({
    storeDomain: FIXTURE_STORE, accessToken: FIXTURE_TOKEN,
    fetchImpl: recording.fetchImpl, now: () => FIXED_NOW,
  });
}

test("known-query smoke requires both opt-ins and exactly 20 distinct valid cases before network", async () => {
  let calls = 0;
  const provider = { getStatus: async () => { calls += 1; throw new Error("must not run"); } };
  for (const [environment, cases, code] of [
    [{}, knownCases(), "LIVE_OPT_IN_REQUIRED"],
    [{ SHOPIFY_LIVE_SMOKE: "1" }, knownCases(), "DEVELOPMENT_STORE_CONFIRMATION_REQUIRED"],
    [gates, knownCases().slice(0, 19), "INVALID_KNOWN_QUERY_MANIFEST"],
    [gates, Array(20).fill(knownCases()[0]), "INVALID_KNOWN_QUERY_MANIFEST"],
    [gates, [...knownCases().slice(1), { query: "bad", expected_handles: ["bad/handle"] }], "INVALID_KNOWN_QUERY_MANIFEST"],
    [gates, [...knownCases().slice(1), { query: "bad", expected_handles: ["valid"], endpoint: "https://example.com" }], "INVALID_KNOWN_QUERY_MANIFEST"],
  ]) {
    const result = await runShopifyKnownQuerySmoke({ environment, cases, provider });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.error_code, code);
  }
  assert.equal(calls, 0);
});

test("known-query smoke runs doctor plus 20 injected fixed catalog queries without external fetch", async () => {
  const recording = sequenceFetch([healthPayload(), catalogPayload([]), ...Array.from({ length: 20 }, () => catalogPayload())]);
  const output = [];
  const result = await runShopifyKnownQuerySmoke({
    environment: gates, cases: knownCases(), provider: configured(recording), writeOutput: (value) => output.push(value),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.doctor_verified, true);
  assert.equal(result.report.passed_queries, 20);
  assert.equal(result.report.attempted_queries, 20);
  assert.equal(result.report.failed_queries, 0);
  assert.equal(result.report.writes, false);
  assert.equal(recording.calls.length, 22);
  assert.deepEqual(recording.calls.slice(2).map((call) => call.body.variables.query), knownCases().map((entry) => entry.query));
  assert.ok(recording.calls.every((call) => call.init.method === "POST" && !/\bmutation\b/iu.test(call.body.query)));
  assert.doesNotMatch(output.join(""), /known fixture|public-demo-product|myshopify|raw_response/u);
  assert.ok(!output.join("").includes(FIXTURE_TOKEN));
});

test("known-query smoke fails empty and mismatched cases, contains provider errors, and records all 20 outcomes", async () => {
  const recording = sequenceFetch([
    healthPayload(), catalogPayload([]), catalogPayload([]),
    catalogPayload([productNode({ handle: "different-product" })]),
    () => { throw new Error(`private upstream ${FIXTURE_TOKEN}`); },
    ...Array.from({ length: 17 }, () => catalogPayload()),
  ]);
  const output = [];
  const result = await runShopifyKnownQuerySmoke({
    environment: gates, cases: knownCases(), provider: configured(recording), writeOutput: (value) => output.push(value),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.state, "failed");
  assert.equal(result.report.attempted_queries, 20);
  assert.equal(result.report.passed_queries, 0);
  assert.equal(result.report.failed_queries, 20);
  assert.equal(recording.calls.length, 5, "A cached unhealthy provider must not retry after the upstream failure");
  assert.deepEqual(result.report.cases.slice(0, 3).map((entry) => entry.error_code),
    ["KNOWN_QUERY_MISMATCH", "KNOWN_QUERY_MISMATCH", "SERVICE_UNAVAILABLE"]);
  assert.ok(!output.join("").includes(FIXTURE_TOKEN));
  assert.doesNotMatch(output.join(""), /private upstream|different-product/u);
});

test("known-query smoke refuses degraded or relaxed matches", async () => {
  const recording = sequenceFetch([healthPayload(), catalogPayload([]), ...Array.from({ length: 20 }, () => catalogPayload())]);
  const live = configured(recording);
  const provider = {
    getStatus: (...args) => live.getStatus(...args),
    async search(request) {
      const result = await live.search(request);
      return { ...result, status: "degraded", search_scope: { ...result.search_scope, degraded: true, degraded_reason: "Constraint unavailable." } };
    },
  };
  const result = await runShopifyKnownQuerySmoke({ environment: gates, cases: knownCases(), provider });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.passed_queries, 0);
  assert.equal(result.report.failed_queries, 20);
});

test("known-query smoke blocks missing credentials and never reflects unexpected doctor errors", async () => {
  let fetches = 0;
  const missing = await runShopifyKnownQuerySmoke({
    environment: gates, cases: knownCases(), fetchImpl: async () => { fetches += 1; throw new Error("must not run"); },
  });
  assert.equal(missing.report.error_code, "CREDENTIAL_MISSING");
  assert.equal(fetches, 0);
  const result = await runShopifyKnownQuerySmoke({
    environment: gates, cases: knownCases(),
    provider: { getStatus: async () => { throw new Error(FIXTURE_TOKEN); } },
  });
  assert.equal(result.report.error_code, "SERVICE_UNAVAILABLE");
  assert.ok(!JSON.stringify(result).includes(FIXTURE_TOKEN));
});

test("known-query smoke refuses ordinary results containing only a relaxation", async () => {
  const recording = sequenceFetch([healthPayload(), catalogPayload([]), ...Array.from({ length: 20 }, () => catalogPayload())]);
  const live = configured(recording);
  const result = await runShopifyKnownQuerySmoke({
    environment: gates, cases: knownCases(), provider: {
      getStatus: (...args) => live.getStatus(...args),
      async search(request) {
        const response = await live.search(request);
        return { ...response, relaxations: [{ condition: "material", reason: "The condition was not evaluated." }] };
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.passed_queries, 0);
  assert.equal(result.report.failed_queries, 20);
  assert.ok(result.report.cases.every((entry) => entry.error_code === "KNOWN_QUERY_MISMATCH"));
});
