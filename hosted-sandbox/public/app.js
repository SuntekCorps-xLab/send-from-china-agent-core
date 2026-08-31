const accessForm = document.querySelector("#access-form");
const searchForm = document.querySelector("#search-form");
const inviteInput = document.querySelector("#invite");
const queryInput = document.querySelector("#query");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const source = document.querySelector("#source");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
let inviteProof = "";

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusDot.dataset.state = state;
}

async function request(pathname, init = {}) {
  const target = new URL(pathname, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/sandbox/")) {
    throw new Error("REQUEST_BOUNDARY_REJECTED");
  }
  const headers = new Headers(init.headers || {});
  if (inviteProof) headers.set("x-sandbox-invite", inviteProof);
  const response = await fetch(target, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`HTTP_${response.status}`); }
  if (!response.ok) throw new Error(body?.error?.code || `HTTP_${response.status}`);
  return body;
}

function money(value) {
  if (!value || typeof value.amount !== "number" || typeof value.currency !== "string") return "Price unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: value.currency }).format(value.amount);
}

function renderProducts(products) {
  results.replaceChildren();
  resultCount.textContent = `${products.length} result${products.length === 1 ? "" : "s"}`;
  if (!products.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No published match was returned for this request.";
    results.append(empty);
    return;
  }
  for (const product of products) {
    const card = document.createElement("article");
    card.className = "product-card";
    const icon = document.createElement("div");
    icon.className = "product-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✦";
    const body = document.createElement("div");
    const label = document.createElement("p");
    label.className = "step";
    label.textContent = product.availableForSale ? "PUBLISHED · AVAILABLE" : "PUBLISHED · UNAVAILABLE";
    const title = document.createElement("h3");
    title.textContent = product.title;
    const description = document.createElement("p");
    description.className = "description";
    description.textContent = product.description || "No public description.";
    const meta = document.createElement("div");
    meta.className = "product-meta";
    const price = document.createElement("strong");
    price.textContent = money(product.price);
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = "Verify detail";
    detail.addEventListener("click", async () => {
      detail.disabled = true;
      try {
        const verified = await request(`/sandbox/api/products/${product.handle}`);
        setStatus(`${verified.product.title} was verified through the read-only BFF.`, "ready");
      } catch (error) {
        setStatus(`Detail unavailable: ${error.message}`, "error");
      } finally { detail.disabled = false; }
    });
    meta.append(price, detail);
    body.append(label, title, description, meta);
    card.append(icon, body);
    results.append(card);
  }
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = inviteInput.value;
  if (value.length < 20 || value.length > 256 || /\s/u.test(value)) {
    setStatus("The preview invite is not valid.", "error");
    return;
  }
  inviteProof = value;
  inviteInput.value = "";
  setStatus("Verifying the protected read-only connection…", "loading");
  try {
    const status = await request("/sandbox/status");
    if (!status.verified || status.writes !== false) throw new Error("SANDBOX_STATUS_INVALID");
    source.textContent = "Shopify published catalog";
    setStatus("Connected. Published catalog reads are ready; all writes remain disabled.", "ready");
    queryInput.focus();
  } catch (error) {
    inviteProof = "";
    source.textContent = "Not connected";
    setStatus(`Connection unavailable: ${error.message}`, "error");
  }
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!inviteProof) {
    setStatus("Connect with a preview invite before searching.", "error");
    inviteInput.focus();
    return;
  }
  const query = queryInput.value.trim();
  if (!query) return;
  setStatus("Searching allowlisted Shopify Storefront fields…", "loading");
  try {
    const response = await request("/sandbox/api/search/v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract_version: "2.0",
        product_identity: { name: "product_identity", value: query, source: "explicit", scope: "product", hardness: "hard" },
        hard_constraints: [],
        soft_context: [],
        transaction_context: [],
        limit: 12,
        cursor: null,
      }),
    });
    renderProducts(Array.isArray(response.results) ? response.results : []);
    setStatus("Search complete. Results are read-only and non-transactional.", "ready");
  } catch (error) {
    renderProducts([]);
    setStatus(`Search unavailable: ${error.message}`, "error");
  }
});
