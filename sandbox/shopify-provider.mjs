import { applyShopifyHardConstraints } from "./shopify-constraints.mjs";
import { PUBLIC_ATTRIBUTE_NAMES, toPublicProduct } from "../governance-worker/src/field-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import {
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  parseSearchContractV2Request,
} from "../sdk/src/search-contract-v2.js";
import { SHOPIFY_SANDBOX_API_VERSION, shopifySandboxStatus } from "./status-contract.mjs";

export const SHOPIFY_STOREFRONT_API_VERSION = SHOPIFY_SANDBOX_API_VERSION;

export const SHOPIFY_HEALTH_QUERY = `query ShopifySandboxHealth {
  shop {
    name
  }
}`;

export const SHOPIFY_CATALOG_QUERY = `query ShopifySandboxCatalog($query: String, $first: Int!, $after: String) {
  products(query: $query, first: $first, after: $after) {
    nodes {
      handle
      title
      description
      onlineStoreUrl
      availableForSale
      productType
      images(first: 8) { nodes { url altText } }
      options(first: 20) { name values }
      priceRange {
        minVariantPrice {
          amount
          currencyCode
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

export const SHOPIFY_PRODUCT_QUERY = `query ShopifySandboxProduct($handle: String!) {
  product(handle: $handle) {
    handle
    title
    description
    onlineStoreUrl
    availableForSale
    productType
    images(first: 8) { nodes { url altText } }
    options(first: 20) { name values }
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
  }
}`;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_QUOTA_LIMIT = 60;
const DEFAULT_QUOTA_WINDOW_MS = 60_000;
const DEFAULT_CONCURRENCY_LIMIT = 4;
const DEFAULT_READINESS_TTL_MS = 15_000;
const MAX_LIVE_RESULTS = 20;

const PROVIDER_OPTION_FIELDS = new Set([
  "storeDomain",
  "accessToken",
  "fetchImpl",
  "now",
  "timeoutMs",
  "maxResponseBytes",
  "quotaLimit",
  "quotaWindowMs",
  "concurrencyLimit",
  "readinessTtlMs",
]);

const PRODUCT_NODE_FIELDS = new Set([
  "handle",
  "title",
  "description",
  "onlineStoreUrl",
  "availableForSale",
  "priceRange",
  "productType",
  "images",
  "options",
]);

const PUBLIC_CODE_BY_STATE = Object.freeze({
  credential_missing: "CREDENTIAL_MISSING",
  authentication_failed: "AUTHENTICATION_FAILED",
  permission_required: "PERMISSION_REQUIRED",
  quota_exceeded: "QUOTA_EXCEEDED",
  service_unavailable: "SERVICE_UNAVAILABLE",
});

const PUBLIC_STATUS_BY_STATE = Object.freeze({
  credential_missing: 503,
  authentication_failed: 502,
  permission_required: 502,
  quota_exceeded: 429,
  service_unavailable: 503,
});

export class ShopifySandboxError extends Error {
  constructor(state) {
    const code = PUBLIC_CODE_BY_STATE[state] || PUBLIC_CODE_BY_STATE.service_unavailable;
    super(code);
    this.name = "ShopifySandboxError";
    this.state = PUBLIC_CODE_BY_STATE[state] ? state : "service_unavailable";
    this.publicCode = code;
    this.httpStatus = PUBLIC_STATUS_BY_STATE[this.state];
  }
}

function failure(state) {
  return new ShopifySandboxError(state);
}

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function exactOptionalFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((field) => fields.has(field));
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new TypeError("Invalid Shopify sandbox limit");
  }
  return number;
}

function nonNegativeInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > maximum) {
    throw new TypeError("Invalid Shopify sandbox duration");
  }
  return number;
}

function clockValue(now) {
  const value = now();
  const number = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Invalid Shopify sandbox clock");
  return number;
}

function checkedAt(now) {
  return new Date(clockValue(now)).toISOString();
}

function normalizeStoreDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u.test(domain)) {
    return null;
  }
  const shop = domain.slice(0, -".myshopify.com".length);
  if (["localhost", "local", "internal", "loopback"].includes(shop) || /^\d+$/u.test(shop)) return null;
  return domain;
}

function validAccessToken(value) {
  const token = String(value || "");
  return token.length >= 8 && token.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(token);
}

function privateUrlHostname(hostname) {
  const host = String(hostname || "").replace(/\.$/u, "").toLowerCase();
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!host || isIP(unwrapped) !== 0) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".lan")) return true;
  return /^\d+(?:\.\d+){0,3}$/u.test(host);
}

function publicProductUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || privateUrlHostname(url.hostname) || url.hash) return null;
    return value;
  } catch {
    return null;
  }
}

function createQuotaGate(options) {
  const now = options.now;
  const limit = options.limit;
  const windowMs = options.windowMs;
  const concurrencyLimit = options.concurrencyLimit;
  let windowStartedAt = clockValue(now);
  let used = 0;
  let active = 0;

  function refresh() {
    const current = clockValue(now);
    if (current >= windowStartedAt + windowMs) {
      windowStartedAt = current;
      used = 0;
    }
    return current;
  }

  function snapshot() {
    refresh();
    return Object.freeze({
      limit,
      remaining: Math.max(0, limit - used),
      window_seconds: Math.ceil(windowMs / 1000),
      concurrency_limit: concurrencyLimit,
      reset_at: new Date(windowStartedAt + windowMs).toISOString(),
    });
  }

  async function run(operation) {
    refresh();
    if (used >= limit || active >= concurrencyLimit) throw failure("quota_exceeded");
    used += 1;
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  }

  return Object.freeze({ run, snapshot });
}

function graphqlErrorState(errors) {
  if (!Array.isArray(errors) || errors.length < 1 || errors.length > 20) return "service_unavailable";
  const codes = [];
  for (const entry of errors) {
    if (!exactOptionalFields(entry, new Set(["message", "locations", "path", "extensions"]))
      || typeof entry.message !== "string") return "service_unavailable";
    if (entry.locations !== undefined && (!Array.isArray(entry.locations)
      || entry.locations.some((location) => !exactFields(location, new Set(["line", "column"]))
        || !Number.isInteger(location.line) || !Number.isInteger(location.column)))) return "service_unavailable";
    if (entry.path !== undefined && !Array.isArray(entry.path)) return "service_unavailable";
    if (entry.extensions !== undefined) {
      if (!exactFields(entry.extensions, new Set(["code"])) || typeof entry.extensions.code !== "string") {
        return "service_unavailable";
      }
      codes.push(entry.extensions.code.toUpperCase());
    }
  }
  if (codes.some((code) => ["UNAUTHENTICATED", "INVALID_TOKEN"].includes(code))) return "authentication_failed";
  if (codes.some((code) => ["ACCESS_DENIED", "FORBIDDEN"].includes(code))) return "permission_required";
  if (codes.some((code) => ["THROTTLED", "MAX_COST_EXCEEDED"].includes(code))) return "quota_exceeded";
  return "service_unavailable";
}

function parseGraphqlEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("service_unavailable");
  if (Object.hasOwn(value, "errors")) {
    if (!exactOptionalFields(value, new Set(["data", "errors"]))) throw failure("service_unavailable");
    throw failure(graphqlErrorState(value.errors));
  }
  if (!exactFields(value, new Set(["data"])) || !value.data || typeof value.data !== "object"
    || Array.isArray(value.data)) throw failure("service_unavailable");
  return value.data;
}

function responseState(status) {
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_required";
  if (status === 429) return "quota_exceeded";
  return "service_unavailable";
}

function credentialMarkers(credential) {
  const encoded = Buffer.from(credential, "utf8").toString("base64");
  return Object.freeze([...new Set([
    credential,
    encodeURIComponent(credential),
    encoded,
    encoded.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  ].filter((value) => value.length >= 8))]);
}

function reflectedCredential(value, markers, credential) {
  if (typeof value !== "string") return false;
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    if (markers.some((marker) => decoded.includes(marker)) || decoded.includes(credential)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return markers.some((marker) => decoded.includes(marker)) || decoded.includes(credential);
}

function containsCredential(value, markers, credential) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (reflectedCredential(current, markers, credential)) return true;
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, entry] of Object.entries(current)) {
      if (reflectedCredential(key, markers, credential)) return true;
      pending.push(entry);
    }
  }
  return false;
}

async function readBoundedBody(response, maximum) {
  const declared = Number.parseInt(response.headers?.get?.("content-length") || "0", 10);
  if (Number.isFinite(declared) && declared > maximum) throw failure("service_unavailable");
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/iu.test(contentType)) {
    throw failure("service_unavailable");
  }
  const chunks = [];
  let total = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* no raw response is retained */ }
        throw failure("service_unavailable");
      }
      chunks.push(chunk);
    }
  } else if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximum) throw failure("service_unavailable");
    chunks.push(buffer);
  } else {
    throw failure("service_unavailable");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure("service_unavailable");
  }
}

function parseMoney(value) {
  if (!exactFields(value, new Set(["amount", "currencyCode"]))
    || typeof value.amount !== "string"
    || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(value.amount)
    || typeof value.currencyCode !== "string"
    || !/^[A-Z]{3}$/u.test(value.currencyCode)) throw failure("service_unavailable");
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount < 0) throw failure("service_unavailable");
  return Object.freeze({ amount, currency: value.currencyCode });
}

const PUBLIC_OPTION_NAMES = new Set(PUBLIC_ATTRIBUTE_NAMES);

function parseImages(value) {
  if (!exactFields(value, new Set(["nodes"])) || !Array.isArray(value.nodes)
    || value.nodes.length > 8) throw failure("service_unavailable");
  return Object.freeze(value.nodes.map((image) => {
    if (!exactFields(image, new Set(["url", "altText"]))
      || !(image.altText === null || (typeof image.altText === "string" && image.altText.length <= 300))) {
      throw failure("service_unavailable");
    }
    const url = publicProductUrl(image.url);
    if (!url || new URL(url).hostname !== "cdn.shopify.com") throw failure("service_unavailable");
    return Object.freeze({ url, alt: image.altText || "" });
  }));
}

function parsePublicOptions(value) {
  if (!Array.isArray(value) || value.length > 20) throw failure("service_unavailable");
  const attributes = {};
  for (const option of value) {
    if (!exactFields(option, new Set(["name", "values"]))
      || typeof option.name !== "string" || !option.name.trim() || option.name.length > 80
      || !Array.isArray(option.values) || option.values.length > 50
      || option.values.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
      throw failure("service_unavailable");
    }
    const name = option.name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
    if (!PUBLIC_OPTION_NAMES.has(name)) continue;
    const values = [...new Set(option.values.map((item) => item.trim()))];
    const joined = values.join(", ");
    if (!joined || joined.length > 300) throw failure("service_unavailable");
    if (Object.hasOwn(attributes, name)) throw failure("service_unavailable");
    attributes[name] = joined;
  }
  return Object.freeze(attributes);
}

function parseProductNode(value) {
  if (!exactFields(value, PRODUCT_NODE_FIELDS)
    || typeof value.handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(value.handle)
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 300
    || typeof value.description !== "string" || value.description.length > 5000
    || typeof value.availableForSale !== "boolean"
    || typeof value.productType !== "string" || value.productType.length > 200
    || !exactFields(value.priceRange, new Set(["minVariantPrice"]))) throw failure("service_unavailable");
  const productUrl = value.onlineStoreUrl === null ? null : publicProductUrl(value.onlineStoreUrl);
  if (value.onlineStoreUrl !== null && productUrl === null) throw failure("service_unavailable");
  return Object.freeze({
    handle: value.handle,
    title: value.title,
    description: value.description,
    productUrl,
    availableForSale: value.availableForSale,
    price: parseMoney(value.priceRange.minVariantPrice),
    category: value.productType.trim(),
    images: parseImages(value.images),
    attributes: parsePublicOptions(value.options),
    hasVariantChoices: value.options.some((option) => option.values.length > 1),
  });
}

function parseCatalogData(data) {
  if (!exactFields(data, new Set(["products"]))
    || !exactFields(data.products, new Set(["nodes", "pageInfo"]))
    || !Array.isArray(data.products.nodes) || data.products.nodes.length > MAX_LIVE_RESULTS
    || !exactFields(data.products.pageInfo, new Set(["hasNextPage", "endCursor"]))
    || typeof data.products.pageInfo.hasNextPage !== "boolean"
    || !(data.products.pageInfo.endCursor === null || typeof data.products.pageInfo.endCursor === "string")
    || (typeof data.products.pageInfo.endCursor === "string" && data.products.pageInfo.endCursor.length > 1000)
    || (data.products.pageInfo.hasNextPage && !data.products.pageInfo.endCursor)) {
    throw failure("service_unavailable");
  }
  return Object.freeze({
    products: Object.freeze(data.products.nodes.map(parseProductNode)),
    hasNextPage: data.products.pageInfo.hasNextPage,
    endCursor: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
  });
}

function parseProductData(data) {
  if (!exactFields(data, new Set(["product"]))) throw failure("service_unavailable");
  return data.product === null ? null : parseProductNode(data.product);
}

function parseHealthData(data) {
  if (!exactFields(data, new Set(["shop"])) || !exactFields(data.shop, new Set(["name"]))
    || typeof data.shop.name !== "string" || !data.shop.name.trim() || data.shop.name.length > 300) {
    throw failure("service_unavailable");
  }
}

function createPublicId(storeDomain, handle) {
  return createHash("sha256").update(`${storeDomain}\u0000${handle}`, "utf8").digest("hex").slice(0, 22);
}

function projectProduct(node, storeDomain, verifiedAt, forbiddenToken) {
  if ([node.title, node.description, node.productUrl]
    .some((value) => typeof value === "string" && value.includes(forbiddenToken))) throw failure("service_unavailable");
  let publicProduct;
  try {
    const base = {
      public_id: createPublicId(storeDomain, node.handle),
      slug: node.handle,
      title: node.title,
      description: node.description,
      images: node.images,
      attributes: node.attributes,
      ...(node.category ? { category: node.category } : {}),
      price: node.price,
      availability_band: node.availableForSale ? "in_stock" : "out_of_stock",
      as_of: verifiedAt,
      purchasable: false,
    };
    publicProduct = toPublicProduct(base);
    if (node.productUrl) toPublicProduct({ ...base, images: [{ url: node.productUrl }] });
  } catch {
    throw failure("service_unavailable");
  }
  return Object.freeze({
    ...publicProduct,
    handle: node.handle,
    ...(node.productUrl ? { product_url: node.productUrl } : {}),
    availableForSale: node.availableForSale,
    shopify_verified_at: verifiedAt,
    non_transactional: true,
    transaction_boundary: "catalog_read_only_non_transactional",
    writes: false,
    mode: "shopify_read_only",
    data_source: "shopify_storefront_graphql",
    illustrative_only: false,
    available: false,
  });
}

function constraintOutcome(core, degraded) {
  if (!degraded) return core;
  return Object.freeze({
    ...core,
    status: "degraded",
    search_scope: Object.freeze({
      ...core.search_scope,
      plan_complete: false,
      scope_exhausted: false,
      degraded: true,
      degraded_reason: "The read-only Shopify catalog cannot verify every hard constraint.",
    }),
  });
}

function liveEnvelope(value, verifiedAt) {
  return Object.freeze({
    ...value,
    mode: "shopify_read_only",
    data_source: "shopify_storefront_graphql",
    illustrative_only: false,
    purchasable: false,
    available: false,
    writes: false,
    non_transactional: true,
    transaction_boundary: "catalog_read_only_non_transactional",
    shopify_verified_at: verifiedAt,
  });
}

function statusError(status) {
  return failure(status.credential_state);
}

export function shopifyConfigFromEnvironment(environment = {}) {
  return Object.freeze({
    storeDomain: String(environment.SHOPIFY_STORE_DOMAIN || ""),
    accessToken: String(environment.SHOPIFY_STOREFRONT_ACCESS_TOKEN || ""),
  });
}

export function createShopifyReadOnlyProvider(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((field) => !PROVIDER_OPTION_FIELDS.has(field))) {
    throw new TypeError("Unsupported Shopify sandbox provider option");
  }
  const storeDomain = normalizeStoreDomain(options.storeDomain);
  const accessToken = String(options.accessToken || "");
  const configured = Boolean(storeDomain && validAccessToken(accessToken));
  const forbiddenCredentialMarkers = configured ? credentialMarkers(accessToken) : Object.freeze([]);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000);
  const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  const quotaLimit = positiveInteger(options.quotaLimit, DEFAULT_QUOTA_LIMIT, 100_000);
  const quotaWindowMs = positiveInteger(options.quotaWindowMs, DEFAULT_QUOTA_WINDOW_MS, 24 * 60 * 60 * 1000);
  const concurrencyLimit = positiveInteger(options.concurrencyLimit, DEFAULT_CONCURRENCY_LIMIT, 100);
  const readinessTtlMs = nonNegativeInteger(options.readinessTtlMs, DEFAULT_READINESS_TTL_MS, 5 * 60_000);
  const fetchImpl = typeof options.fetchImpl === "function"
    ? options.fetchImpl
    : (configured ? globalThis.fetch : null);
  const endpoint = configured
    ? `https://${storeDomain}/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`
    : null;
  const quota = createQuotaGate({ now, limit: quotaLimit, windowMs: quotaWindowMs, concurrencyLimit });
  let lastStatus = null;
  let lastCheckedMs = Number.NEGATIVE_INFINITY;
  let readinessPromise = null;

  async function graphql(query, operationName, variables) {
    if (!configured) throw failure("credential_missing");
    if (typeof fetchImpl !== "function") throw failure("service_unavailable");
    const controller = new AbortController();
    const operation = quota.run(async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-shopify-storefront-access-token": accessToken,
          },
          body: JSON.stringify({ query, operationName, variables }),
          signal: controller.signal,
        });
        if (!response || !Number.isInteger(response.status)) throw failure("service_unavailable");
        if (response.redirected === true
          || (typeof response.url === "string" && response.url && response.url !== endpoint)) {
          throw failure("service_unavailable");
        }
        if (response.status < 200 || response.status >= 300) throw failure(responseState(response.status));
        const data = parseGraphqlEnvelope(await readBoundedBody(response, maxResponseBytes));
        if (containsCredential(data, forbiddenCredentialMarkers, accessToken)) {
          throw failure("service_unavailable");
        }
        return data;
      } catch (error) {
        if (error instanceof ShopifySandboxError) throw error;
        throw failure("service_unavailable");
      }
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(failure("service_unavailable"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof ShopifySandboxError) throw error;
      throw failure("service_unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  function buildStatus(verified, state, errorCode, at) {
    return shopifySandboxStatus({
      verified,
      credential_state: state,
      api_version: SHOPIFY_STOREFRONT_API_VERSION,
      quota: quota.snapshot(),
      checked_at: at,
      error_code: errorCode,
    });
  }

  async function verifyReadiness({ force = false } = {}) {
    const current = clockValue(now);
    if (!configured) {
      lastCheckedMs = current;
      lastStatus = buildStatus(false, "credential_missing", "CREDENTIAL_MISSING", checkedAt(now));
      return lastStatus;
    }
    if (!force && lastStatus && current - lastCheckedMs <= readinessTtlMs) {
      lastStatus = buildStatus(
        lastStatus.verified,
        lastStatus.credential_state,
        lastStatus.error_code,
        lastStatus.checked_at,
      );
      return lastStatus;
    }
    if (readinessPromise) return readinessPromise;
    readinessPromise = (async () => {
      try {
        parseHealthData(await graphql(SHOPIFY_HEALTH_QUERY, "ShopifySandboxHealth", {}));
        parseCatalogData(await graphql(SHOPIFY_CATALOG_QUERY, "ShopifySandboxCatalog", {
          query: null,
          first: 1,
          after: null,
        }));
        lastStatus = buildStatus(true, "succeeded", null, checkedAt(now));
      } catch (error) {
        const safe = error instanceof ShopifySandboxError ? error : failure("service_unavailable");
        lastStatus = buildStatus(false, safe.state, safe.publicCode, checkedAt(now));
      } finally {
        lastCheckedMs = clockValue(now);
        readinessPromise = null;
      }
      return lastStatus;
    })();
    return readinessPromise;
  }

  async function search(requestValue) {
    const request = parseSearchContractV2Request(requestValue);
    const adapted = adaptSearchContractV2RequestToV1(request);
    const readiness = await verifyReadiness();
    if (!readiness.verified) throw statusError(readiness);
    const effectiveLimit = Math.min(request.limit, MAX_LIVE_RESULTS);
    const effectiveRequest = effectiveLimit === request.limit ? request : { ...request, limit: effectiveLimit };
    const hardNames = new Set(request.hard_constraints.map((condition) => condition.name));
    const relaxations = adapted.relaxations.filter((entry) => !hardNames.has(entry.condition));
    for (const condition of request.transaction_context.filter((entry) => entry.name === "ship_to")) {
      relaxations.push({
        condition: condition.name,
        from: condition.value,
        reason: "The read-only Shopify catalog does not evaluate shipping destinations.",
      });
    }
    if (effectiveLimit !== request.limit) {
      relaxations.push({
        condition: "limit",
        from: request.limit,
        to: effectiveLimit,
        reason: "The Shopify read-only sandbox reduced the page limit.",
      });
    }
    let catalog;
    try {
      catalog = parseCatalogData(await graphql(SHOPIFY_CATALOG_QUERY, "ShopifySandboxCatalog", {
        query: adapted.arguments.query,
        first: effectiveLimit,
        after: adapted.arguments.cursor || null,
      }));
    } catch (error) {
      const safe = error instanceof ShopifySandboxError ? error : failure("service_unavailable");
      lastStatus = buildStatus(false, safe.state, safe.publicCode, checkedAt(now));
      lastCheckedMs = clockValue(now);
      throw safe;
    }
    const verifiedAt = checkedAt(now);
    const candidates = catalog.products
      .filter((product) => product.productUrl !== null)
      .map((product) => projectProduct(product, storeDomain, verifiedAt, accessToken));
    const variantChoiceHandles = new Set(catalog.products
      .filter((product) => product.hasVariantChoices).map((product) => product.handle));
    const evaluated = applyShopifyHardConstraints(candidates, request, {
      hasVariantChoices: (product) => variantChoiceHandles.has(product.handle),
    });
    const products = evaluated.products;
    relaxations.push(...evaluated.relaxations);
    const terminal = !catalog.hasNextPage && !evaluated.degraded;
    const legacy = {
      status: products.length ? "catalog_match" : (terminal ? "no_match" : "searching"),
      products,
      next_cursor: catalog.endCursor,
      exhaustive: terminal,
      search_scope_exhausted: terminal,
      global_catalog_exhaustive: false,
      scan_limit_reached: false,
      truncated: false,
    };
    const core = adaptSearchContractV1ResponseToV2(legacy, {
      request: effectiveRequest,
      relaxations,
      traceId: `shopify-sandbox-${randomUUID()}`,
    });
    return liveEnvelope(constraintOutcome(core, evaluated.degraded), verifiedAt);
  }

  async function getProduct(handle) {
    if (typeof handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(handle)) {
      throw new TypeError("Invalid Shopify product handle");
    }
    const readiness = await verifyReadiness();
    if (!readiness.verified) throw statusError(readiness);
    let product;
    try {
      product = parseProductData(await graphql(SHOPIFY_PRODUCT_QUERY, "ShopifySandboxProduct", { handle }));
      if (product && product.handle !== handle) throw failure("service_unavailable");
    } catch (error) {
      const safe = error instanceof ShopifySandboxError ? error : failure("service_unavailable");
      lastStatus = buildStatus(false, safe.state, safe.publicCode, checkedAt(now));
      lastCheckedMs = clockValue(now);
      throw safe;
    }
    const verifiedAt = checkedAt(now);
    if (!product || product.productUrl === null) return null;
    return liveEnvelope({ product: projectProduct(product, storeDomain, verifiedAt, accessToken) }, verifiedAt);
  }

  return Object.freeze({
    mode: "shopify_read_only",
    apiVersion: SHOPIFY_STOREFRONT_API_VERSION,
    getStatus: verifyReadiness,
    search,
    getProduct,
  });
}
