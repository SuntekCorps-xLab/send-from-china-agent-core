import {
  createManagedPublicCatalogClient,
  createSendFromChinaClient,
  normalizeSearchContractV2Request,
  projectSearchContractV2Response,
  resolvePurchaseHandoff,
} from "../sdk/src/index.js";

function first(value, field) {
  return value?.[field]?.[0] || null;
}

function serviceBase(value) {
  const url = new URL(String(value || ""));
  const loopback = url.hostname === "localhost"
    || url.hostname === ["127", "0", "0", "1"].join(".")
    || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must be HTTPS or a loopback HTTP origin without embedded state");
  }
  return url.origin;
}

export async function managedMcpSdkFlow(query, options = {}) {
  const client = createManagedPublicCatalogClient({ fetch: options.fetch });
  const search = await client.productSearch({
    query,
    mode: "catalog",
    operation: "confirm_search",
    limit: 5,
  });
  const summary = first(search, "products");
  const product = summary ? await client.getProduct({ handle: summary.handle }) : null;
  return Object.freeze({
    profile: "hosted_managed_public_mcp",
    search,
    product,
    purchaseHandoff: product ? client.resolvePurchaseHandoff(product) : null,
  });
}

export async function selfHostedMcpSdkFlow(query, options = {}) {
  const client = createSendFromChinaClient({
    baseUrl: options.baseUrl,
    token: options.token,
    commerceOrigins: options.commerceOrigins,
    fetch: options.fetch,
  });
  const search = await client.productSearch({ query, operation: "search", limit: 5 });
  const summary = first(search, "products");
  const product = summary ? await client.getProduct({ slug: summary.slug }) : null;
  return Object.freeze({
    profile: "self_hosted_authenticated_mcp",
    search,
    product,
    purchaseHandoff: product ? client.resolvePurchaseHandoff(product) : null,
  });
}

export async function selfHostedHttpFlow(searchRequest, options = {}) {
  const baseUrl = serviceBase(options.baseUrl);
  const token = String(options.token || "").trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!token) throw new TypeError("token is required for the self-hosted HTTP profile");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  const searchResponse = await fetchImpl(`${baseUrl}/api/search/v2`, {
    method: "POST",
    headers,
    body: JSON.stringify(normalizeSearchContractV2Request(searchRequest)),
    redirect: "error",
  });
  if (!searchResponse.ok) throw new Error(`Search failed with HTTP ${searchResponse.status}`);
  const search = projectSearchContractV2Response(await searchResponse.json());
  const summary = first(search, "results");
  if (!summary) {
    return Object.freeze({
      profile: "self_hosted_authenticated_http",
      search,
      product: null,
      purchaseHandoff: null,
    });
  }
  const productResponse = await fetchImpl(`${baseUrl}/api/products/${encodeURIComponent(summary.slug)}`, {
    method: "GET",
    headers: { accept: headers.accept, authorization: headers.authorization, "cache-control": "no-store" },
    redirect: "error",
  });
  if (!productResponse.ok) throw new Error(`Product read failed with HTTP ${productResponse.status}`);
  const product = await productResponse.json();
  return Object.freeze({
    profile: "self_hosted_authenticated_http",
    search,
    product,
    purchaseHandoff: resolvePurchaseHandoff(product, { commerceOrigins: options.commerceOrigins }),
  });
}
