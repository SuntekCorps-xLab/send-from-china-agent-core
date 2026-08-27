import assert from "node:assert/strict";
import test from "node:test";

import fixture from "../../fixtures/published-catalog.sample.json" with { type: "json" };
import { FieldPolicyError, toPublicProduct } from "../src/field-policy.js";

function base(overrides = {}) {
  return {
    public_id: "Z9y8X7w6V5u4T3s2R1q0Pn",
    slug: "safe-product",
    title: "Safe Product",
    availability_band: "in_stock",
    ...overrides,
  };
}

test("positive policy drops poison fields without echoing their names", () => {
  const poison = {
    cost: 1, supplier_name: "hidden", source_url: "https://private.invalid",
    internal_product_id: "private", platform_listing_id: "private", margin_rate: 0.5,
    warehouse_code: "hidden", competitor_price: 2,
  };
  const output = toPublicProduct(base({
    ...poison,
    source: "private-source-record",
    attributes: {
      material: "wood",
      brand: "Public Brand",
      model: "PB-100",
      certification: "Illustrative certification",
      width_cm: 24,
      supplier_url: "https://supplier.invalid/item",
      cost_price: 1,
      api_key: "hidden",
      accessToken: "hidden",
      clientSecret: "hidden",
      customerEmail: "hidden@example.invalid",
      supplierId: "hidden",
      actionUrl: "https://checkout.invalid",
      unknown_future_key: "drop until reviewed",
      nested: { supplier_name: "hidden" },
    },
  }));
  const rendered = JSON.stringify(output);
  for (const name of Object.keys(poison)) assert.doesNotMatch(rendered, new RegExp(name));
  assert.deepEqual(output.attributes, {
    material: "wood",
    brand: "Public Brand",
    model: "PB-100",
    certification: "Illustrative certification",
    width_cm: 24,
  });
  assert.equal("source" in output, false);
  assert.notEqual(output, poison);
});

test("attribute policy is a positive lower-snake-case allowlist", () => {
  const output = toPublicProduct(base({
    attributes: {
      material: "steel",
      capacity_ml: 480,
      Material: "not canonical",
      access_token: "private",
      arbitrary_public_sounding_name: "not reviewed",
    },
  }));
  assert.deepEqual(output.attributes, { material: "steel", capacity_ml: 480 });
});

test("missing required fields fail with a generic policy error", () => {
  assert.throws(() => toPublicProduct({ title: "Missing identity" }), FieldPolicyError);
  assert.throws(() => toPublicProduct(base({ availability_band: "unknown" })), FieldPolicyError);
});

test("unknown fields are discarded instead of passed through", () => {
  const output = toPublicProduct(base({ future_private_field: "drop me" }));
  assert.equal("future_private_field" in output, false);
});

test("fixture public identifiers are opaque 22-character base62 values", () => {
  for (const product of fixture.products) {
    assert.match(product.public_id, /^[A-Za-z0-9]{22}$/);
    const renderedId = product.public_id.toLowerCase();
    for (const fragment of [...product.slug.split("-"), ...product.title.toLowerCase().split(/\s+/)]) {
      if (fragment.length >= 4) assert.equal(renderedId.includes(fragment), false);
    }
  }
});
