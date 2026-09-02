import { applyShopifyHardConstraints } from "../../sandbox/shopify-constraints.mjs";
import { PUBLIC_ATTRIBUTE_NAMES, toPublicProduct } from "../../governance-worker/src/field-policy.js";
import {
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  parseSearchContractV2Request,
} from "../../sdk/src/search-contract-v2.js";
import { SHOPIFY_SANDBOX_API_VERSION, shopifySandboxStatus } from "../../sandbox/status-contract.mjs";

export const SHOPIFY_HEALTH_QUERY = `query ShopifySandboxHealth {
  shop { name }
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
      priceRange { minVariantPrice { amount currencyCode } }
    }
    pageInfo { hasNextPage endCursor }
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
    priceRange { minVariantPrice { amount currencyCode } }
  }
}`;

const MAX_RESULTS = 20;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const READINESS_TTL_MS = 15_000;
const PRODUCT_FIELDS = new Set([
  "handle", "title", "description", "onlineStoreUrl", "availableForSale", "priceRange",
  "productType", "images", "options",
]);
const ERROR_CODE = Object.freeze({
  credential_missing: "CREDENTIAL_MISSING",
  authentication_failed: "AUTHENTICATION_FAILED",
  permission_required: "PERMISSION_REQUIRED",
  quota_exceeded: "QUOTA_EXCEEDED",
  service_unavailable: "SERVICE_UNAVAILABLE",
});
const HTTP_STATUS = Object.freeze({
  credential_missing: 503,
  authentication_failed: 502,
  permission_required: 502,
  quota_exceeded: 429,
  service_unavailable: 503,
});

export class HostedShopifyError extends Error {
  constructor(state) {
    const safeState = Object.hasOwn(ERROR_CODE, state) ? state : "service_unavailable";
    super(ERROR_CODE[safeState]);
    this.name = "HostedShopifyError";
    this.state = safeState;
    this.publicCode = ERROR_CODE[safeState];
    this.httpStatus = HTTP_STATUS[safeState];
  }
}

const fail = (state) => new HostedShopifyError(state);

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u.test(domain)) return null;
  const shop = domain.slice(0, -".myshopify.com".length);
  return ["localhost", "local", "internal", "loopback"].includes(shop) || /^\d+$/u.test(shop) ? null : domain;
}

function validToken(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 512
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function publicUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.includes(":") || /^\d+(?:\.\d+){0,3}$/u.test(host)) return null;
    return value;
  } catch {
    return null;
  }
}

function responseState(status) {
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_required";
  if (status === 429) return "quota_exceeded";
  return "service_unavailable";
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function credentialMarkers(credential) {
  const encoded = base64(credential);
  return [...new Set([
    credential,
    encodeURIComponent(credential),
    encoded,
    encoded.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  ].filter((value) => value.length >= 8))];
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
    } catch { break; }
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

function graphqlErrorState(errors) {
  if (!Array.isArray(errors) || errors.length < 1 || errors.length > 20) return "service_unavailable";
  const codes = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["message", "locations", "path", "extensions"].includes(key))
      || typeof entry.message !== "string") return "service_unavailable";
    if (entry.extensions !== undefined) {
      if (!exact(entry.extensions, new Set(["code"])) || typeof entry.extensions.code !== "string") {
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

function envelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("service_unavailable");
  if (Object.hasOwn(value, "errors")) {
    if (Object.keys(value).some((key) => !["data", "errors"].includes(key))) throw fail("service_unavailable");
    throw fail(graphqlErrorState(value.errors));
  }
  if (!exact(value, new Set(["data"])) || !value.data || typeof value.data !== "object"
    || Array.isArray(value.data)) throw fail("service_unavailable");
  return value.data;
}

function cancelReader(reader) {
  try {
    Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // A broken upstream stream must not delay or replace the public failure.
  }
}

function createDeadline(timeoutMs, controller) {
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(fail("service_unavailable"));
    }, timeoutMs);
  });
  return Object.freeze({
    async race(promise) {
      if (expired) throw fail("service_unavailable");
      const value = await Promise.race([Promise.resolve(promise), timeout]);
      if (expired) throw fail("service_unavailable");
      return value;
    },
    close() {
      clearTimeout(timer);
    },
  });
}

async function readBoundedJson(response, deadline) {
  const declared = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw fail("service_unavailable");
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/iu.test(contentType)) {
    throw fail("service_unavailable");
  }
  if (!response.body?.getReader) throw fail("service_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let streamComplete = false;
  try {
    while (true) {
      const { done, value } = await deadline.race(reader.read());
      if (done) {
        streamComplete = true;
        break;
      }
      if (!(value instanceof Uint8Array)) throw fail("service_unavailable");
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw fail("service_unavailable");
      chunks.push(value);
    }
  } finally {
    if (!streamComplete) cancelReader(reader);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw fail("service_unavailable");
  }
}

function parseMoney(value) {
  if (!exact(value, new Set(["amount", "currencyCode"]))
    || typeof value.amount !== "string"
    || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(value.amount)
    || typeof value.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(value.currencyCode)) {
    throw fail("service_unavailable");
  }
  return Object.freeze({ amount: Number(value.amount), currency: value.currencyCode });
}

const PUBLIC_OPTION_NAMES = new Set(PUBLIC_ATTRIBUTE_NAMES);

function parseImages(value) {
  if (!exact(value, new Set(["nodes"])) || !Array.isArray(value.nodes)
    || value.nodes.length > 8) throw fail("service_unavailable");
  return Object.freeze(value.nodes.map((image) => {
    if (!exact(image, new Set(["url", "altText"]))
      || !(image.altText === null || (typeof image.altText === "string" && image.altText.length <= 300))) {
      throw fail("service_unavailable");
    }
    const url = publicUrl(image.url);
    if (!url || new URL(url).hostname !== "cdn.shopify.com") throw fail("service_unavailable");
    return Object.freeze({ url, alt: image.altText || "" });
  }));
}

function parsePublicOptions(value) {
  if (!Array.isArray(value) || value.length > 20) throw fail("service_unavailable");
  const attributes = {};
  for (const option of value) {
    if (!exact(option, new Set(["name", "values"]))
      || typeof option.name !== "string" || !option.name.trim() || option.name.length > 80
      || !Array.isArray(option.values) || option.values.length > 50
      || option.values.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
      throw fail("service_unavailable");
    }
    const name = option.name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
    if (!PUBLIC_OPTION_NAMES.has(name)) continue;
    const values = [...new Set(option.values.map((item) => item.trim()))];
    const joined = values.join(", ");
    if (!joined || joined.length > 300) throw fail("service_unavailable");
    if (Object.hasOwn(attributes, name)) throw fail("service_unavailable");
    attributes[name] = joined;
  }
  return Object.freeze(attributes);
}

function parseProduct(value) {
  if (!exact(value, PRODUCT_FIELDS)
    || typeof value.handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(value.handle)
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 300
    || typeof value.description !== "string" || value.description.length > 5000
    || typeof value.availableForSale !== "boolean"
    || typeof value.productType !== "string" || value.productType.length > 200
    || !exact(value.priceRange, new Set(["minVariantPrice"]))) throw fail("service_unavailable");
  const productUrl = value.onlineStoreUrl === null ? null : publicUrl(value.onlineStoreUrl);
  if (value.onlineStoreUrl !== null && productUrl === null) throw fail("service_unavailable");
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

function parseCatalog(data) {
  if (!exact(data, new Set(["products"])) || !exact(data.products, new Set(["nodes", "pageInfo"]))
    || !Array.isArray(data.products.nodes) || data.products.nodes.length > MAX_RESULTS
    || !exact(data.products.pageInfo, new Set(["hasNextPage", "endCursor"]))
    || typeof data.products.pageInfo.hasNextPage !== "boolean"
    || !(data.products.pageInfo.endCursor === null || (typeof data.products.pageInfo.endCursor === "string"
      && data.products.pageInfo.endCursor.length <= 1000))
    || (data.products.pageInfo.hasNextPage && !data.products.pageInfo.endCursor)) throw fail("service_unavailable");
  return {
    products: data.products.nodes.map(parseProduct),
    hasNextPage: data.products.pageInfo.hasNextPage,
    endCursor: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
  };
}

function parseHealth(data) {
  if (!exact(data, new Set(["shop"])) || !exact(data.shop, new Set(["name"]))
    || typeof data.shop.name !== "string" || !data.shop.name.trim() || data.shop.name.length > 300) {
    throw fail("service_unavailable");
  }
}

function parseProductData(data) {
  if (!exact(data, new Set(["product"]))) throw fail("service_unavailable");
  return data.product === null ? null : parseProduct(data.product);
}

async function digestId(domain, handle) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${domain}\u0000${handle}`));
  return [...new Uint8Array(digest).slice(0, 11)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function projectProduct(product, domain, verifiedAt, forbiddenToken) {
  if ([product.title, product.description, product.productUrl]
    .some((value) => typeof value === "string" && value.includes(forbiddenToken))) throw fail("service_unavailable");
  let publicProduct;
  try {
    const base = {
      public_id: await digestId(domain, product.handle),
      slug: product.handle,
      title: product.title,
      description: product.description,
      images: product.images,
      attributes: product.attributes,
      ...(product.category ? { category: product.category } : {}),
      price: product.price,
      availability_band: product.availableForSale ? "in_stock" : "out_of_stock",
      as_of: verifiedAt,
      purchasable: false,
    };
    publicProduct = toPublicProduct(base);
    if (product.productUrl) toPublicProduct({ ...base, images: [{ url: product.productUrl }] });
  } catch {
    throw fail("service_unavailable");
  }
  return Object.freeze({
    ...publicProduct,
    handle: product.handle,
    ...(product.productUrl ? { product_url: product.productUrl } : {}),
    availableForSale: product.availableForSale,
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

export function createHostedShopifyProvider(env, options = {}) {
  const domain = normalizeDomain(env.SHOPIFY_STORE_DOMAIN);
  const token = String(env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "");
  const configured = Boolean(domain && validToken(token));
  const forbiddenCredentialMarkers = configured ? credentialMarkers(token) : [];
  const endpoint = configured
    ? `https://${domain}/api/${SHOPIFY_SANDBOX_API_VERSION}/graphql.json`
    : null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs)
    && options.requestTimeoutMs > 0
    ? Math.min(options.requestTimeoutMs, TIMEOUT_MS)
    : TIMEOUT_MS;
  const quota = options.quota || Object.freeze({
    limit: 0, remaining: 0, window_seconds: 0, concurrency_limit: 0, reset_at: null,
  });
  let lastStatus = null;
  let lastChecked = Number.NEGATIVE_INFINITY;
  let readinessPromise = null;

  function timestamp() { return new Date(Number(now())).toISOString(); }
  function status(verified, state, errorCode, at) {
    return shopifySandboxStatus({
      verified,
      credential_state: state,
      api_version: SHOPIFY_SANDBOX_API_VERSION,
      quota,
      checked_at: at,
      error_code: errorCode,
    });
  }

  async function graphql(query, operationName, variables) {
    if (!configured) throw fail("credential_missing");
    if (typeof fetchImpl !== "function") throw fail("service_unavailable");
    const controller = new AbortController();
    const deadline = createDeadline(requestTimeoutMs, controller);
    try {
      const response = await deadline.race(fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-shopify-storefront-access-token": token,
        },
        body: JSON.stringify({ query, operationName, variables }),
        signal: controller.signal,
      }));
      if (!response || !Number.isInteger(response.status) || response.redirected === true
        || (response.url && response.url !== endpoint)) throw fail("service_unavailable");
      if (!response.ok) throw fail(responseState(response.status));
      const data = envelope(await readBoundedJson(response, deadline));
      if (containsCredential(data, forbiddenCredentialMarkers, token)) throw fail("service_unavailable");
      return data;
    } catch (error) {
      if (error instanceof HostedShopifyError) throw error;
      throw fail("service_unavailable");
    } finally {
      deadline.close();
      controller.abort();
    }
  }

  async function getStatus({ force = false } = {}) {
    const current = Number(now());
    if (!configured) {
      lastChecked = current;
      lastStatus = status(false, "credential_missing", "CREDENTIAL_MISSING", timestamp());
      return lastStatus;
    }
    if (!force && lastStatus && current - lastChecked <= READINESS_TTL_MS) return lastStatus;
    if (readinessPromise) return readinessPromise;
    readinessPromise = (async () => {
      try {
        parseHealth(await graphql(SHOPIFY_HEALTH_QUERY, "ShopifySandboxHealth", {}));
        parseCatalog(await graphql(SHOPIFY_CATALOG_QUERY, "ShopifySandboxCatalog", {
          query: null, first: 1, after: null,
        }));
        lastStatus = status(true, "succeeded", null, timestamp());
      } catch (error) {
        const safe = error instanceof HostedShopifyError ? error : fail("service_unavailable");
        lastStatus = status(false, safe.state, safe.publicCode, timestamp());
      } finally {
        lastChecked = Number(now());
        readinessPromise = null;
      }
      return lastStatus;
    })();
    return readinessPromise;
  }

  async function search(requestValue) {
    const request = parseSearchContractV2Request(requestValue);
    const adapted = adaptSearchContractV2RequestToV1(request);
    const readiness = await getStatus();
    if (!readiness.verified) throw fail(readiness.credential_state);
    const limit = Math.min(request.limit, MAX_RESULTS);
    const effectiveRequest = limit === request.limit ? request : { ...request, limit };
    const hardNames = new Set(request.hard_constraints.map((condition) => condition.name));
    const relaxations = adapted.relaxations.filter((entry) => !hardNames.has(entry.condition));
    for (const condition of request.transaction_context.filter((entry) => entry.name === "ship_to")) {
      relaxations.push({
        condition: condition.name,
        from: condition.value,
        reason: "The read-only Shopify catalog does not evaluate shipping destinations.",
      });
    }
    if (limit !== request.limit) {
      relaxations.push({ condition: "limit", from: request.limit, to: limit, reason: "The hosted sandbox reduced the page limit." });
    }
    const catalog = parseCatalog(await graphql(SHOPIFY_CATALOG_QUERY, "ShopifySandboxCatalog", {
      query: adapted.arguments.query,
      first: limit,
      after: adapted.arguments.cursor || null,
    }));
    const verifiedAt = timestamp();
    const candidates = await Promise.all(catalog.products.filter((product) => product.productUrl !== null)
      .map((product) => projectProduct(product, domain, verifiedAt, token)));
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
      traceId: `shopify-hosted-${crypto.randomUUID()}`,
    });
    return liveEnvelope(constraintOutcome(core, evaluated.degraded), verifiedAt);
  }

  async function getProduct(handle) {
    if (typeof handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(handle)) throw new TypeError("Invalid product handle");
    const readiness = await getStatus();
    if (!readiness.verified) throw fail(readiness.credential_state);
    const product = parseProductData(await graphql(SHOPIFY_PRODUCT_QUERY, "ShopifySandboxProduct", { handle }));
    if (product && product.handle !== handle) throw fail("service_unavailable");
    const verifiedAt = timestamp();
    if (!product || product.productUrl === null) return null;
    return liveEnvelope({ product: await projectProduct(product, domain, verifiedAt, token) }, verifiedAt);
  }

  return Object.freeze({ mode: "shopify_read_only", getStatus, search, getProduct });
}
