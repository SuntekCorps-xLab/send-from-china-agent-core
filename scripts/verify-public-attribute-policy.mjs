import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_ATTRIBUTE_NAMES as WORKER_ATTRIBUTE_NAMES,
  PUBLIC_ATTRIBUTE_POLICY_VERSION as WORKER_POLICY_VERSION,
} from "../governance-worker/src/field-policy.js";
import {
  PUBLIC_ATTRIBUTE_NAMES as SDK_ATTRIBUTE_NAMES,
  PUBLIC_ATTRIBUTE_POLICY_VERSION as SDK_POLICY_VERSION,
} from "../sdk/src/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const policyPath = resolve(root, "contracts/public-product-attribute-policy.v1.json");
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const names = policy.enum;

assert.equal(policy.schema_version, "public-product-attributes/v1");
assert.equal(policy.type, "string");
assert.ok(Array.isArray(names) && names.length > 0);
assert.deepEqual(names, [...names].sort(), "canonical public attribute names must stay sorted");
assert.equal(new Set(names).size, names.length, "canonical public attribute names must be unique");
assert.ok(names.every((name) => /^[a-z][a-z0-9_]{0,79}$/u.test(name)));
assert.equal(WORKER_POLICY_VERSION, policy.schema_version);
assert.equal(SDK_POLICY_VERSION, policy.schema_version);
assert.deepEqual(WORKER_ATTRIBUTE_NAMES, names);
assert.deepEqual(SDK_ATTRIBUTE_NAMES, names);

const schemaRefs = [
  ["contracts/search-v2-response.schema.json", ["$defs", "product", "properties", "attributes", "propertyNames"], "./public-product-attribute-policy.v1.json"],
  ["contracts/publisher-input.schema.json", ["properties", "products", "items", "properties", "attributes", "propertyNames"], "./public-product-attribute-policy.v1.json"],
  ["contracts/published-catalog.schema.json", ["properties", "products", "items", "properties", "attributes", "propertyNames"], "./public-product-attribute-policy.v1.json"],
  ["evals/private-score/predictions.schema.json", ["$defs", "publicProduct", "properties", "attributes", "propertyNames"], "../../contracts/public-product-attribute-policy.v1.json"],
];

for (const [relative, pointer, expected] of schemaRefs) {
  const document = JSON.parse(await readFile(resolve(root, relative), "utf8"));
  const node = pointer.reduce((value, key) => value?.[key], document);
  assert.equal(node?.$ref, expected, `${relative} must reference the canonical attribute policy`);
}

const openapi = await readFile(resolve(root, "contracts/openapi.yaml"), "utf8");
assert.match(openapi, /propertyNames:\s*\{\s*\$ref:\s*"\.\/public-product-attribute-policy\.v1\.json"\s*\}/u);

console.log(`PASS: canonical public attribute policy (${names.length} names)`);
