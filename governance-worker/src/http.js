export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_QUERY_CHARS = 300;
export const MAX_PAGE_SIZE = 100;
const SEARCH_ERROR_FIELDS = new Set([
  "request", "contract_version", "product_identity", "hard_constraints", "soft_context",
  "transaction_context", "limit", "cursor", "condition",
]);
const SEARCH_ERROR_REASONS = new Set([
  "invalid_type", "missing_required", "unknown_field", "unsupported_value", "invalid_format",
  "out_of_range", "not_normalized", "cursor_mismatch", "invalid_value",
]);

function baseHeaders(requestId) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Request-Id": requestId,
  };
}

export function requestId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : "request-unavailable";
}

export function allowedOrigin(request, env = {}) {
  const origin = request.headers.get("Origin");
  if (!origin) return { allowed: true, headers: {} };
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!configured.includes(origin)) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  };
}

export function jsonResponse(body, status, id, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseHeaders(id),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function emptyResponse(status, id, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: {
      ...baseHeaders(id),
      ...extraHeaders,
    },
  });
}

export function errorResponse(code, status, id, extraHeaders = {}, details = {}) {
  const error = { code };
  if (code === "INVALID_SEARCH_CONTRACT"
    && SEARCH_ERROR_FIELDS.has(details.field)
    && SEARCH_ERROR_REASONS.has(details.reason)) {
    error.field = details.field;
    error.reason = details.reason;
  }
  return jsonResponse({ error, request_id: id }, status, id, extraHeaders);
}

export function parseLimit(value, fallback = 20, maximum = MAX_PAGE_SIZE) {
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

export function parseQuery(value) {
  const query = String(value || "").trim();
  if (!query || query.length > MAX_QUERY_CHARS) return null;
  return query;
}

export async function readJson(request) {
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { error: "PAYLOAD_TOO_LARGE" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: "PAYLOAD_TOO_LARGE" };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "INVALID_JSON" };
  }
}
