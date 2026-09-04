import assert from "node:assert/strict";
import test from "node:test";

import { applyShopifyHardConstraints } from "../shopify-constraints.mjs";

const hard = (name, value) => Object.freeze({ name, value, source: "explicit", scope: "product", hardness: "hard" });
const product = (handle, changes = {}) => ({
  handle,
  title: "Public bottle",
  description: "Reusable catalog bottle.",
  price: { amount: 20, currency: "USD" },
  attributes: { material: "stainless steel", model: "PB-100", color: "navy", feature: "dishwasher safe" },
  ...changes,
});
const apply = (products, ...constraints) => applyShopifyHardConstraints(products, { hard_constraints: constraints });
const handles = (result) => result.products.map((entry) => entry.handle);

test("inclusive minimum and maximum prices filter locally without relaxing evaluated conditions", () => {
  const input = [product("low", { price: { amount: 19.99, currency: "USD" } }), product("edge"),
    product("high", { price: { amount: 20.01, currency: "USD" } })];
  const result = apply(input, hard("price_min", 20), hard("price_max", 20));
  assert.deepEqual(handles(result), ["edge"]);
  assert.deepEqual(result.relaxations, []);
  assert.equal(result.degraded, false);
  assert.equal(result.products[0], input[1]);
  assert.deepEqual(handles(apply([product("free", { price: { amount: 0, currency: "USD" } })],
    hard("price_max", 0))), ["free"]);
});

test("price data absence and mixed currencies cannot claim proven hard matches", () => {
  for (const price of [undefined, { amount: "20", currency: "USD" }, { amount: NaN, currency: "USD" },
    { amount: 20, currency: "" }, { amount: -1, currency: "USD" }]) {
    const result = apply([product("unknown", { price })], hard("price_max", 25));
    assert.deepEqual(result.products, []);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.relaxations.map((entry) => entry.condition), ["price_max"]);
  }
  const mixed = apply([product("usd"), product("eur", { price: { amount: 10, currency: "EUR" } })],
    hard("price_max", 20));
  assert.equal(mixed.degraded, true);
  assert.match(mixed.relaxations[0].reason, /different currencies/u);
});

test("material and color checks use published attributes with conjunctive arrays", () => {
  const matching = product("mixed", { attributes: { materials: "cotton linen", colour: "navy" } });
  const result = apply([matching, product("steel")], hard("material", ["cotton", "linen"]), hard("color", "navy"));
  assert.deepEqual(handles(result), ["mixed"]);
  assert.deepEqual(result.relaxations, []);
  assert.equal(result.degraded, false);
  const missing = apply([product("missing", { title: "Cotton bottle", attributes: {} })], hard("material", "cotton"));
  assert.equal(missing.degraded, true);
  assert.deepEqual(missing.products, []);
  assert.match(missing.relaxations[0].reason, /unverified candidates were omitted/u);
});

test("model identities are exact and do not match numbered or Pro variants", () => {
  const input = [product("exact"), product("prefix", { attributes: { model: "PB-1000" } }),
    product("variant", { attributes: { model: "PB-100 Pro" } }),
    product("other", { attributes: { model: "PB-10" } }),
    product("list", { attributes: { compatible_models: "PB-90; pb-100" } })];
  const result = apply(input, hard("model", "PB-100"));
  assert.deepEqual(handles(result), ["exact", "list"]);
  assert.equal(result.degraded, false);
  const missing = apply([product("unknown", { attributes: { feature: "PB-100" } })], hard("model", "PB-100"));
  assert.equal(missing.degraded, true);
  assert.deepEqual(missing.products, []);
});

test("must_have remains compatible with model tokens and requires the whole literal phrase", () => {
  const result = apply([product("exact"), product("prefix", { attributes: { model: "PB-1000" } })],
    hard("must_have", ["PB-100", "reusable catalog bottle"]));
  assert.deepEqual(handles(result), ["exact"]);
  assert.deepEqual(result.relaxations, []);
  assert.deepEqual(apply([product("wrong-order")], hard("must_have", "bottle catalog")).products, []);
});

test("negated public terms never satisfy positive requirements or trigger false exclusions", () => {
  const free = product("free", { title: "Leather-free pouch", description: "Made without leather.",
    attributes: { material: "non-leather fabric", feature: "PVC-free" } });
  const leather = product("leather", { title: "Leather pouch", description: "With leather trim.",
    attributes: { material: "leather" } });
  assert.deepEqual(handles(apply([free, leather], hard("exclude", "leather"))), ["free"]);
  assert.deepEqual(handles(apply([free, leather], hard("must_have", "without leather"))), ["free"]);
  assert.deepEqual(handles(apply([free, leather], hard("material", "leather"))), ["leather"]);
  assert.deepEqual(handles(apply([free, leather], hard("material", "not leather"))), ["free"]);
  assert.deepEqual(handles(apply([free], hard("exclude", "PVC"))), ["free"]);
});

test("conjunction resets and affirmative occurrences preserve deterministic negation scope", () => {
  const mixed = product("mixed", { attributes: { material: "not leather but cotton; leather trim" } });
  assert.deepEqual(handles(apply([mixed], hard("material", "cotton"))), ["mixed"]);
  assert.deepEqual(apply([mixed], hard("exclude", "leather")).products, []);
  const ambiguous = product("ambiguous", { title: "Pouch", description: "Not without leather.", attributes: {} });
  const result = apply([ambiguous], hard("exclude", "leather"));
  assert.equal(result.degraded, true);
  assert.deepEqual(result.products, []);
});

test("known hard failures exclude a candidate even when a different condition lacks data", () => {
  const result = apply([product("failed", { attributes: {} })], hard("price_max", 10), hard("material", "cotton"));
  assert.deepEqual(result.products, []);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.relaxations, []);
});

test("unsupported conditions and Boolean operands remain explicit even for an empty page", () => {
  for (const condition of [hard("size", "large"), hard("price_max", "20"), hard("material", "cotton OR silk"),
    hard("must_have", "> 20 watts"), hard("model", "not without PB-100")]) {
    const result = apply([], condition);
    assert.deepEqual(result.products, []);
    assert.equal(result.degraded, true);
    assert.equal(result.relaxations.length, 1);
    assert.equal(result.relaxations[0].condition, condition.name);
    assert.match(result.relaxations[0].reason, /cannot execute/u);
    assert.equal(Object.hasOwn(result.relaxations[0], "from"), false);
  }
});

test("private or unknown product fields cannot influence public checks or diagnostics", () => {
  const candidate = product("private-field", { attributes: { vendor: "leather", custom_field: "leather" },
    vendor: "leather", internal_id: "leather", raw: { description: "leather" },
    images: [{ url: "https://example.com/leather.png", alt: "leather" }] });
  const result = apply([candidate], hard("exclude", "leather"));
  assert.deepEqual(handles(result), ["private-field"]);
  assert.equal(result.degraded, false);
  const unknown = apply([candidate], hard("material", "leather"));
  assert.equal(unknown.degraded, true);
  assert.equal(JSON.stringify(unknown.relaxations).includes("leather"), false);
});

test("unknown diagnostics are deduplicated and output containers are immutable", () => {
  const result = apply([product("first", { attributes: {} }), product("second", { attributes: {} })],
    hard("material", "cotton"), hard("material", "linen"));
  assert.equal(result.relaxations.length, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.products), true);
  assert.equal(Object.isFrozen(result.relaxations), true);
  assert.equal(Object.isFrozen(result.relaxations[0]), true);
});

test("checks are pure, deterministic and perform no outbound fetch", () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = () => { attempts += 1; throw new Error("Unexpected network request"); };
  try {
    const input = [product("matching"), product("failed", { price: { amount: 25, currency: "USD" } })];
    const before = JSON.stringify(input);
    const request = { hard_constraints: [hard("price_max", 20), hard("material", "steel")] };
    assert.deepEqual(applyShopifyHardConstraints(input, request), applyShopifyHardConstraints(input, request));
    assert.equal(JSON.stringify(input), before);
    assert.equal(attempts, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("independent option lists cannot prove a variant combination or a selected variant price", () => {
  const candidate = product("choices", { attributes: { material: "cotton, linen", model: "PB-100", size: "S, L" } });
  const byPrice = apply([candidate], hard("price_max", 20), hard("material", "linen"));
  assert.deepEqual(byPrice.products, []);
  assert.equal(byPrice.degraded, true);
  assert.deepEqual(byPrice.relaxations.map((entry) => entry.condition), ["price_max", "material"]);
  assert.match(byPrice.relaxations[0].reason, /variant combination or its price/u);
  const byOptions = apply([candidate], hard("material", ["cotton", "linen"]));
  assert.deepEqual(byOptions.products, []);
  assert.equal(byOptions.degraded, true);
  // A numeric starting-price constraint remains valid on its own.
  assert.deepEqual(handles(apply([candidate], hard("price_max", 20))), ["choices"]);
  assert.equal(apply([candidate], hard("price_max", 20)).degraded, false);
});

test("provider-only variant metadata remains private and supersedes ambiguous joined text", () => {
  const candidate = product("hidden-options");
  const request = { hard_constraints: [hard("price_max", 20), hard("material", "steel")] };
  const result = applyShopifyHardConstraints([candidate], request, { hasVariantChoices: () => true });
  assert.deepEqual(result.products, []);
  assert.equal(result.degraded, true);
  assert.equal(JSON.stringify(result).includes("hidden-options"), false);
  const composition = product("composition", { attributes: { material: "cotton, linen" } });
  const definite = applyShopifyHardConstraints([composition], {
    hard_constraints: [hard("material", ["cotton", "linen"])],
  }, { hasVariantChoices: () => false });
  assert.deepEqual(handles(definite), ["composition"]);
  assert.equal(definite.degraded, false);
});

test("negation scope includes compatibility phrases and contracted negatives", () => {
  for (const description of ["Not compatible with PB-100.", "Isn't compatible with PB-100.",
    "This is not made with PB-100."]) {
    const candidate = product("incompatible", { title: "Public accessory", description, attributes: {} });
    assert.deepEqual(apply([candidate], hard("must_have", "PB-100")).products, []);
    assert.deepEqual(handles(apply([candidate], hard("exclude", "PB-100"))), ["incompatible"]);
  }
  const withCotton = product("cotton", { title: "Pouch", description: "Not leather with cotton.", attributes: {} });
  assert.deepEqual(handles(apply([withCotton], hard("must_have", "cotton"))), ["cotton"]);
});
