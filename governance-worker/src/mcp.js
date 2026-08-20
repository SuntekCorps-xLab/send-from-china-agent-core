import { getProduct, searchCatalog } from "./catalog.js";
import {
  createDemoSourcingTask,
  DemoSourcingError,
  getDemoAgentAccess,
  getDemoSourcingTask,
  listDemoSourcingResults,
} from "./sourcing.js";

const CRITERIA_PROPERTIES = {
  category: { type: "string", maxLength: 100 },
  use_case: { type: "string", maxLength: 160 },
  ship_to: { type: "string", minLength: 2, maxLength: 2 },
  price_max: { type: ["number", "null"], minimum: 0 },
  materials: { type: "array", items: { type: "string" }, maxItems: 20 },
  must_have: { type: "array", items: { type: "string" }, maxItems: 20 },
  exclude: { type: "array", items: { type: "string" }, maxItems: 20 },
  keywords: { type: "array", items: { type: "string" }, maxItems: 20 },
};

const TOOLS = [
  {
    name: "product_search",
    description: "Criteria-first bounded search over the synthetic catalog. A terminal no_match recommends the explicit sourcing handoff.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        criteria: { type: "object", properties: CRITERIA_PROPERTIES, additionalProperties: false },
        operation: { type: "string", enum: ["search", "confirm_search", "more"], default: "search" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_catalog",
    description: "Search the synthetic, read-only demonstration catalog.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description: "Read one synthetic demonstration product by handle.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "get_agent_access",
    description: "Verify the local demo agent token and return its explicit catalog and sourcing scopes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_sourcing_task",
    description: "Create an idempotent, non-billable synthetic preview task after a terminal catalog miss. No supplier, product, cart, checkout, order, payment, or publication write occurs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 3, maxLength: 300 },
        criteria: { type: "object", properties: CRITERIA_PROPERTIES, additionalProperties: false },
        plan_id: { type: "string", enum: ["preview"] },
        idempotency_key: { type: "string", minLength: 12, maxLength: 128 },
      },
      required: ["query", "criteria", "plan_id", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sourcing_task",
    description: "Read one agent-owned synthetic sourcing task and its demonstrated lifecycle.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", minLength: 1, maxLength: 180 } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sourcing_results",
    description: "Page through up to three reviewed synthetic preview results. Every result remains explicitly non-purchasable.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1, maxLength: 180 },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function validQuery(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 300;
}

function contextFor(options = {}) {
  return { authorization: options.authorization || "", env: options.env || {} };
}

export async function handleMcp(payload, options = {}) {
  if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return { status: 400, body: failure(payload?.id, -32600, "Invalid Request") };
  }
  if (payload.method === "initialize") {
    return {
      status: 200,
      body: result(payload.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "send-from-china-demo", version: "0.2.0-rc.1" },
        instructions: "Search the bounded synthetic catalog first. Use synthetic sourcing only after a terminal no_match. All preview results are non-purchasable and all transactional permissions are false.",
      }),
    };
  }
  if (payload.method === "tools/list") {
    return { status: 200, body: result(payload.id, { tools: TOOLS }) };
  }
  if (payload.method !== "tools/call") {
    return { status: 404, body: failure(payload.id, -32601, "Method not found") };
  }

  const name = payload.params?.name;
  const args = payload.params?.arguments || {};
  const context = contextFor(options);
  try {
    if (name === "product_search") {
      if (!validQuery(args.query)) return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      if (args.operation && !["search", "confirm_search", "more"].includes(args.operation)) {
        return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      }
      const limit = Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50 ? args.limit : 20;
      const search = searchCatalog(args.query, { limit, cursor: args.cursor || "" });
      if (search.error) return { status: 400, body: failure(payload.id, -32602, search.error) };
      const terminal = !search.next_cursor;
      const value = {
        search_id: `search_demo_${String(args.query).length}_${search.total}`,
        status: search.total ? "catalog_match" : (terminal ? "no_match" : "searching"),
        operation: args.operation || "search",
        criteria: args.criteria || {},
        products: search.items,
        count: search.items.length,
        has_more: Boolean(search.next_cursor),
        next_cursor: search.next_cursor,
        exhaustive: terminal,
        search_scope_exhausted: terminal,
        dynamic_request_recommended: search.total === 0 && terminal,
        mode: "synthetic_demo",
      };
      return { status: 200, body: result(payload.id, toolResult(value)) };
    }
    if (name === "search_catalog") {
      if (!validQuery(args.query)) return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      const limit = Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50 ? args.limit : 20;
      return { status: 200, body: result(payload.id, toolResult(searchCatalog(args.query, { limit }))) };
    }
    if (name === "get_product") {
      if (typeof args.handle !== "string" || !args.handle || args.handle.length > 100) {
        return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
      }
      const product = getProduct(args.handle);
      return product
        ? { status: 200, body: result(payload.id, toolResult(product)) }
        : { status: 404, body: failure(payload.id, -32004, "Product not found") };
    }
    if (name === "get_agent_access") {
      return { status: 200, body: result(payload.id, toolResult(getDemoAgentAccess(context))) };
    }
    if (name === "create_sourcing_task") {
      return { status: 200, body: result(payload.id, toolResult(createDemoSourcingTask(args, context))) };
    }
    if (name === "get_sourcing_task") {
      return { status: 200, body: result(payload.id, toolResult(getDemoSourcingTask(args.task_id, context))) };
    }
    if (name === "list_sourcing_results") {
      const limit = args.limit === undefined ? 50 : args.limit;
      return {
        status: 200,
        body: result(payload.id, toolResult(listDemoSourcingResults(
          args.task_id,
          { cursor: args.cursor || "", limit },
          context,
        ))),
      };
    }
  } catch (error) {
    if (error instanceof DemoSourcingError) {
      return { status: 200, body: result(payload.id, toolResult({ error: error.code, message: error.message }, true)) };
    }
    throw error;
  }
  return { status: 404, body: failure(payload.id, -32601, "Tool not found") };
}
