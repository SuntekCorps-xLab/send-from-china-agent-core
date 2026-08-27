const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const TERMINAL_TASK_STATES = new Set([
  "RESULTS_READY", "COMPLETED", "FAILED", "NO_MATCH", "CANCELED", "CANCELLED",
]);

export {
  SEARCH_CONTRACT_VERSION,
  PUBLIC_ATTRIBUTE_NAMES,
  PUBLIC_ATTRIBUTE_POLICY_VERSION,
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  createSearchContractV1Adapter,
  normalizeSearchContractV2Request,
  parseSearchContractV2Request,
  projectSearchContractV2Response,
} from "./search-contract-v2.js";

import {
  adaptSearchContractV1ResponseToV2,
  adaptSearchContractV2RequestToV1,
  projectSearchContractV2Response,
} from "./search-contract-v2.js";

export class SendFromChinaError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SendFromChinaError";
    this.code = String(options.code || "REQUEST_FAILED");
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.requestId = String(options.requestId || "");
    this.retryAfter = String(options.retryAfter || "");
  }
}

function normalizedBase(value) {
  const candidate = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(candidate); } catch { throw new TypeError("baseUrl must be a valid absolute URL"); }
  const local = url.hostname === "localhost"
    || url.hostname === "[::1]"
    || url.hostname === ["127", "0", "0", "1"].join(".");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("baseUrl must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function allowedOrigins(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" ? url.origin : "";
    } catch { return ""; }
  }).filter(Boolean));
}

function safeCode(value, fallback) {
  return /^[A-Z0-9_:-]{2,100}$/.test(String(value || "")) ? String(value) : fallback;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolvePurchaseHandoff(product, options = {}) {
  const origins = allowedOrigins(options.commerceOrigins);
  if (!product || typeof product !== "object" || origins.size === 0) return null;
  const candidates = [
    ["checkout", product.checkout_url],
    ["add_to_cart", product.add_to_cart_url],
    ["product", product.product_url || product.url],
  ];
  for (const [kind, value] of candidates) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.username || url.password || !origins.has(url.origin)) continue;
      return Object.freeze({ kind, url: url.href, requires_user: true });
    } catch {
      // An absent or malformed candidate is not a purchase destination.
    }
  }
  return null;
}

export function createSendFromChinaClient(options = {}) {
  const baseUrl = normalizedBase(options.baseUrl);
  const token = String(options.token || "").trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const commerceOrigins = [...allowedOrigins(options.commerceOrigins)];
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  let requestSequence = 0;

  async function request(path, init = {}, { authenticated = true, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
    const externalSignal = init.signal;
    const abort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers(init.headers || {});
      headers.set("accept", "application/json");
      if (init.body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
      if (authenticated) {
        if (!token) throw new SendFromChinaError("This operation requires an access token", { code: "MISSING_CREDENTIAL" });
        headers.set("authorization", `Bearer ${token}`);
      }
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const requestId = response.headers.get("x-request-id") || response.headers.get("cf-ray") || "";
      let payload = null;
      try { payload = await response.json(); } catch {
        if (response.ok) throw new SendFromChinaError("The service returned invalid JSON", {
          code: "INVALID_RESPONSE", status: response.status, requestId,
        });
      }
      if (!response.ok) {
        throw new SendFromChinaError("The Send From China request failed", {
          code: safeCode(payload?.error?.code || payload?.error, `HTTP_${response.status}`),
          status: response.status,
          requestId,
          retryAfter: response.headers.get("retry-after") || "",
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof SendFromChinaError) throw error;
      const timedOut = controller.signal.aborted && !externalSignal?.aborted;
      throw new SendFromChinaError(timedOut ? "The Send From China request timed out" : "Could not reach Send From China", {
        code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", cause: error,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  async function mcp(method, params, { authenticated = true, signal } = {}) {
    const id = `request-${Date.now()}-${++requestSequence}`;
    const payload = await request("/mcp", {
      method: "POST", signal,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    }, { authenticated });
    if (payload?.error) throw new SendFromChinaError("The MCP server rejected the request", {
      code: safeCode(payload.error.code, "MCP_ERROR"),
    });
    return payload?.result;
  }

  async function callTool(name, args = {}, options = {}) {
    const result = await mcp("tools/call", { name, arguments: args }, options);
    const value = result?.structuredContent;
    if (!value || typeof value !== "object") {
      throw new SendFromChinaError("The MCP tool returned no structured content", { code: "INVALID_TOOL_RESPONSE" });
    }
    if (result?.isError || value.error) throw new SendFromChinaError("The Send From China tool could not complete the request", {
      code: safeCode(value.error, "TOOL_ERROR"),
    });
    return value;
  }

  const client = {
    async getCapabilities(options = {}) {
      return request("/.well-known/send-from-china.json", { method: "GET", signal: options.signal }, { authenticated: false });
    },
    async listTools(options = {}) {
      const value = await mcp("tools/list", undefined, { authenticated: false, signal: options.signal });
      return Array.isArray(value?.tools) ? value.tools : [];
    },
    getAgentAccess: (args = {}, options = {}) => callTool("get_agent_access", args, options),
    productSearch: (args, options = {}) => callTool("product_search", args, options),
    async searchContractV2(searchRequest, options = {}) {
      const normalized = adaptSearchContractV2RequestToV1(searchRequest).request;
      const value = await request("/api/search/v2", {
        method: "POST", signal: options.signal, body: JSON.stringify(normalized),
      });
      return projectSearchContractV2Response(value);
    },
    async searchContractV2ViaV1(searchRequest, options = {}) {
      const adapted = adaptSearchContractV2RequestToV1(searchRequest, { operation: options.operation });
      const legacy = await callTool("product_search", adapted.arguments, options);
      return adaptSearchContractV1ResponseToV2(legacy, {
        request: adapted.request,
        relaxations: adapted.relaxations,
        traceId: legacy.trace_id || legacy.search_id || `sdk-compat-${Date.now()}-${++requestSequence}`,
      });
    },
    searchCatalog: (args, options = {}) => callTool("search_catalog", args, options),
    getProduct: (args, options = {}) => callTool("get_product", args, options),
    getQuote: (args, options = {}) => callTool("get_quote", args, options),
    createSourcingTask: (args, options = {}) => callTool("create_sourcing_task", args, options),
    getSourcingTask: (taskId, options = {}) => callTool("get_sourcing_task", { task_id: taskId }, options),
    listSourcingResults: (taskId, args = {}, options = {}) => callTool("list_sourcing_results", { task_id: taskId, ...args }, options),
    resolvePurchaseHandoff: (product) => resolvePurchaseHandoff(product, { commerceOrigins }),
    async waitForSourcingTask(taskId, options = {}) {
      const deadline = Date.now() + (Number(options.timeoutMs) || 10 * 60_000);
      const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
      let lastStatus = "";
      while (Date.now() <= deadline) {
        const response = await client.getSourcingTask(taskId, { signal: options.signal });
        const task = response?.task || response;
        const status = String(task?.status || "").toUpperCase();
        if (!status) throw new SendFromChinaError("The task response has no status", { code: "INVALID_TASK_RESPONSE" });
        if (status !== lastStatus) { options.onStatus?.(task); lastStatus = status; }
        if (TERMINAL_TASK_STATES.has(status)) return task;
        await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), options.signal);
      }
      throw new SendFromChinaError("The sourcing task did not finish before the deadline", { code: "TASK_TIMEOUT" });
    },
    async listAllSourcingResults(taskId, options = {}) {
      const results = [];
      let cursor = "";
      const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 100, 100));
      for (let page = 0; page < maxPages; page += 1) {
        const response = await client.listSourcingResults(taskId, {
          ...(cursor ? { cursor } : {}), limit: Math.max(1, Math.min(Number(options.limit) || 50, 100)),
        }, { signal: options.signal });
        results.push(...(Array.isArray(response?.results) ? response.results : []));
        cursor = String(response?.next_cursor || "");
        if (!cursor) return results;
      }
      throw new SendFromChinaError("Result pagination exceeded the configured page limit", { code: "PAGINATION_LIMIT" });
    },
  };
  return Object.freeze(client);
}
