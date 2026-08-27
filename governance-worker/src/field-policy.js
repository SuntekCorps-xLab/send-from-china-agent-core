export const PUBLIC_PRODUCT_FIELDS = Object.freeze([
  "public_id", "slug", "title", "description", "category", "tags", "images",
  "attributes", "price", "availability_band", "lead_time_days", "as_of", "purchasable",
]);

// `source` is accepted only in the deployment-side snapshot so older published
// artifacts remain loadable. It is deliberately excluded from every product
// response; provenance must never become a supplier or source-system channel.
export const SNAPSHOT_PRODUCT_FIELDS = Object.freeze([...PUBLIC_PRODUCT_FIELDS, "source"]);

const AVAILABILITY_BANDS = new Set(["in_stock", "low", "out_of_stock"]);
const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

// Attributes are an explicitly versioned public schema, not an arbitrary
// extension bag. Keep this list synchronized with the Search Contract adapter.
// New names require a contract review and positive/negative compatibility tests.
export const PUBLIC_ATTRIBUTE_POLICY_VERSION = "public-product-attributes/v1";
export const PUBLIC_ATTRIBUTE_NAMES = Object.freeze([
  "age_range", "battery_mah", "battery_wh", "brand", "capacity_l", "capacity_ml",
  "certification", "certifications", "color", "colour", "compartment_count",
  "depth_cm", "depth_in", "depth_mm", "diameter_cm", "diameter_in", "diameter_mm",
  "dimensions", "finish", "height_cm", "height_in", "height_mm", "length_cm",
  "length_in", "length_mm", "material", "materials", "model", "pack_size",
  "pattern", "piece_count", "pieces", "pocket_count", "pockets", "shape", "size",
  "style", "thickness_cm", "thickness_in", "thickness_mm", "volume_l", "volume_ml",
  "weight_g", "weight_kg", "weight_lb", "weight_oz", "width_cm", "width_in", "width_mm",
]);
const PUBLIC_ATTRIBUTE_NAME_SET = new Set(PUBLIC_ATTRIBUTE_NAMES);

export class FieldPolicyError extends Error {
  constructor(code = "INVALID_PUBLIC_PRODUCT") {
    super("Product data does not satisfy the public field policy.");
    this.name = "FieldPolicyError";
    this.code = code;
  }
}

function optionalString(value, maxLength = 2000) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new FieldPolicyError();
  return value;
}

function cleanTags(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new FieldPolicyError();
  if (value.some((item) => typeof item !== "string" || item.length > 100)) throw new FieldPolicyError();
  return [...value];
}

function cleanImages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new FieldPolicyError();
  return value.map((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) throw new FieldPolicyError();
    const url = optionalString(image.url, 2048);
    const alt = optionalString(image.alt, 300);
    if (!url || !/^https:\/\//i.test(url)) throw new FieldPolicyError();
    const output = { url };
    if (alt !== undefined) output.alt = alt;
    return output;
  });
}

function cleanAttributes(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FieldPolicyError();
  const entries = Object.entries(value);
  if (entries.length > 50) throw new FieldPolicyError();
  const output = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new FieldPolicyError();
    if (!publicAttributeName(key) || privateAttributeName(key) || containsPrivateAttribute(item)) continue;
    if (typeof item !== "string" && typeof item !== "number") continue;
    if (typeof item === "string" && item.length > 300) throw new FieldPolicyError();
    if (typeof item === "string" && containsPrivateScalar(item)) continue;
    if (typeof item === "number" && !Number.isFinite(item)) throw new FieldPolicyError();
    output[key] = item;
  }
  return output;
}

const PRIVATE_ATTRIBUTE_NAMES = new Set([
  "api_key", "competitor_price", "cost", "cost_price", "credential", "credentials",
  "internal_id", "internal_product_id", "margin", "margin_rate", "platform_listing_id",
  "private_id", "secret", "source", "source_id", "source_url", "supplier", "supplier_id",
  "supplier_name", "supplier_url", "token", "vendor", "vendor_id", "warehouse_code",
  "wholesale_price",
]);

function normalizedAttributeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function publicAttributeName(value) {
  return typeof value === "string"
    && value === normalizedAttributeName(value)
    && PUBLIC_ATTRIBUTE_NAME_SET.has(value);
}

function privateAttributeName(value) {
  const name = normalizedAttributeName(value);
  return PRIVATE_ATTRIBUTE_NAMES.has(name)
    || /^(?:api_key|credential|internal|margin|private|secret|supplier|token|vendor|warehouse)(?:_|$)/.test(name)
    || /^(?:cost|wholesale)(?:_|$)/.test(name)
    || /^source_(?:id|url|record|reference)$/.test(name);
}

function containsPrivateAttribute(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsPrivateAttribute(item, seen));
  return Object.entries(value).some(([key, item]) => privateAttributeName(key) || containsPrivateAttribute(item, seen));
}

function containsPrivateScalar(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /(?:https?|ftp|file|gid):\/\//i.test(text)
    || /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}\b/i.test(text)
    || /\b(?:api[_ -]?key|authorization|client[_ -]?secret|credential|password|private[_ -]?key|refresh[_ -]?token|secret|token)\s*[:=]/i.test(text)
    || /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(text)
    || /\b(?:localhost|[a-z0-9.-]+\.(?:internal|local))(?::\d{1,5})?\b/i.test(text)
    || /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i.test(text);
}

function cleanPrice(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FieldPolicyError();
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new FieldPolicyError();
  if (!/^[A-Z]{3}$/.test(String(value.currency || ""))) throw new FieldPolicyError();
  const output = { amount, currency: value.currency };
  if (value.tier !== undefined) output.tier = optionalString(value.tier, 80);
  return output;
}

export function toPublicProduct(internalProduct, context = {}) {
  if (!internalProduct || typeof internalProduct !== "object" || Array.isArray(internalProduct)) {
    throw new FieldPolicyError();
  }
  const publicId = optionalString(internalProduct.public_id, 22);
  const title = optionalString(internalProduct.title, 300);
  const availability = optionalString(internalProduct.availability_band, 30);
  if (!publicId || !PUBLIC_ID_PATTERN.test(publicId) || !title || !AVAILABILITY_BANDS.has(availability)) {
    throw new FieldPolicyError("MISSING_REQUIRED_PUBLIC_FIELD");
  }
  const output = { public_id: publicId, title, availability_band: availability };
  if (internalProduct.slug !== undefined) {
    const slug = optionalString(internalProduct.slug, 100);
    if (!SLUG_PATTERN.test(slug)) throw new FieldPolicyError();
    output.slug = slug;
  }
  const description = optionalString(internalProduct.description, 5000);
  if (description !== undefined) output.description = description;
  const category = optionalString(internalProduct.category, 200);
  if (category !== undefined) output.category = category;
  const tags = cleanTags(internalProduct.tags);
  if (tags !== undefined) output.tags = tags;
  const images = cleanImages(internalProduct.images);
  if (images !== undefined) output.images = images;
  const attributes = cleanAttributes(internalProduct.attributes);
  if (attributes !== undefined) output.attributes = attributes;
  const price = cleanPrice(internalProduct.price);
  if (price !== undefined) output.price = price;
  if (internalProduct.lead_time_days !== undefined) {
    const days = Number(internalProduct.lead_time_days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new FieldPolicyError();
    output.lead_time_days = days;
  }
  const asOf = context.as_of ?? internalProduct.as_of;
  if (asOf !== undefined) {
    const parsed = optionalString(asOf, 40);
    if (!parsed || !Number.isFinite(Date.parse(parsed))) throw new FieldPolicyError();
    output.as_of = parsed;
  }
  if (internalProduct.purchasable !== undefined) {
    if (typeof internalProduct.purchasable !== "boolean") throw new FieldPolicyError();
    output.purchasable = internalProduct.purchasable;
  }
  return output;
}
