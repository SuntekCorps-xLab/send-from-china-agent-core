import { getProduct, searchCatalog } from "./catalog.js";

const TOOLS = [
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
];

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

export function handleMcp(payload) {
  if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return { status: 400, body: failure(payload?.id, -32600, "Invalid Request") };
  }
  if (payload.method === "initialize") {
    return {
      status: 200,
      body: result(payload.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "send-from-china-demo", version: "0.1.0-rc.4" },
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
  if (name === "search_catalog") {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 300) {
      return { status: 400, body: failure(payload.id, -32602, "Invalid params") };
    }
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
  return { status: 404, body: failure(payload.id, -32601, "Tool not found") };
}
