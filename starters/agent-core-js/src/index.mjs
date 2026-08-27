function safeBaseUrl(value) {
  const url = new URL(String(value || "http://127.0.0.1:8787"));
  const loopback = [["127", "0", "0", "1"].join("."), "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash) {
    throw new TypeError("This starter accepts only a loopback HTTP sandbox URL.");
  }
  return url.href.replace(/\/$/u, "");
}

export async function searchSyntheticCatalog(query, options = {}) {
  const value = String(query || "").trim();
  if (!value) throw new TypeError("query is required");
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const base = safeBaseUrl(options.baseUrl || process.env.AGENT_CORE_SANDBOX_URL);
  const url = new URL(`${base}/sandbox/api/search`);
  url.searchParams.set("q", value);
  url.searchParams.set("limit", "3");
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.code || `HTTP_${response.status}`);
  if (payload.mode !== "synthetic_local_sandbox" || payload.purchasable !== false) {
    throw new Error("The endpoint did not prove the synthetic, non-purchasable boundary.");
  }
  return payload;
}

const invoked = process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).pathname === import.meta.url.replace("file://", "");
if (invoked) {
  const result = await searchSyntheticCatalog(process.argv.slice(2).join(" ") || "desk organizer");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
