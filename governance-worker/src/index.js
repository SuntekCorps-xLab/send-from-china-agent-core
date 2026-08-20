import { getProduct, listCatalog, searchCatalog } from "./catalog.js";
import {
  allowedOrigin,
  errorResponse,
  jsonResponse,
  parseLimit,
  parseQuery,
  readJson,
  requestId,
} from "./http.js";
import { handleMcp } from "./mcp.js";

function lastUserQuery(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) return null;
  const last = [...messages].reverse().find((message) => message?.role === "user");
  return typeof last?.content === "string" ? parseQuery(last.content) : null;
}

async function route(request, env, id, corsHeaders) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, mode: "synthetic_demo", writes_enabled: false }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) return errorResponse("INVALID_LIMIT", 400, id, corsHeaders);
    const result = listCatalog({ limit, cursor: url.searchParams.get("cursor") || "" });
    if (result.error) return errorResponse(result.error, 400, id, corsHeaders);
    return jsonResponse({ ...result, mode: "synthetic_demo" }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = parseQuery(url.searchParams.get("q"));
    const limit = parseLimit(url.searchParams.get("limit"));
    if (!query) return errorResponse("INVALID_QUERY", 400, id, corsHeaders);
    if (limit === null) return errorResponse("INVALID_LIMIT", 400, id, corsHeaders);
    const result = searchCatalog(query, { limit, cursor: url.searchParams.get("cursor") || "" });
    if (result.error) return errorResponse(result.error, 400, id, corsHeaders);
    return jsonResponse({ ...result, mode: "synthetic_demo" }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/products/")) {
    const handle = decodeURIComponent(url.pathname.slice("/api/products/".length));
    if (!/^[a-z0-9-]{1,100}$/.test(handle)) return errorResponse("INVALID_HANDLE", 400, id, corsHeaders);
    const product = getProduct(handle);
    return product
      ? jsonResponse({ product, mode: "synthetic_demo" }, 200, id, corsHeaders)
      : errorResponse("PRODUCT_NOT_FOUND", 404, id, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const parsed = await readJson(request);
    if (parsed.error) {
      const status = parsed.error === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      return errorResponse(parsed.error, status, id, corsHeaders);
    }
    const query = lastUserQuery(parsed.value?.messages);
    if (!query) return errorResponse("INVALID_MESSAGES", 400, id, corsHeaders);
    const matches = searchCatalog(query, { limit: 3 });
    const reply = matches.total
      ? "I found a few synthetic catalog examples. Refine the request to narrow the results."
      : "The synthetic demo catalog has no match. Connect a governed catalog before production use.";
    return jsonResponse({
      reply,
      products: matches.items,
      next_actions: ["Refine the product", "Set a budget", "Change the use case"],
      mode: "deterministic_demo",
    }, 200, id, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/mcp") {
    const parsed = await readJson(request);
    if (parsed.error) {
      const status = parsed.error === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      return errorResponse(parsed.error, status, id, corsHeaders);
    }
    const response = handleMcp(parsed.value);
    return jsonResponse(response.body, response.status, id, corsHeaders);
  }
  return errorResponse("NOT_FOUND", 404, id, corsHeaders);
}

export default {
  async fetch(request, env = {}) {
    const id = requestId();
    const cors = allowedOrigin(request, env);
    if (!cors.allowed) return errorResponse("ORIGIN_NOT_ALLOWED", 403, id);
    try {
      return await route(request, env, id, cors.headers);
    } catch {
      return errorResponse("INTERNAL_ERROR", 500, id, cors.headers);
    }
  },
};
