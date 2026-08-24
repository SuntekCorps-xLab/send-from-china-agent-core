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

function cleanCriterion(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

function cleanCriterionList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanCriterion).filter(Boolean))].slice(0, 20);
}

function normalizeCriteria(value = {}) {
  const priceMax = value.price_max === undefined || value.price_max === null ? null : Number(value.price_max);
  return {
    category: cleanCriterion(value.category),
    use_case: cleanCriterion(value.use_case),
    ship_to: String(value.ship_to || "").trim().toUpperCase(),
    price_max: Number.isFinite(priceMax) && priceMax >= 0 ? priceMax : null,
    materials: cleanCriterionList(value.materials),
    must_have: cleanCriterionList(value.must_have),
    exclude: cleanCriterionList(value.exclude),
    keywords: cleanCriterionList(value.keywords),
  };
}

function productText(product) {
  return cleanCriterion([
    product.title,
    product.description,
    product.category,
    ...(product.tags || []),
    ...Object.values(product.attributes || {}),
  ].join(" "));
}

function materialText(product) {
  const materialValues = Object.entries(product.attributes || {})
    .filter(([key]) => cleanCriterion(key).includes("material"))
    .map(([, value]) => value);
  return cleanCriterion([...materialValues, ...(product.tags || []), product.title, product.description].join(" "));
}

function containsCriterion(text, criterion) {
  if (!criterion) return true;
  if (text.includes(criterion)) return true;
  const terms = tokenize(criterion);
  return terms.length > 0 && terms.every((term) => text.includes(term));
}

function matchesCriteria(product, criteria) {
  const text = productText(product);
  const category = cleanCriterion(product.category);
  if (criteria.category && !category.includes(criteria.category) && !criteria.category.includes(category)) return false;
  if (criteria.price_max !== null) {
    const amount = Number(product.price?.amount);
    if (!Number.isFinite(amount) || amount > criteria.price_max) return false;
  }
  const materials = materialText(product);
  if (!criteria.materials.every((item) => containsCriterion(materials, item))) return false;
  if (criteria.use_case && !containsCriterion(text, criteria.use_case)) return false;
  if (!criteria.must_have.every((item) => containsCriterion(text, item))) return false;
  if (!criteria["keywords"].every((item) => containsCriterion(text, item))) return false;
  if (criteria.exclude.some((item) => containsCriterion(text, item))) return false;
  return true;
}

function criteriaEvaluation(criteria) {
  const enforced = [];
  for (const name of ["category", "use_case", "price_max", "materials", "must_have", "exclude", "keywords"]) {
    const value = criteria[name];
    if (Array.isArray(value) ? value.length > 0 : value !== "" && value !== null) enforced.push(name);
  }
  return {
    enforced,
    informational: criteria.ship_to ? ["ship_to"] : [],
    all_returned_products_satisfy_enforced: true,
  };
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

export function searchCatalog(query, { limit = 20, cursor = "", criteria = {} } = {}, tenant) {
  const offset = decodeCursor(cursor);
  if (offset === null) return { error: "INVALID_CURSOR" };
  const terms = tokenize(query);
  const normalizedCriteria = normalizeCriteria(criteria);
  const ranked = visibleProducts(tenant)
    .map((product) => ({ product, score: score(product, terms) }))
    .filter((entry) => entry.score > 0 && matchesCriteria(entry.product, normalizedCriteria))
    .sort((left, right) => right.score - left.score || left.product.public_id.localeCompare(right.product.public_id));
  const bounded = ranked.slice(0, MAX_SEARCH_RESULTS);
  const items = bounded.slice(offset, offset + limit).map((entry) => publicProduct(entry.product));
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < bounded.length ? encodeCursor(nextOffset) : null,
    total: Math.min(ranked.length, MAX_SEARCH_RESULTS),
    truncated: ranked.length > MAX_SEARCH_RESULTS,
    criteria: normalizedCriteria,
    criteria_evaluation: criteriaEvaluation(normalizedCriteria),
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
