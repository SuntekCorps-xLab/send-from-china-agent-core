import { createSendFromChinaClient } from "../sdk/src/index.js";

const baseUrl = process.env.SEND_FROM_CHINA_BASE_URL;
const token = process.env.SEND_FROM_CHINA_AGENT_TOKEN;
if (!baseUrl || !token) {
  console.error("Set SEND_FROM_CHINA_BASE_URL and SEND_FROM_CHINA_AGENT_TOKEN.");
  process.exitCode = 1;
} else {
  const client = createSendFromChinaClient({
    baseUrl, token,
    commerceOrigins: [process.env.SEND_FROM_CHINA_STOREFRONT_ORIGIN].filter(Boolean),
  });
  const [service, tools, access] = await Promise.all([
    client.getCapabilities(), client.listTools(), client.getAgentAccess(),
  ]);
  const search = await client.productSearch({
    query: process.argv.slice(2).join(" ") || "compact foldable laptop desk",
    criteria: { ship_to: "US" }, operation: "search", limit: 20,
  });
  console.log(JSON.stringify({
    service: { mode: service.mode, capabilities: service.capabilities },
    tools: tools.map((tool) => tool.name), access, search,
  }, null, 2));
  console.log("This read-only example never creates a sourcing task or commerce write.");
}
