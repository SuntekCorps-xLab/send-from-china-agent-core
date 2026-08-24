const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const baseUrl = String(option("--url") || process.env.AGENT_CORE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const tenantKey = String(process.env.TENANT_KEY || "").trim();

if (!tenantKey) {
  process.stderr.write("Set TENANT_KEY before running the public smoke test.\n");
  process.exit(1);
}

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const auth = { authorization: `Bearer ${tenantKey}` };
const health = await json("/health");
requireValue(health.response.ok && health.body.ok === true, "health check failed");

const metadata = await json("/.well-known/send-from-china.json");
requireValue(metadata.body.capabilities?.shipping_rates === false, "capability metadata is missing");

const denied = await json("/api/search?q=desk");
requireValue(denied.response.status === 401, "unauthenticated search did not fail closed");

const search = await json("/api/search?q=desk&limit=1", { headers: auth });
requireValue(search.response.ok && Array.isArray(search.body.items), "authenticated search failed");

const discovery = await json("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
requireValue(discovery.response.ok && discovery.body.result?.tools?.length >= 8, "MCP discovery failed");

process.stdout.write(`${JSON.stringify({
  ok: true,
  base_url: baseUrl,
  product_count: health.body.product_count,
  authenticated_search_results: search.body.items.length,
  mcp_tools: discovery.body.result.tools.map((tool) => tool.name),
  shipping_rates: metadata.body.capabilities.shipping_rates,
}, null, 2)}\n`);
