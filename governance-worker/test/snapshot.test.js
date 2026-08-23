import assert from "node:assert/strict";
import test from "node:test";

import fixture from "../../fixtures/published-catalog.sample.json" with { type: "json" };
import { loadSnapshot, SnapshotError } from "../src/snapshot.js";

function copy() { return JSON.parse(JSON.stringify(fixture)); }

test("a valid snapshot loads as one governed unit", () => {
  const snapshot = loadSnapshot(copy(), { activate: false, now: "2026-08-21T12:00:00Z" });
  assert.equal(snapshot.products.length, 12);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.products[0].as_of, fixture.generated_at);
});

test("unsupported schema versions reject the entire snapshot", () => {
  const value = copy();
  value.schema_version = 2;
  assert.throws(() => loadSnapshot(value, { activate: false }), SnapshotError);
});

test("one product with an undeclared field rejects the entire snapshot", () => {
  const value = copy();
  value.products[4].undeclared_field = "must fail";
  assert.throws(() => loadSnapshot(value, { activate: false }), SnapshotError);
});

test("an expired snapshot loads but is explicitly stale", () => {
  const value = copy();
  value.valid_until = "2026-08-20T00:00:00Z";
  const snapshot = loadSnapshot(value, { activate: false, now: "2026-08-21T00:00:00Z" });
  assert.equal(snapshot.stale, true);
});
