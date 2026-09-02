export const FIXED_NOW = Date.parse("2026-08-31T00:00:00.000Z");
export const FIXTURE_STORE = "fixture-development.myshopify.com";
export const FIXTURE_TOKEN = ["fixture", "server", "credential", "value"].join("-");

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

export function healthPayload(overrides = {}) {
  return { data: { shop: { name: "Fixture development store", ...overrides } } };
}

export function catalogPayload(nodes = [productNode()], pageInfo = {}) {
  return {
    data: {
      products: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo },
      },
    },
  };
}

export function productPayload(product = productNode()) {
  return { data: { product } };
}

export function searchRequest(overrides = {}) {
  return {
    contract_version: "2.0",
    product_identity: {
      name: "product_identity",
      value: "demo product",
      source: "explicit",
      scope: "product",
      hardness: "hard",
    },
    hard_constraints: [],
    soft_context: [],
    transaction_context: [],
    limit: 3,
    cursor: null,
    ...overrides,
  };
}

export function jsonResponse(payload, options = {}) {
  const response = new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(options.headers || {}) },
  });
  if (options.url !== undefined) Object.defineProperty(response, "url", { value: options.url });
  if (options.redirected !== undefined) Object.defineProperty(response, "redirected", { value: options.redirected });
  return response;
}

export function sequenceFetch(sequence) {
  const queue = [...sequence];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), init, body: JSON.parse(String(init.body || "{}")) };
    calls.push(call);
    if (!queue.length) throw new Error("fixture fetch queue exhausted");
    const next = queue.shift();
    if (typeof next === "function") return next(call);
    if (next instanceof Response || (next && typeof next.status === "number" && next.headers)) return next;
    return jsonResponse(next);
  };
  return { fetchImpl, calls };
}
