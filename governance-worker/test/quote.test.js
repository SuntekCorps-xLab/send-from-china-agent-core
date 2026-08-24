import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { resetTenantState } from "../src/tenant.js";
import { ALPHA_KEY, BETA_KEY, ENV, authorization } from "./test-env.js";

beforeEach(() => resetTenantState());

function quote(publicId, key = ALPHA_KEY) {
  return worker.fetch(new Request("https://worker.example/api/quote", {
    method: "POST",
    headers: { ...authorization(key), "Content-Type": "application/json" },
    body: JSON.stringify({ public_id: publicId, quantity: 2, ship_to: "US" }),
  }), ENV);
}

test("quote returns a short-lived non-binding contract", async () => {
  const before = Date.now();
  const response = await quote("A1b2C3d4E5f6G7h8J9k0Lm");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.quote_id, /^quote_/);
  assert.equal(body.quote_kind, "catalog_estimate");
  assert.deepEqual(body.unit_price, { amount: 24.9, currency: "USD" });
  assert.equal(body.quantity, 2);
  assert.equal(body.ship_to, "US");
  assert.equal(body.availability, "in_stock");
  assert.equal(body.shipping_included, false);
  assert.equal(body.tax_included, false);
  assert.equal(body.destination_evaluated, false);
  assert.equal(body.binding, false);
  assert.ok(Date.parse(body.expires_at) > before);
});

test("unknown public identifiers return 404", async () => {
  const response = await quote("Z1y2X3w4V5u6T7s8R9q0Pn");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PRODUCT_NOT_FOUND");
});

test("a tenant cannot quote another tenant's product", async () => {
  const response = await quote("A1b2C3d4E5f6G7h8J9k0Lm", BETA_KEY);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PRODUCT_NOT_FOUND");
});
