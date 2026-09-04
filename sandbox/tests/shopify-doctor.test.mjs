import assert from "node:assert/strict";
import { test } from "node:test";

import { runShopifyDoctor } from "../shopify-doctor.mjs";
import { catalogPayload, FIXED_NOW, FIXTURE_STORE, FIXTURE_TOKEN, healthPayload, jsonResponse, sequenceFetch } from "./helpers/shopify-fixtures.mjs";

function outputCapture() {
  const output = [];
  const errors = [];
  return {
    output,
    errors,
    writeOutput: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  };
}

test("Shopify doctor reports missing credentials as closed JSON without fetch", async () => {
  let calls = 0;
  const capture = outputCapture();
  const result = await runShopifyDoctor({
    environment: {},
    args: ["--json"],
    fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
    now: () => FIXED_NOW,
    ...capture,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status.credential_state, "credential_missing");
  assert.equal(calls, 0);
  assert.equal(capture.errors.length, 0);
  assert.equal(JSON.parse(capture.output.join("")).error_code, "CREDENTIAL_MISSING");
});

test("Shopify doctor succeeds only after both injected readiness responses", async () => {
  const recording = sequenceFetch([healthPayload(), catalogPayload([])]);
  const capture = outputCapture();
  const result = await runShopifyDoctor({
    environment: {
      SHOPIFY_STORE_DOMAIN: FIXTURE_STORE,
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: FIXTURE_TOKEN,
    },
    args: ["--json"],
    fetchImpl: recording.fetchImpl,
    now: () => FIXED_NOW,
    ...capture,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.verified, true);
  assert.equal(recording.calls.length, 2);
  assert.equal(JSON.parse(capture.output.join("")).credential_state, "succeeded");
  assert.doesNotMatch(capture.output.join("") + capture.errors.join(""), new RegExp(FIXTURE_TOKEN, "u"));
});

test("Shopify doctor emits only public failures and rejects unsupported arguments", async () => {
  const auth = sequenceFetch([jsonResponse({}, { status: 401 })]);
  const capture = outputCapture();
  const result = await runShopifyDoctor({
    environment: {
      SHOPIFY_STORE_DOMAIN: FIXTURE_STORE,
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: FIXTURE_TOKEN,
    },
    args: [],
    fetchImpl: auth.fetchImpl,
    now: () => FIXED_NOW,
    ...capture,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(capture.output, []);
  assert.equal(capture.errors.join(""), "Shopify read-only sandbox doctor: AUTHENTICATION_FAILED.\n");
  assert.doesNotMatch(capture.errors.join(""), new RegExp(FIXTURE_TOKEN, "u"));

  const unsupported = outputCapture();
  const invalid = await runShopifyDoctor({
    environment: {},
    args: ["--endpoint", "https://example.com"],
    ...unsupported,
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.status, null);
  assert.match(unsupported.errors.join(""), /unsupported argument/u);
});

test("Shopify doctor contains unexpected provider failures without reflecting their message", async () => {
  const capture = outputCapture();
  const result = await runShopifyDoctor({
    provider: {
      async getStatus() { throw new Error(`upstream reflected ${FIXTURE_TOKEN}`); },
    },
    args: ["--json"],
    ...capture,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status.error_code, "SERVICE_UNAVAILABLE");
  assert.doesNotMatch(capture.output.join("") + capture.errors.join(""), new RegExp(FIXTURE_TOKEN, "u"));
});
