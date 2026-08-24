import { getProduct, listCatalog, searchCatalog } from "./catalog.js";
import { allowedOrigin, errorResponse, jsonResponse, parseLimit, parseQuery, readJson, requestId } from "./http.js";
import { handleMcp } from "./mcp.js";
import { createQuote, QuoteError } from "./quote.js";
import { getSnapshotMeta } from "./snapshot.js";
import { consumeTenantQuota, resolveTenant, TenantError } from "./tenant.js";

function lastUserQuery(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) return null;
  const last = [...messages].reverse().find((message) => message?.role === "user");
  return typeof last?.content === "string" ? parseQuery(last.content) : null;
}

function tenantFor(request, env) {
  const tenant = resolveTenant(request.headers.get("Authorization") || "", env);
  consumeTenantQuota(tenant);
  return tenant;
}

function tenantErrorResponse(error, id, corsHeaders) {
  const headers = { ...corsHeaders };
  if (error.retry_after) headers["Retry-After"] = String(error.retry_after);
  return errorResponse(error.code, error.status, id, headers);
}

async function route(request, env, id, corsHeaders) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method === "GET" && url.pathname === "/health") {
    const meta = getSnapshotMeta();
    return jsonResponse({
      ok: true, mode: "published_snapshot_gateway", writes_enabled: false,
      tenant_auth_configured: Boolean(String(env.TENANT_KEYS || "")),
      catalog_generated_at: meta.generated_at, catalog_valid_until: meta.valid_until,
      catalog_stale: meta.stale,
      catalog_max_staleness_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(meta.generated_at)) / 1000)),
      product_count: meta.product_count,
    }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname === "/.well-known/send-from-china.json") {
    return jsonResponse({
      schema_version: 1,
      service: "send-from-china-agent-core",
      version: "1.0.0",
      mode: "self_hosted_reference",
      mcp: { path: "/mcp", discovery_auth_required: false, tool_auth: "bearer_tenant_key" },
      registration: { self_service: false, key_provisioning: "deployment_operator" },
      capabilities: {
        catalog_search: true,
        product_detail: true,
        catalog_estimate: true,
        shipping_rates: false,
        illustrative_sourcing_preview: true,
        cart: false,
        checkout: false,
        order: false,
        payment: false,
      },
    }, 200, id, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/mcp") {
    const parsed = await readJson(request);
    if (parsed.error) return errorResponse(parsed.error, parsed.error === "PAYLOAD_TOO_LARGE" ? 413 : 400, id, corsHeaders);
    const response = await handleMcp(parsed.value, { authorization: request.headers.get("Authorization") || "", env });
    return jsonResponse(response.body, response.status, id, corsHeaders);
  }

  const tenant = tenantFor(request, env);
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    if (!tenant.allow_full_enumeration) return errorResponse("ENUMERATION_NOT_ALLOWED", 403, id, corsHeaders);
    const limit = parseLimit(url.searchParams.get("limit"), Math.min(20, tenant.max_page_size), tenant.max_page_size);
    if (limit === null) return errorResponse("INVALID_LIMIT", 400, id, corsHeaders);
    const result = listCatalog({ limit, cursor: url.searchParams.get("cursor") || "" }, tenant);
    if (result.error) return errorResponse(result.error, 400, id, corsHeaders);
    return jsonResponse({ ...result, mode: "published_snapshot" }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = parseQuery(url.searchParams.get("q"));
    const limit = parseLimit(url.searchParams.get("limit"), Math.min(20, tenant.max_page_size), tenant.max_page_size);
    if (!query) return errorResponse("INVALID_QUERY", 400, id, corsHeaders);
    if (limit === null) return errorResponse("INVALID_LIMIT", 400, id, corsHeaders);
    const result = searchCatalog(query, { limit, cursor: url.searchParams.get("cursor") || "" }, tenant);
    if (result.error) return errorResponse(result.error, 400, id, corsHeaders);
    return jsonResponse({ ...result, mode: "published_snapshot" }, 200, id, corsHeaders);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/products/")) {
    const slug = decodeURIComponent(url.pathname.slice("/api/products/".length));
    if (!/^[a-z0-9-]{1,100}$/.test(slug)) return errorResponse("INVALID_SLUG", 400, id, corsHeaders);
    const product = getProduct(slug, tenant);
    return product ? jsonResponse({ product, mode: "published_snapshot" }, 200, id, corsHeaders) : errorResponse("PRODUCT_NOT_FOUND", 404, id, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/quote") {
    const parsed = await readJson(request);
    if (parsed.error) return errorResponse(parsed.error, parsed.error === "PAYLOAD_TOO_LARGE" ? 413 : 400, id, corsHeaders);
    return jsonResponse(createQuote(parsed.value, tenant), 200, id, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const parsed = await readJson(request);
    if (parsed.error) return errorResponse(parsed.error, parsed.error === "PAYLOAD_TOO_LARGE" ? 413 : 400, id, corsHeaders);
    const query = lastUserQuery(parsed.value?.messages);
    if (!query) return errorResponse("INVALID_MESSAGES", 400, id, corsHeaders);
    const criteria = parsed.value?.criteria && typeof parsed.value.criteria === "object" && !Array.isArray(parsed.value.criteria)
      ? parsed.value.criteria
      : {};
    const matches = searchCatalog(query, { limit: Math.min(3, tenant.max_page_size), criteria }, tenant);
    return jsonResponse({
      reply: matches.total ? "I found tenant-visible catalog matches. Refine the request to narrow the results." : "No published catalog match was found. Refine the request or use the explicit preview workflow.",
      products: matches.items,
      criteria: matches.criteria,
      criteria_evaluation: matches.criteria_evaluation,
      dynamic_request_recommended: matches.total === 0 && !matches.next_cursor,
      next_actions: ["Refine the product", "Set a budget", "Change the use case"],
      mode: "deterministic_fixture",
    }, 200, id, corsHeaders);
  }
  return errorResponse("NOT_FOUND", 404, id, corsHeaders);
}

export default {
  async fetch(request, env = {}) {
    const id = requestId();
    const cors = allowedOrigin(request, env);
    if (!cors.allowed) return errorResponse("ORIGIN_NOT_ALLOWED", 403, id);
    try { return await route(request, env, id, cors.headers); }
    catch (error) {
      if (error instanceof TenantError) return tenantErrorResponse(error, id, cors.headers);
      if (error instanceof QuoteError) return errorResponse(error.code, error.status, id, cors.headers);
      return errorResponse("INTERNAL_ERROR", 500, id, cors.headers);
    }
  },
};
