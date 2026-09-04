import { createSandboxBrowserClient } from "./browser-client.mjs";

const browserClient = createSandboxBrowserClient();

const searchV2Body = {
  contract_version: "2.0",
  product_identity: {
    name: "product_identity",
    value: "desk organizer",
    source: "explicit",
    scope: "product",
    hardness: "hard",
  },
  hard_constraints: [],
  soft_context: [{
    name: "use_case",
    value: "small home office",
    source: "explicit",
    scope: "session",
    hardness: "soft",
  }],
  transaction_context: [{
    name: "ship_to",
    value: "US",
    source: "explicit",
    scope: "transaction",
    hardness: "hard",
  }],
  limit: 3,
  cursor: null,
};

const sourcingQuery = "custom walnut desk organizer with cable management";
const sourcingCriteria = {
  category: "office storage",
  materials: ["walnut"],
  must_have: ["cable management"],
  price_max: 40,
  ship_to: "US",
};

const scenarios = {
  "http-search": {
    title: "Catalog search",
    protocol: "HTTP",
    method: "GET",
    path: "/sandbox/api/search?q=desk&limit=3",
    note: "Search only the five products visible to the synthetic tenant.",
    body: null,
  },
  "search-v2": {
    title: "Search Contract v2",
    protocol: "HTTP",
    method: "POST",
    path: "/sandbox/api/search/v2",
    note: "Keep product identity, soft context, and transaction context separate.",
    body: searchV2Body,
  },
  "mcp-list": {
    title: "Discover MCP tools",
    protocol: "MCP",
    method: "POST",
    path: "/sandbox/mcp",
    note: "MCP capability discovery is public in both sandbox and canonical modes.",
    body: { jsonrpc: "2.0", id: "sandbox-tools", method: "tools/list" },
  },
  "mcp-search": {
    title: "MCP product search",
    protocol: "MCP",
    method: "POST",
    path: "/sandbox/mcp",
    note: "Run the guarded product_search tool against the same scoped snapshot.",
    body: {
      jsonrpc: "2.0",
      id: "sandbox-search",
      method: "tools/call",
      params: {
        name: "product_search",
        arguments: { query: "desk organizer", criteria: { price_max: 40 }, operation: "search", limit: 3 },
      },
    },
  },
  "sourcing-preview": {
    title: "Confirmed sourcing preview",
    protocol: "MCP",
    method: "RECIPE",
    path: "/sandbox/mcp",
    note: "Prove a terminal catalog miss, ask for confirmation, then create one illustrative fixture task.",
    confirmation: true,
    body: {
      step_1: { tool: "product_search", operation: "confirm_search", query: sourcingQuery, criteria: sourcingCriteria },
      step_2: { confirmation: "required", plan_id: "preview" },
      step_3: { tools: ["create_sourcing_task", "list_sourcing_results"] },
    },
  },
};

const elements = {
  recipes: [...document.querySelectorAll("[data-scenario]")],
  filters: [...document.querySelectorAll("[data-protocol]")],
  requestTitle: document.querySelector("[data-request-title]"),
  requestProtocol: document.querySelector("[data-request-protocol]"),
  requestNote: document.querySelector("[data-request-note]"),
  method: document.querySelector("[data-method]"),
  path: document.querySelector("[data-path]"),
  requestCode: document.querySelector("[data-request-code]"),
  confirmation: document.querySelector("[data-confirmation]"),
  confirmCheckbox: document.querySelector("[data-confirm-checkbox]"),
  run: document.querySelector("[data-run]"),
  copy: document.querySelector("[data-copy]"),
  copyStatus: document.querySelector("[data-copy-status]"),
  responseStatus: document.querySelector("[data-response-status]"),
  responseSummary: document.querySelector("[data-response-summary]"),
  responseCode: document.querySelector("[data-response-code]"),
  tiles: document.querySelector("[data-result-cards]"),
  runtimeTitle: document.querySelector("[data-runtime-title]"),
  productCount: document.querySelector("[data-product-count]"),
};

let selected = "http-search";
let runtimeMode = "synthetic_local_sandbox";

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function requestText(scenario) {
  return scenario.body ? pretty(scenario.body) : "No request body";
}

function selectScenario(name) {
  selected = name;
  const scenario = scenarios[name];
  for (const recipe of elements.recipes) recipe.classList.toggle("active", recipe.dataset.scenario === name);
  elements.requestTitle.textContent = scenario.title;
  elements.requestProtocol.textContent = scenario.protocol;
  elements.requestNote.textContent = scenario.note;
  elements.method.textContent = scenario.method;
  elements.path.textContent = scenario.path;
  elements.requestCode.textContent = requestText(scenario);
  elements.confirmation.hidden = !scenario.confirmation;
  elements.confirmCheckbox.checked = false;
  elements.run.firstChild.textContent = scenario.confirmation ? "Confirm and run preview " : "Run request ";
  elements.copyStatus.textContent = "";
}

function filterRecipes(protocol) {
  for (const filter of elements.filters) filter.classList.toggle("active", filter.dataset.protocol === protocol);
  for (const recipe of elements.recipes) {
    const unavailableInLive = runtimeMode === "shopify_read_only" && recipe.dataset.scenario !== "search-v2";
    recipe.hidden = unavailableInLive || (protocol !== "all" && recipe.dataset.kind !== protocol);
  }
  const current = elements.recipes.find((recipe) => recipe.dataset.scenario === selected);
  if (current?.hidden) {
    const firstVisible = elements.recipes.find((recipe) => !recipe.hidden);
    if (firstVisible) selectScenario(firstVisible.dataset.scenario);
  }
}

async function requestJson(path, init = {}) {
  return browserClient.requestJson(path, init);
}

async function mcpCall(id, name, args) {
  const payload = await requestJson("/sandbox/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (payload?.result?.isError) throw new Error(payload.result.structuredContent?.error || "MCP_TOOL_ERROR");
  return payload;
}

async function runSourcingRecipe() {
  const search = await mcpCall("sandbox-confirmed-search", "product_search", {
    query: sourcingQuery,
    criteria: sourcingCriteria,
    operation: "confirm_search",
    limit: 5,
  });
  const searchResult = search.result?.structuredContent;
  if (searchResult?.status !== "no_match" || !searchResult?.search_scope_exhausted || !searchResult?.search_id) {
    throw new Error("TERMINAL_SEARCH_PROOF_NOT_RETURNED");
  }
  const created = await mcpCall("sandbox-create-preview", "create_sourcing_task", {
    query: sourcingQuery,
    criteria: sourcingCriteria,
    search_id: searchResult.search_id,
    confirmed: true,
    plan_id: "preview",
    idempotency_key: `sandbox-preview:${crypto.randomUUID()}`,
  });
  const task = created.result?.structuredContent?.task;
  const results = await mcpCall("sandbox-preview-results", "list_sourcing_results", {
    task_id: task.id,
    limit: 3,
  });
  return {
    recipe: "terminal miss → explicit confirmation → illustrative preview",
    search: searchResult,
    created: created.result.structuredContent,
    results: results.result.structuredContent,
  };
}

async function executeScenario(scenario) {
  if (scenario.confirmation) return runSourcingRecipe();
  const init = { method: scenario.method, headers: {} };
  if (scenario.body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(scenario.body);
  }
  return requestJson(scenario.path, init);
}

function productsFromResponse(name, payload) {
  if (name === "http-search") return payload.items || [];
  if (name === "search-v2") return payload.results || [];
  if (name === "mcp-search") return payload.result?.structuredContent?.products || [];
  if (name === "sourcing-preview") return payload.results?.results || [];
  return [];
}

function categoryIcon(product) {
  const value = `${product.category || ""} ${product.title || ""}`.toLowerCase();
  if (value.includes("office") || value.includes("desk")) return "🗂️";
  if (value.includes("garden")) return "🌱";
  if (value.includes("toy")) return "🧩";
  if (value.includes("travel")) return "🧳";
  return "📦";
}

function renderCards(products) {
  elements.tiles.replaceChildren();
  elements.tiles.hidden = products.length === 0;
  for (const product of products.slice(0, 4)) {
    const card = document.createElement("article");
    card.className = "result-card";
    const icon = document.createElement("span");
    icon.textContent = categoryIcon(product);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = product.title || "Illustrative result";
    const detail = document.createElement("small");
    const amount = product.price?.amount;
    detail.textContent = product.illustrative_only || product.match_status === "illustrative_only"
      ? "Illustrative · not purchasable"
      : `${product.category || "Public fixture"}${amount === undefined ? "" : ` · $${amount}`}`;
    copy.append(title, detail);
    card.append(icon, copy);
    elements.tiles.append(card);
  }
}

function responseHeadline(name, payload, products) {
  if (name === "mcp-list") return `${payload.result?.tools?.length || 0} tools discovered`;
  if (name === "sourcing-preview") return `${products.length} illustrative results · no purchase URL`;
  if (name === "search-v2") return `${products.length} public results · contract ${payload.contract_version}`;
  return `${products.length} tenant-visible result${products.length === 1 ? "" : "s"}`;
}

function setResponseState(kind, label) {
  elements.responseStatus.className = `response-status ${kind}`;
  elements.responseStatus.textContent = label;
}

async function runSelected() {
  const scenario = scenarios[selected];
  if (scenario.confirmation && !elements.confirmCheckbox.checked) {
    setResponseState("error", "Confirmation needed");
    elements.responseSummary.firstElementChild.textContent = "Confirm the illustrative-only boundary first.";
    return;
  }
  elements.run.disabled = true;
  setResponseState("running", "Running");
  elements.responseSummary.firstElementChild.textContent = "Calling the local Worker…";
  try {
    const payload = await executeScenario(scenario);
    const products = productsFromResponse(selected, payload);
    renderCards(products);
    elements.responseCode.textContent = pretty(payload);
    elements.responseSummary.firstElementChild.textContent = responseHeadline(selected, payload, products);
    elements.responseSummary.lastElementChild.textContent = runtimeMode === "shopify_read_only"
      ? "Returned from the verified Storefront query as read-only and non-transactional."
      : "Evaluated by the real Worker, then conservatively projected as illustrative and non-purchasable.";
    setResponseState("success", "200 · Success");
  } catch (error) {
    renderCards([]);
    elements.responseCode.textContent = pretty({ error: { code: String(error?.message || "SANDBOX_REQUEST_FAILED") } });
    elements.responseSummary.firstElementChild.textContent = "The request failed closed.";
    elements.responseSummary.lastElementChild.textContent = "Inspect the explicit error code, adjust the request, and try again.";
    setResponseState("error", "Failed closed");
  } finally {
    elements.run.disabled = false;
  }
}

function localCurl(scenario) {
  const url = `${location.origin}${scenario.path}`;
  if (!scenario.body) return `curl "${url}"`;
  if (scenario.confirmation) {
    return `# Run the guarded multi-step recipe in the UI, or connect an MCP client to:\n${location.origin}/sandbox/mcp`;
  }
  return `curl -X ${scenario.method} "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(scenario.body)}'`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function copySelected() {
  try {
    await copyText(localCurl(scenarios[selected]));
    elements.copyStatus.textContent = runtimeMode === "shopify_read_only"
      ? "Copied a local read-only sandbox call."
      : "Copied a local, zero-account call.";
  } catch {
    elements.copyStatus.textContent = "Copy was unavailable; select the request text manually.";
  }
}

async function loadRuntime() {
  try {
    const status = await browserClient.getStatus();
    if (!status.verified || status.credential_exposed !== false || status.writes !== false) {
      throw new Error("SANDBOX_BOUNDARY_UNAVAILABLE");
    }
    runtimeMode = status.mode;
    if (status.mode === "shopify_read_only") {
      for (const filter of elements.filters) filter.hidden = filter.dataset.protocol === "mcp";
      for (const recipe of elements.recipes) recipe.hidden = recipe.dataset.scenario !== "search-v2";
      selectScenario("search-v2");
      elements.runtimeTitle.textContent = "Verified Shopify read-only catalog";
      elements.productCount.textContent = "Published products only";
      return;
    }
    const health = await requestJson("/sandbox/health");
    elements.runtimeTitle.textContent = "Guarded synthetic fixture ready";
    elements.productCount.textContent = `${health.product_count} products`;
  } catch {
    elements.runtimeTitle.textContent = "Runtime check failed";
    elements.productCount.textContent = "Unavailable";
  }
}

for (const recipe of elements.recipes) recipe.addEventListener("click", () => selectScenario(recipe.dataset.scenario));
for (const filter of elements.filters) filter.addEventListener("click", () => filterRecipes(filter.dataset.protocol));
elements.run.addEventListener("click", runSelected);
elements.copy.addEventListener("click", copySelected);

selectScenario(selected);
loadRuntime();
