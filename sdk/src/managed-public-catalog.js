const ENDPOINT = "https://wp-api.sendfromchina.ai/mcp";
const STOREFRONT_ORIGIN = "https://sendfromchina.ai";
const PROTOCOL_VERSION = "2025-06-18";
const MAX_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CONCURRENCY = 2;

const TOOL_NAMES = Object.freeze([
  "product_search",
  "search_catalog",
  "browse_catalog",
  "ask_catalog",
  "get_product",
]);

const TOOL_SET = new Set(TOOL_NAMES);
const SEARCH_KEYS = new Set([
  "contract_version", "trace_id", "normalized_intent", "relaxations", "search_id",
  "criteria", "mode", "model", "language", "status", "action", "reply",
  "criteria_complete", "missing_criteria", "request_query", "count", "total_candidates",
  "results", "has_more", "next_cursor", "limit", "cursor", "coverage", "exhaustive",
  "search_scope_exhausted", "scan_limit_reached", "global_catalog_exhaustive",
  "dynamic_request_recommended", "degraded", "retrieval_incomplete", "degradation_reason",
  "warnings", "bounded_plan_complete", "criteria_enforced",
  "criteria_checked_when_evidence_exists", "criteria_used_for_ranking", "pagination",
  "search_scope",
]);
const SEARCH_PRODUCT_KEYS = new Set([
  "handle", "title", "price_usd", "currency", "url", "image", "summary", "why",
  "available", "catalog_available", "purchasable", "purchase_status",
  "market_compatibility", "commercial_review_required",
]);
const DETAIL_KEYS = new Set([
  "title", "handle", "url", "product_type", "product_type_basis", "price", "currency",
  "price_usd", "image", "summary", "target_personas", "use_cases", "not_for", "faq",
  "catalog_available", "purchasable", "purchase_status", "cart_verification_required",
  "fact_evidence", "variants", "note",
]);
const PUBLIC_CODES = new Set([
  "INVALID_ARGUMENT", "INVALID_RESPONSE", "REQUEST_ABORTED", "REQUEST_TIMEOUT",
  "RESPONSE_TOO_LARGE", "CONCURRENCY_LIMIT", "QUOTA_EXCEEDED",
  "SERVICE_UNAVAILABLE", "NETWORK_ERROR", "DISCOVERY_REQUIRED",
]);

export const MANAGED_PUBLIC_CATALOG = Object.freeze({
  endpoint: ENDPOINT,
  storefrontOrigin: STOREFRONT_ORIGIN,
  protocolVersion: PROTOCOL_VERSION,
  tools: TOOL_NAMES,
  writes: false,
});

export class ManagedPublicCatalogError extends Error {
  constructor(code, options = {}) {
    const safeCode = PUBLIC_CODES.has(code) ? code : "SERVICE_UNAVAILABLE";
    const messages = {
      INVALID_ARGUMENT: "The managed catalog request is invalid",
      INVALID_RESPONSE: "The managed catalog returned an invalid response",
      REQUEST_ABORTED: "The managed catalog request was canceled",
      REQUEST_TIMEOUT: "The managed catalog request timed out",
      RESPONSE_TOO_LARGE: "The managed catalog response is too large",
      CONCURRENCY_LIMIT: "The managed catalog client concurrency limit was reached",
      QUOTA_EXCEEDED: "The managed catalog request quota was exceeded",
      SERVICE_UNAVAILABLE: "The managed catalog is unavailable",
      NETWORK_ERROR: "Could not reach the managed catalog",
      DISCOVERY_REQUIRED: "The managed catalog discovery contract was not verified",
    };
    super(messages[safeCode]);
    this.name = "ManagedPublicCatalogError";
    this.code = safeCode;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryAfter = typeof options.retryAfter === "string" && /^\d{1,6}$/u.test(options.retryAfter)
      ? options.retryAfter
      : "";
  }
}

function fail(code, options) {
  throw new ManagedPublicCatalogError(code, options);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!plainObject(value)) fail("INVALID_RESPONSE");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_RESPONSE");
  return value;
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`value must be an integer from 1 to ${maximum}`);
  return value;
}

function validateOptions(options) {
  if (!plainObject(options)) throw new TypeError("options must be an object");
  const allowed = new Set(["fetch", "timeoutMs", "maxResponseBytes", "maxConcurrency"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`Unsupported managed catalog option: ${key}`);
}

function validateArguments(value, allowed) {
  if (!plainObject(value)) fail("INVALID_ARGUMENT");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_ARGUMENT");
}

function validateSearchArguments(args) {
  validateArguments(args, new Set(["query", "criteria", "mode", "operation", "limit", "cursor"]));
  if (args.query !== undefined && (typeof args.query !== "string" || !args.query.trim()
    || [...args.query].length > 300)) fail("INVALID_ARGUMENT");
  if (args.criteria !== undefined) {
    validateArguments(args.criteria, new Set([
      "category", "use_case", "audience", "age_min", "age_max", "price_min", "price_max",
      "price_flexible", "quantity", "ship_to", "delivery_days_max", "colors", "materials",
      "must_have", "exclude", "keywords",
    ]));
  }
  if (args.query === undefined && (!plainObject(args.criteria) || Object.keys(args.criteria).length === 0)) fail("INVALID_ARGUMENT");
  if (args.mode !== undefined && !["catalog", "recommendations"].includes(args.mode)) fail("INVALID_ARGUMENT");
  if (args.operation !== undefined && !["search", "confirm_search", "more"].includes(args.operation)) fail("INVALID_ARGUMENT");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) fail("INVALID_ARGUMENT");
  if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 1_000)) fail("INVALID_ARGUMENT");
}

function validateHandleArguments(args) {
  validateArguments(args, new Set(["handle"]));
  if (typeof args.handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(args.handle)) fail("INVALID_ARGUMENT");
}

function validateUrl(value, handle) {
  if (typeof value !== "string" || value.length > 2_048) fail("INVALID_RESPONSE");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_RESPONSE"); }
  if (url.protocol !== "https:" || url.origin !== STOREFRONT_ORIGIN || url.username || url.password
    || url.search || url.hash || url.pathname !== `/products/${handle}`) fail("INVALID_RESPONSE");
  return url.href;
}

function publicHttpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2_048) fail("INVALID_RESPONSE");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_RESPONSE"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !host
    || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || /^\d+(?:\.\d+){0,3}$/u.test(host) || host.includes(":")) {
    fail("INVALID_RESPONSE");
  }
  return url.href;
}

function optionalPublicString(value, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum) fail("INVALID_RESPONSE");
  return value;
}

function projectProduct(value, detail = false) {
  exactKeys(value, detail ? DETAIL_KEYS : SEARCH_PRODUCT_KEYS);
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 300) fail("INVALID_RESPONSE");
  if (typeof value.handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(value.handle)) fail("INVALID_RESPONSE");
  if (typeof value.price_usd !== "number" || !Number.isFinite(value.price_usd) || value.price_usd < 0
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)
    || typeof value.catalog_available !== "boolean" || typeof value.purchasable !== "boolean"
    || typeof value.purchase_status !== "string" || value.purchase_status.length > 100) fail("INVALID_RESPONSE");
  if (detail && (typeof value.price !== "number" || !Number.isFinite(value.price) || value.price < 0
    || typeof value.cart_verification_required !== "boolean")) fail("INVALID_RESPONSE");
  if (!detail && (typeof value.available !== "boolean" || typeof value.commercial_review_required !== "boolean")) {
    fail("INVALID_RESPONSE");
  }
  const productUrl = validateUrl(value.url, value.handle);
  const imageUrl = value.image ? publicHttpsUrl(value.image) : undefined;
  const summary = optionalPublicString(value.summary, 2_000);
  const output = {
    title: value.title,
    handle: value.handle,
    price: Object.freeze({ amount: value.price_usd, currency: value.currency }),
    product_url: productUrl,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
    catalog_available: value.catalog_available,
    purchasable: value.purchasable,
    purchase_status: value.purchase_status,
    ...(detail ? { cart_verification_required: value.cart_verification_required } : {
      available: value.available,
      commercial_review_required: value.commercial_review_required,
    }),
  };
  if (!detail) {
    exactKeys(value.market_compatibility, new Set(["status", "review_required", "country", "reason"]));
    if (typeof value.market_compatibility.status !== "string"
      || typeof value.market_compatibility.review_required !== "boolean") fail("INVALID_RESPONSE");
    output.market_compatibility = Object.freeze({
      status: value.market_compatibility.status,
      review_required: value.market_compatibility.review_required,
      country: optionalPublicString(value.market_compatibility.country, 100) || "",
      reason: optionalPublicString(value.market_compatibility.reason, 300) || "",
    });
  }
  return Object.freeze(output);
}

function validateSearch(value) {
  exactKeys(value, SEARCH_KEYS);
  if (!["results", "needs_clarification", "no_match", "degraded"].includes(value.status)) fail("INVALID_RESPONSE");
  if (!["catalog", "recommendations"].includes(value.mode) || !Array.isArray(value.results) || value.results.length > 50) {
    fail("INVALID_RESPONSE");
  }
  exactKeys(value.normalized_intent, new Set([
    "product_identity", "hard_constraints", "soft_context", "transaction_context",
  ]));
  exactKeys(value.criteria, new Set([
    "category", "use_case", "audience", "age_min", "age_max", "price_min", "price_max",
    "price_flexible", "quantity", "ship_to", "delivery_days_max", "colors", "materials",
    "must_have", "exclude", "keywords",
  ]));
  const pagination = exactKeys(value.pagination, new Set(["limit", "cursor", "next_cursor", "has_more"]));
  const searchScope = exactKeys(value.search_scope, new Set([
    "plan_complete", "scope_exhausted", "global_catalog_exhaustive", "scan_limit_reached",
    "degraded", "degraded_reason",
  ]));
  const products = value.results.map((product) => projectProduct(product, false));
  if (!Number.isInteger(value.count) || value.count !== products.length
    || typeof value.has_more !== "boolean" || typeof value.exhaustive !== "boolean"
    || typeof value.search_scope_exhausted !== "boolean" || typeof value.degraded !== "boolean"
    || typeof value.retrieval_incomplete !== "boolean" || typeof value.scan_limit_reached !== "boolean"
    || typeof value.bounded_plan_complete !== "boolean" || typeof value.global_catalog_exhaustive !== "boolean"
    || typeof pagination.has_more !== "boolean"
    || typeof searchScope.plan_complete !== "boolean" || typeof searchScope.scope_exhausted !== "boolean"
    || typeof searchScope.global_catalog_exhaustive !== "boolean"
    || typeof searchScope.scan_limit_reached !== "boolean" || typeof searchScope.degraded !== "boolean"
    || (value.degradation_reason !== null && typeof value.degradation_reason !== "string")
    || (searchScope.degraded_reason !== null && typeof searchScope.degraded_reason !== "string")) {
    fail("INVALID_RESPONSE");
  }
  if (pagination.next_cursor !== null && typeof pagination.next_cursor !== "string") fail("INVALID_RESPONSE");
  if (pagination.has_more !== value.has_more || pagination.next_cursor !== value.next_cursor
    || searchScope.plan_complete !== value.bounded_plan_complete
    || searchScope.scope_exhausted !== value.search_scope_exhausted
    || searchScope.global_catalog_exhaustive !== value.global_catalog_exhaustive
    || searchScope.scan_limit_reached !== value.scan_limit_reached
    || searchScope.degraded !== value.degraded
    || searchScope.degraded_reason !== value.degradation_reason) fail("INVALID_RESPONSE");
  if (value.status === "no_match" && (products.length || value.has_more || value.next_cursor !== null
    || !value.exhaustive || !value.search_scope_exhausted || !value.bounded_plan_complete
    || value.scan_limit_reached || value.degraded || value.retrieval_incomplete
    || value.degradation_reason !== null)) fail("INVALID_RESPONSE");
  if ((value.status === "degraded") !== value.degraded) fail("INVALID_RESPONSE");
  if (value.next_cursor !== null && typeof value.next_cursor !== "string") fail("INVALID_RESPONSE");
  if (value.has_more !== Boolean(value.next_cursor)) fail("INVALID_RESPONSE");
  return Object.freeze({
    status: value.status,
    action: optionalPublicString(value.action, 100) || "",
    mode: value.mode,
    products: Object.freeze(products),
    count: value.count,
    has_more: value.has_more,
    next_cursor: value.next_cursor,
    exhaustive: value.exhaustive,
    search_scope_exhausted: value.search_scope_exhausted,
    degraded: value.degraded,
    retrieval_incomplete: value.retrieval_incomplete,
    boundary: Object.freeze({ writes: false, transaction: "public_product_link_only" }),
  });
}

function validateToolList(value) {
  exactKeys(value, new Set(["tools", "nextCursor"]));
  if (!Array.isArray(value.tools) || value.nextCursor) fail("INVALID_RESPONSE");
  const names = new Set();
  for (const tool of value.tools) {
    exactKeys(tool, new Set(["name", "title", "description", "inputSchema", "outputSchema", "annotations"]));
    if (typeof tool.name !== "string" || !plainObject(tool.inputSchema)) fail("INVALID_RESPONSE");
    if (!TOOL_SET.has(tool.name)) continue;
    names.add(tool.name);
    if (tool.name === "get_product") {
      const schema = tool.inputSchema;
      if (schema.type !== "object" || ![undefined, false].includes(schema.additionalProperties) || !plainObject(schema.properties)
        || Object.keys(schema.properties).join(",") !== "handle"
        || !Array.isArray(schema.required) || schema.required.join(",") !== "handle") fail("INVALID_RESPONSE");
    }
    if (tool.name === "product_search") {
      const properties = tool.inputSchema.properties;
      if (tool.inputSchema.type !== "object" || !plainObject(properties)
        || !plainObject(properties.mode) || !plainObject(properties.operation)
        || properties.mode.enum?.join(",") !== "catalog,recommendations"
        || properties.operation.enum?.join(",") !== "search,confirm_search,more") fail("INVALID_RESPONSE");
    }
  }
  if (names.size !== TOOL_NAMES.length || [...names].sort().join(",") !== [...TOOL_NAMES].sort().join(",")) {
    fail("INVALID_RESPONSE");
  }
  return Object.freeze([...TOOL_NAMES]);
}

function validateEnvelope(payload, id) {
  exactKeys(payload, new Set(["jsonrpc", "id", "result", "error"]));
  if (payload.jsonrpc !== "2.0" || payload.id !== id || (payload.result === undefined) === (payload.error === undefined)) {
    fail("INVALID_RESPONSE");
  }
  if (payload.error !== undefined) {
    exactKeys(payload.error, new Set(["code", "message", "data"]));
    fail(payload.error.code === -32602 ? "INVALID_ARGUMENT" : "SERVICE_UNAVAILABLE");
  }
  return payload.result;
}

function validateInitialize(value) {
  exactKeys(value, new Set(["protocolVersion", "capabilities", "serverInfo", "instructions"]));
  if (value.protocolVersion !== PROTOCOL_VERSION || !plainObject(value.capabilities)
    || !plainObject(value.capabilities.tools) || !plainObject(value.serverInfo)) fail("INVALID_RESPONSE");
  exactKeys(value.capabilities, new Set(["tools"]));
  exactKeys(value.capabilities.tools, new Set(["listChanged"]));
  exactKeys(value.serverInfo, new Set(["name", "title", "version"]));
}

function validateToolResult(value, tool) {
  exactKeys(value, new Set(["content", "structuredContent", "isError"]));
  if (value.isError === true || !plainObject(value.structuredContent)) fail("SERVICE_UNAVAILABLE");
  if (!Array.isArray(value.content)) fail("INVALID_RESPONSE");
  for (const item of value.content) {
    exactKeys(item, new Set(["type", "text"]));
    if (item.type !== "text" || typeof item.text !== "string") fail("INVALID_RESPONSE");
  }
  return tool === "product_search"
    ? validateSearch(value.structuredContent)
    : projectProduct(value.structuredContent, true);
}

async function readBoundedBody(response, maximum, timeout) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== "function") {
    const bytes = new Uint8Array(await Promise.race([response.arrayBuffer(), timeout]));
    if (bytes.byteLength > maximum) fail("RESPONSE_TOO_LARGE");
    return bytes;
  }
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.byteLength;
      if (length > maximum) {
        try { reader.cancel().catch(() => {}); } catch {}
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { reader.cancel().catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createManagedPublicCatalogClient(options = {}) {
  validateOptions(options);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const timeoutMs = boundedInteger(options.timeoutMs, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  const maxConcurrency = boundedInteger(options.maxConcurrency, MAX_CONCURRENCY, MAX_CONCURRENCY);
  let sequence = 0;
  let active = 0;
  let readyPromise;

  async function request(method, params, signal) {
    if (active >= maxConcurrency) fail("CONCURRENCY_LIMIT");
    if (signal?.aborted) fail("REQUEST_ABORTED");
    active += 1;
    const id = `managed-public-${++sequence}`;
    const controller = new AbortController();
    let abortSource = "";
    const abort = () => {
      abortSource = "external";
      controller.abort(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortSource = "timeout";
          controller.abort(new Error("deadline"));
          reject(new ManagedPublicCatalogError("REQUEST_TIMEOUT"));
        }, timeoutMs);
      });
      const headers = new Headers({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        ...(method === "initialize" ? {} : { "mcp-protocol-version": PROTOCOL_VERSION }),
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      const fetchRequest = fetchImpl(ENDPOINT, {
        method: "POST", headers, body, signal: controller.signal, redirect: "error",
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      });
      const response = await Promise.race([fetchRequest, timeout]);
      if (response.redirected || (response.url && response.url !== ENDPOINT)) fail("INVALID_RESPONSE");
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxResponseBytes) fail("RESPONSE_TOO_LARGE");
      const bytes = await readBoundedBody(response, maxResponseBytes, timeout);
      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("INVALID_RESPONSE"); }
      if (!response.ok) {
        fail(response.status === 429 ? "QUOTA_EXCEEDED" : "SERVICE_UNAVAILABLE", {
          status: response.status,
          retryAfter: response.headers.get("retry-after") || "",
        });
      }
      return validateEnvelope(payload, id);
    } catch (error) {
      if (error instanceof ManagedPublicCatalogError) throw error;
      if (abortSource === "external") fail("REQUEST_ABORTED");
      if (abortSource === "timeout") fail("REQUEST_TIMEOUT");
      fail("NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      active -= 1;
    }
  }

  async function ready(options = {}) {
    if (!readyPromise) {
      readyPromise = (async () => {
        validateInitialize(await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "send-from-china-managed-public-sdk", version: "1.2.0" },
        }, options.signal));
        const tools = validateToolList(await request("tools/list", undefined, options.signal));
        return Object.freeze({
          endpoint: ENDPOINT,
          protocolVersion: PROTOCOL_VERSION,
          tools,
          anonymous: true,
          writes: false,
        });
      })().catch((error) => {
        readyPromise = undefined;
        throw error;
      });
    }
    return readyPromise;
  }

  async function call(tool, args, options = {}) {
    if (!["product_search", "get_product"].includes(tool)) fail("INVALID_ARGUMENT");
    if (tool === "product_search") validateSearchArguments(args);
    else validateHandleArguments(args);
    await ready(options);
    const value = await request("tools/call", { name: tool, arguments: args }, options.signal);
    return validateToolResult(value, tool);
  }

  return Object.freeze({
    ready,
    productSearch: (args, options = {}) => call("product_search", args, options),
    getProduct: (args, options = {}) => call("get_product", args, options),
    resolvePurchaseHandoff(product) {
      try {
        const url = validateUrl(product?.product_url, product?.handle);
        return Object.freeze({ kind: "product", url, requires_user: true });
      } catch {
        return null;
      }
    },
  });
}
