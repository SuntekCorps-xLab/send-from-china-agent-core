const defaultBaseUrl = "http://127.0.0.1:8790";

function safeSandboxBase(value) {
  const url = new URL(String(value || defaultBaseUrl));
  const loopback = [["127", "0", "0", "1"].join("."), "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash) {
    throw new TypeError("The synthetic recipe accepts only a loopback HTTP sandbox URL.");
  }
  return url.href.replace(/\/$/u, "");
}

export async function runSearchV2({
  baseUrl = process.env.AGENT_CORE_SANDBOX_URL || defaultBaseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const response = await fetchImpl(`${safeSandboxBase(baseUrl)}/sandbox/api/search/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_version: "2.0",
      product_identity: {
        name: "product_identity",
        value: "desk organizer",
        source: "explicit",
        scope: "product",
        hardness: "hard",
      },
      hard_constraints: [{
        name: "price_max",
        value: 40,
        source: "explicit",
        scope: "product",
        hardness: "hard",
      }],
      soft_context: [],
      transaction_context: [{
        name: "ship_to",
        value: "US",
        source: "explicit",
        scope: "transaction",
        hardness: "hard",
      }],
      limit: 3,
      cursor: null,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.code || `HTTP_${response.status}`);
  return payload;
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).pathname === import.meta.url.replace("file://", "")) {
  process.stdout.write(`${JSON.stringify(await runSearchV2(), null, 2)}\n`);
}
