import { createHash } from "node:crypto";

export const INVITE = "hosted-preview-invite-proof-123456789";
export const TOKEN = "fixture-storefront-token-value";
export const DOMAIN = "fixture-development.myshopify.com";

export function inviteHash(value = INVITE) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function productNode(overrides = {}) {
  return {
    handle: "public-demo-product",
    title: "Public demo product",
    description: "A published Storefront fixture.",
    onlineStoreUrl: "https://shop.example/products/public-demo-product",
    availableForSale: true,
    productType: "Demo accessories",
    images: { nodes: [{ url: "https://cdn.shopify.com/s/files/1/demo-product.jpg", altText: "Public demo product" }] },
    options: [
      { name: "Material", values: ["Stainless steel"] },
      { name: "Model", values: ["DEMO-20"] },
      { name: "Color", values: ["Silver"] },
    ],
    priceRange: { minVariantPrice: { amount: "19.95", currencyCode: "USD" } },
    ...overrides,
  };
}

export const health = () => ({ data: { shop: { name: "Fixture development store" } } });
export const catalog = (nodes = [productNode()], pageInfo = {}) => ({
  data: { products: { nodes, pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo } } },
});
export const detail = (product = productNode()) => ({ data: { product } });

export function jsonResponse(value, options = {}) {
  const response = new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(options.headers || {}) },
  });
  if (options.url !== undefined) Object.defineProperty(response, "url", { value: options.url });
  if (options.redirected !== undefined) Object.defineProperty(response, "redirected", { value: options.redirected });
  return response;
}

export function sequenceFetch(values) {
  const queue = [...values];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (!queue.length) throw new Error("fixture queue exhausted");
    const next = queue.shift();
    return next instanceof Response ? next : jsonResponse(next);
  };
  return { fetch, calls };
}

export function requestBody(query = "demo product") {
  return {
    contract_version: "2.0",
    product_identity: { name: "product_identity", value: query, source: "explicit", scope: "product", hardness: "hard" },
    hard_constraints: [],
    soft_context: [],
    transaction_context: [],
    limit: 3,
    cursor: null,
  };
}

export function testEnv(fetch, overrides = {}) {
  return {
    SANDBOX_DEPLOYMENT_MODE: "test",
    SANDBOX_ACCESS_MODE: "protected",
    SANDBOX_INVITE_SHA256: inviteHash(),
    SANDBOX_RATE_LIMIT_LIMIT: "60",
    SANDBOX_RATE_LIMIT_PERIOD: "60",
    SANDBOX_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SHOPIFY_STORE_DOMAIN: DOMAIN,
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: TOKEN,
    TEST_FETCH: fetch,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    ...overrides,
  };
}

export function apiRequest(path, options = {}) {
  const headers = new Headers({ "x-sandbox-invite": INVITE, ...(options.headers || {}) });
  return new Request(`https://sandbox.example${path}`, { ...options, headers });
}
