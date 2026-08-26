import { SNAPSHOT_PRODUCT_FIELDS, toPublicProduct } from "./field-policy.js";

const TOP_LEVEL_FIELDS = new Set(["schema_version", "generated_at", "valid_until", "products", "tenant_scopes"]);
const PRODUCT_FIELDS = new Set(SNAPSHOT_PRODUCT_FIELDS);
let activeSnapshot = null;

export class SnapshotError extends Error {
  constructor(code = "INVALID_SNAPSHOT") {
    super("Published catalog snapshot validation failed.");
    this.name = "SnapshotError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cleanScope(value, publicIds) {
  const allowed = new Set(["product_ids", "price_tier", "allow_full_enumeration"]);
  if (!exactFields(value, allowed) || !Array.isArray(value.product_ids)) throw new SnapshotError();
  if (typeof value.price_tier !== "string" || typeof value.allow_full_enumeration !== "boolean") throw new SnapshotError();
  const productIds = [...new Set(value.product_ids)];
  if (productIds.some((id) => typeof id !== "string" || !publicIds.has(id))) throw new SnapshotError();
  return Object.freeze({
    product_ids: Object.freeze(productIds),
    price_tier: value.price_tier,
    allow_full_enumeration: value.allow_full_enumeration,
  });
}

export function loadSnapshot(raw, options = {}) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { throw new SnapshotError(); }
  }
  if (!exactFields(value, TOP_LEVEL_FIELDS) || value.schema_version !== 1) throw new SnapshotError();
  if (!isoDate(value.generated_at) || !isoDate(value.valid_until)) throw new SnapshotError();
  if (!Array.isArray(value.products) || !plainObject(value.tenant_scopes)) throw new SnapshotError();
  const products = value.products.map((product) => {
    if (!exactFields(product, PRODUCT_FIELDS)) throw new SnapshotError();
    try { return Object.freeze(toPublicProduct(product, { as_of: value.generated_at })); }
    catch { throw new SnapshotError(); }
  });
  const publicIds = new Set(products.map((product) => product.public_id));
  if (publicIds.size !== products.length) throw new SnapshotError();
  const scopes = {};
  for (const [tenantId, scope] of Object.entries(value.tenant_scopes)) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(tenantId)) throw new SnapshotError();
    scopes[tenantId] = cleanScope(scope, publicIds);
  }
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (!Number.isFinite(now)) throw new SnapshotError();
  const snapshot = Object.freeze({
    schema_version: 1,
    generated_at: value.generated_at,
    valid_until: value.valid_until,
    stale: now > Date.parse(value.valid_until),
    products: Object.freeze(products),
    tenant_scopes: Object.freeze(scopes),
  });
  if (options.activate !== false) activeSnapshot = snapshot;
  return snapshot;
}

export function getSnapshotMeta(snapshot = activeSnapshot) {
  if (!snapshot) throw new SnapshotError("SNAPSHOT_NOT_LOADED");
  return {
    generated_at: snapshot.generated_at,
    valid_until: snapshot.valid_until,
    product_count: snapshot.products.length,
    stale: Date.now() > Date.parse(snapshot.valid_until),
  };
}

export function getActiveSnapshot() {
  if (!activeSnapshot) throw new SnapshotError("SNAPSHOT_NOT_LOADED");
  return activeSnapshot;
}
