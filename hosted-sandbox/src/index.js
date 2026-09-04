import { assertSameOrigin, authorizeInvite } from "./access.js";
import { createRateLimitGate } from "./rate-limit.js";
import { error, json, withSecurityHeaders } from "./responses.js";
import { createHostedShopifyProvider, HostedShopifyError } from "./shopify-provider.js";

const MAX_BODY_BYTES = 32 * 1024;
const STATIC_ASSETS = new Map([
  ["/", ["/index.html", "text/html; charset=utf-8"]],
  ["/sandbox", ["/index.html", "text/html; charset=utf-8"]],
  ["/sandbox/", ["/index.html", "text/html; charset=utf-8"]],
  ["/sandbox/app.js", ["/app.js", "text/javascript; charset=utf-8"]],
  ["/sandbox/styles.css", ["/styles.css", "text/css; charset=utf-8"]],
]);
const FORBIDDEN_BROWSER_HEADERS = [
  "authorization", "cookie", "x-shopify-access-token", "x-shopify-storefront-access-token",
];
const providers = new WeakMap();

async function hashedRateKey(request) {
  const proof = request.headers.get("x-sandbox-invite") || "missing";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return `invite:${[...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function providerFor(env, quota) {
  if (!providers.has(env)) {
    const fetchImpl = env.SANDBOX_DEPLOYMENT_MODE === "test" && typeof env.TEST_FETCH === "function"
      ? env.TEST_FETCH
      : globalThis.fetch;
    providers.set(env, createHostedShopifyProvider(env, { fetchImpl, quota }));
  }
  return providers.get(env);
}

function configuredPublicBoundary(env) {
  return env.SANDBOX_DEPLOYMENT_MODE === "public"
    && env.SANDBOX_ACCESS_MODE === "protected"
    && env.ASSETS && typeof env.ASSETS.fetch === "function";
}

function browserHeadersAllowed(request) {
  return FORBIDDEN_BROWSER_HEADERS.every((name) => !request.headers.has(name));
}

async function serveAsset(request, env, asset) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") return error("SERVICE_UNAVAILABLE", 503);
  const [pathname, contentType] = asset;
  const target = new URL(pathname, request.url);
  const assetRequest = new Request(target, { method: "GET", headers: { accept: request.headers.get("accept") || "*/*" } });
  let response;
  try { response = await env.ASSETS.fetch(assetRequest); }
  catch { return error("SERVICE_UNAVAILABLE", 503); }
  if (!response || response.status !== 200) return error("SANDBOX_ASSET_NOT_FOUND", 404);
  return withSecurityHeaders(response, contentType);
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/iu.test(contentType)) {
    throw new TypeError("INVALID_CONTENT_TYPE");
  }
  const declared = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RangeError("PAYLOAD_TOO_LARGE");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RangeError("PAYLOAD_TOO_LARGE");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("INVALID_JSON"); }
}

function publicProviderError(cause) {
  if (cause instanceof HostedShopifyError) return error(cause.publicCode, cause.httpStatus);
  if (cause instanceof RangeError) return error("PAYLOAD_TOO_LARGE", 413);
  if (cause instanceof TypeError) return error("INVALID_REQUEST", 400);
  return error("SERVICE_UNAVAILABLE", 503);
}

async function handleApi(request, env, url) {
  if (!assertSameOrigin(request) || !browserHeadersAllowed(request)) return error("REQUEST_BOUNDARY_REJECTED", 403);
  const gate = createRateLimitGate(env);
  if (!gate.configured) return error("SERVICE_UNAVAILABLE", 503);
  if (!await gate.allow("hosted-sandbox-preauth")) return error("QUOTA_EXCEEDED", 429);
  if (!await authorizeInvite(request, env)) return error("INVITE_REQUIRED", 401);
  if (!await gate.allow(await hashedRateKey(request))) return error("QUOTA_EXCEEDED", 429);
  if (url.search) return error("INVALID_REQUEST", 400);

  const provider = providerFor(env, gate.quota);
  try {
    if (request.method === "GET" && url.pathname === "/sandbox/status") {
      return json(await provider.getStatus());
    }
    if (request.method === "POST" && url.pathname === "/sandbox/api/search/v2") {
      return json(await provider.search(await readJson(request)));
    }
    const productMatch = request.method === "GET"
      ? url.pathname.match(/^\/sandbox\/api\/products\/([a-z0-9-]{1,100})$/u)
      : null;
    if (productMatch) {
      const product = await provider.getProduct(productMatch[1]);
      return product ? json(product) : error("PRODUCT_NOT_FOUND", 404);
    }
    return error("SANDBOX_ROUTE_NOT_ALLOWED", 404);
  } catch (cause) {
    return publicProviderError(cause);
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const asset = request.method === "GET" && !url.search ? STATIC_ASSETS.get(url.pathname) : null;
      if (env.SANDBOX_DEPLOYMENT_MODE === "public" && !configuredPublicBoundary(env)) {
        return error("SERVICE_UNAVAILABLE", 503);
      }
      if (asset) return serveAsset(request, env, asset);
      if (url.pathname === "/sandbox/status"
        || url.pathname === "/sandbox/api/search/v2"
        || url.pathname.startsWith("/sandbox/api/products/")) {
        return handleApi(request, env, url);
      }
      return error("SANDBOX_ROUTE_NOT_ALLOWED", 404);
    } catch {
      return error("SERVICE_UNAVAILABLE", 503);
    }
  },
};
