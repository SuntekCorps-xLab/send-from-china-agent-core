export const PUBLIC_PRODUCT_FIELDS = Object.freeze([
  "public_id", "slug", "title", "description", "category", "tags", "images",
  "attributes", "price", "availability_band", "lead_time_days", "as_of", "source", "purchasable",
]);

const AVAILABILITY_BANDS = new Set(["in_stock", "low", "out_of_stock"]);
const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

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
    if (typeof item !== "string" && typeof item !== "number") continue;
    if (typeof item === "string" && item.length > 300) throw new FieldPolicyError();
    if (typeof item === "number" && !Number.isFinite(item)) throw new FieldPolicyError();
    output[key] = item;
  }
  return output;
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
  for (const field of ["description", "category", "source"]) {
    const value = optionalString(internalProduct[field]);
    if (value !== undefined) output[field] = value;
  }
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
