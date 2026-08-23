import fixture from "../../fixtures/published-catalog.sample.json" with { type: "json" };

import { toPublicProduct } from "./field-policy.js";
import { getActiveSnapshot, loadSnapshot } from "./snapshot.js";

const MAX_SEARCH_RESULTS = 200;

loadSnapshot(fixture);

export function setCatalogSource(snapshot) {
  return loadSnapshot(snapshot);
}

function visibleProducts(tenant) {
  if (!tenant) return [];
  const products = getActiveSnapshot().products;
  if (tenant.allowed_product_ids === null) return products;
  return products.filter((product) => tenant.allowed_product_ids.has(product.public_id));
}

function publicProduct(product) {
  return toPublicProduct(product, { as_of: getActiveSnapshot().generated_at });
}

function tokenize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .split(/\s+/).filter(Boolean).slice(0, 12);
}

function score(product, terms) {
  if (!terms.length) return 1;
  const title = String(product.title || "").toLowerCase();
  const category = String(product.category || "").toLowerCase();
  const tags = (product.tags || []).join(" ").toLowerCase();
  const description = String(product.description || "").toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 8;
    if (tags.includes(term)) total += 5;
    if (category.includes(term)) total += 3;
    if (description.includes(term)) total += 1;
  }
  return total;
}

function encodeCursor(offset) {
  return btoa(String(offset)).replace(/=+$/g, "");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const decoded = Number.parseInt(atob(cursor), 10);
    return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function listCatalog({ limit = 20, cursor = "" } = {}, tenant) {
  const offset = decodeCursor(cursor);
  if (offset === null) return { error: "INVALID_CURSOR" };
  const products = visibleProducts(tenant);
  const items = products.slice(offset, offset + limit).map(publicProduct);
  const nextOffset = offset + items.length;
  return { items, next_cursor: nextOffset < products.length ? encodeCursor(nextOffset) : null, total: products.length, truncated: false };
}

export function searchCatalog(query, { limit = 20, cursor = "" } = {}, tenant) {
  const offset = decodeCursor(cursor);
  if (offset === null) return { error: "INVALID_CURSOR" };
  const terms = tokenize(query);
  const ranked = visibleProducts(tenant)
    .map((product) => ({ product, score: score(product, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.product.public_id.localeCompare(right.product.public_id));
  const bounded = ranked.slice(0, MAX_SEARCH_RESULTS);
  const items = bounded.slice(offset, offset + limit).map((entry) => publicProduct(entry.product));
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < bounded.length ? encodeCursor(nextOffset) : null,
    total: Math.min(ranked.length, MAX_SEARCH_RESULTS),
    truncated: ranked.length > MAX_SEARCH_RESULTS,
  };
}

export function getProduct(slug, tenant) {
  const product = visibleProducts(tenant).find((entry) => entry.slug === slug);
  return product ? publicProduct(product) : null;
}

export function getProductByPublicId(publicId, tenant) {
  const product = visibleProducts(tenant).find((entry) => entry.public_id === publicId);
  return product ? publicProduct(product) : null;
}
