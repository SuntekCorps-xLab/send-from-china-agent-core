import { getProduct, searchCatalog } from "./catalog.js";
import { createQuote, QuoteError } from "./quote.js";
import {
  createDemoSourcingTask,
  DemoSourcingError,
  getDemoAgentAccess,
  getDemoSourcingTask,
  listDemoSourcingResults,
  recordDemoCatalogMiss,
} from "./sourcing.js";
import { consumeTenantQuota, resolveTenant, TenantError } from "./tenant.js";

const CRITERIA_PROPERTIES = {
  category: { type: "string", maxLength: 100 }, use_case: { type: "string", maxLength: 160 },
  ship_to: { type: "string", minLength: 2, maxLength: 2 }, price_max: { type: ["number", "null"], minimum: 0 },
  materials: { type: "array", items: { type: "string" }, maxItems: 20 },
  must_have: { type: "array", items: { type: "string" }, maxItems: 20 },
  exclude: { type: "array", items: { type: "string" }, maxItems: 20 },
  keywords: { type: "array", items: { type: "string" }, maxItems: 20 },
};

const TOOLS = [
  {
    name: "product_search",
    description: "Run a bounded, tenant-scoped product search and return a truthful terminal status.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 300 },
      criteria: { type: "object", properties: CRITERIA_PROPERTIES, additionalProperties: false },
      operation: { type: "string", enum: ["search", "confirm_search", "more"], default: "search" },
      limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" },
    }, required: ["query"], additionalProperties: false },
  },
  {
    name: "search_catalog",
    description: "Search the tenant-scoped published catalog without exposing unrestricted enumeration.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 300 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string" },
    }, required: ["query"], additionalProperties: false },
  },
  {
    name: "get_product",
    description: "Read one tenant-visible product by public slug.",
    inputSchema: { type: "object", properties: { slug: { type: "string", minLength: 1, maxLength: 100 } }, required: ["slug"], additionalProperties: false },
  },
  {
    name: "get_quote",
    description: "Create a short-lived catalog estimate. Shipping and tax are not included; this is not a carrier rate.",
    inputSchema: { type: "object", properties: {
      public_id: { type: "string", pattern: "^[A-Za-z0-9]{22}$" }, quantity: { type: "integer", minimum: 1, maximum: 1000 },
      ship_to: { type: "string", minLength: 2, maxLength: 2 },
    }, required: ["public_id", "quantity", "ship_to"], additionalProperties: false },
  },
  { name: "get_agent_access", description: "Return the authenticated tenant scope and explicit non-transactional permissions.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "create_sourcing_task",
    description: "Create an idempotent, non-billable fixture preview after a terminal catalog miss. No commerce write occurs.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 3, maxLength: 300 },
      criteria: { type: "object", properties: CRITERIA_PROPERTIES, additionalProperties: false },
      search_id: { type: "string", pattern: "^search_demo_[A-Za-z0-9-]{20,}$" },
      confirmed: { type: "boolean", const: true },
      plan_id: { type: "string", enum: ["preview"] }, idempotency_key: { type: "string", minLength: 12, maxLength: 128 },
    }, required: ["query", "criteria", "search_id", "confirmed", "plan_id", "idempotency_key"], additionalProperties: false },
  },
  { name: "get_sourcing_task", description: "Read one tenant-owned fixture sourcing task.", inputSchema: { type: "object", properties: { task_id: { type: "string", minLength: 1, maxLength: 180 } }, required: ["task_id"], additionalProperties: false } },
  { name: "list_sourcing_results", description: "Page through up to three non-purchasable fixture preview results.", inputSchema: { type: "object", properties: { task_id: { type: "string", minLength: 1, maxLength: 180 }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, required: ["task_id"], additionalProperties: false } },
];

function result(id, value) { return { jsonrpc: "2.0", id, result: value }; }
function failure(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function toolResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}
function toolFailure(id, code) {
  return { status: 200, body: result(id, toolResult({ error: code }, true)) };
}
function validQuery(value) { return typeof value === "string" && value.trim().length >= 1 && value.length <= 300; }

export async function handleMcp(payload, options = {}) {
  if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return { status: 400, body: failure(payload?.id, -32600, "Invalid Request") };
  }
  if (payload.method === "initialize") {
    return { status: 200, body: result(payload.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "send-from-china-agent-core", version: "1.0.0" },
      instructions: "Discover tools without a credential. Tool calls require a tenant key. get_quote returns a catalog estimate, not a shipping rate. Sourcing is an illustrative, non-purchasable preview after a confirmed terminal catalog miss.",
    }) };
  }
  if (payload.method === "tools/list") return { status: 200, body: result(payload.id, { tools: TOOLS }) };
  if (payload.method !== "tools/call") return { status: 404, body: failure(payload.id, -32601, "Method not found") };

  const name = payload.params?.name;
  const args = payload.params?.arguments || {};
  const context = { authorization: options.authorization || "", env: options.env || {} };
  let tenant;
  try {
    tenant = resolveTenant(context.authorization, context.env);
    consumeTenantQuota(tenant);
  } catch (error) {
    if (error instanceof TenantError) return toolFailure(payload.id, error.code);
    throw error;
  }

  try {
    if (name === "product_search" || name === "search_catalog") {
      if (!validQuery(args.query)) return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      if (name === "product_search" && args.operation && !["search", "confirm_search", "more"].includes(args.operation)) {
        return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      }
      const limit = args.limit === undefined ? Math.min(20, tenant.max_page_size) : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > tenant.max_page_size) {
        return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      }
      const search = searchCatalog(args.query, { limit, cursor: args.cursor || "", criteria: name === "product_search" ? args.criteria || {} : {} }, tenant);
      if (search.error) return { status: 400, body: failure(payload.id, -32602, search.error) };
      if (name === "search_catalog") return { status: 200, body: result(payload.id, toolResult(search)) };
      const terminal = !search.next_cursor;
      const dynamicRequestRecommended = search.total === 0 && terminal;
      const operation = args.operation || "search";
      const searchId = recordDemoCatalogMiss({
        query: args.query,
        criteria: search.criteria,
        operation,
        exhaustive: terminal,
        dynamic_request_recommended: dynamicRequestRecommended,
      }, tenant);
      return { status: 200, body: result(payload.id, toolResult({
        search_id: searchId,
        status: search.total ? "catalog_match" : (terminal ? "no_match" : "searching"), operation,
        criteria: search.criteria, criteria_evaluation: search.criteria_evaluation,
        products: search.items, count: search.items.length,
        has_more: Boolean(search.next_cursor), next_cursor: search.next_cursor, exhaustive: terminal,
        search_scope_exhausted: terminal, dynamic_request_recommended: dynamicRequestRecommended,
        truncated: search.truncated,
      })) };
    }
    if (name === "get_product") {
      if (typeof args.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(args.slug)) {
        return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      }
      const product = getProduct(args.slug, tenant);
      return product ? { status: 200, body: result(payload.id, toolResult(product)) } : { status: 404, body: failure(payload.id, -32004, "Product not found") };
    }
    if (name === "get_quote") return { status: 200, body: result(payload.id, toolResult(createQuote(args, tenant))) };
    if (name === "get_agent_access") return { status: 200, body: result(payload.id, toolResult(getDemoAgentAccess(context))) };
    if (name === "create_sourcing_task") return { status: 200, body: result(payload.id, toolResult(createDemoSourcingTask(args, context))) };
    if (name === "get_sourcing_task") return { status: 200, body: result(payload.id, toolResult(getDemoSourcingTask(args.task_id, context))) };
    if (name === "list_sourcing_results") {
      return { status: 200, body: result(payload.id, toolResult(listDemoSourcingResults(args.task_id, { cursor: args.cursor || "", limit: args.limit === undefined ? 50 : args.limit }, context))) };
    }
  } catch (error) {
    if (error instanceof DemoSourcingError || error instanceof QuoteError) return toolFailure(payload.id, error.code);
    throw error;
  }
  return { status: 404, body: failure(payload.id, -32601, "Tool not found") };
}

export const MCP_TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));
