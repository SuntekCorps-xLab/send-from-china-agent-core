import { validateSandboxStatus } from "./status-contract.mjs";

const LOOPBACK_HOSTS = new Set([["127", "0", "0", "1"].join("."), "localhost", "[::1]"]);
const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-shopify-access-token",
  "x-shopify-storefront-access-token",
  "x-sandbox-mode",
  "x-shopify-sandbox-mode",
]);

function sandboxUrl(pathname, origin) {
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || !LOOPBACK_HOSTS.has(base.hostname)) {
    throw new TypeError("The browser sandbox origin must be loopback.");
  }
  const target = new URL(pathname, base.origin);
  if (target.origin !== base.origin
    || !(target.pathname === "/sandbox" || target.pathname.startsWith("/sandbox/"))) {
    throw new TypeError("The browser client can call only the local sandbox.");
  }
  return target;
}

function safeHeaders(value) {
  const headers = new Headers(value || {});
  for (const name of FORBIDDEN_HEADER_NAMES) {
    if (headers.has(name)) throw new TypeError("Browser credentials are not accepted.");
  }
  return headers;
}

export function createSandboxBrowserClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const origin = options.origin || globalThis.location?.origin;
  if (typeof fetchImpl !== "function" || !origin) throw new TypeError("The browser sandbox client is unavailable.");

  async function requestJson(pathname, init = {}) {
    const target = sandboxUrl(pathname, origin);
    const response = await fetchImpl(target.href, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: safeHeaders(init.headers),
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`HTTP_${response.status}`); }
    if (!response.ok) throw new Error(payload?.error?.code || `HTTP_${response.status}`);
    return payload;
  }

  async function getStatus() {
    const status = await requestJson("/sandbox/status");
    if (!validateSandboxStatus(status)) throw new Error("SANDBOX_STATUS_INVALID");
    return status;
  }

  return Object.freeze({
    requestJson,
    getStatus,
    search: (body) => requestJson("/sandbox/api/search/v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    product: (handle) => {
      if (typeof handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(handle)) {
        throw new TypeError("Invalid product handle");
      }
      return requestJson(`/sandbox/api/products/${handle}`);
    },
  });
}
