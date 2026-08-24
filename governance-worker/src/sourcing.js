import { listCatalog, searchCatalog } from "./catalog.js";
import { resolveTenant, TenantError } from "./tenant.js";

const TASK_STATES = Object.freeze(["QUEUED", "SOURCING", "GOVERNING", "RESULTS_READY"]);
const TASKS = new Map();
const IDEMPOTENCY = new Map();
const SEARCH_PROOFS = new Map();
const SEARCH_PROOF_TTL_MS = 15 * 60 * 1000;

export class DemoSourcingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DemoSourcingError";
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  const output = String(value || "").trim().replace(/\s+/g, " ");
  return output.length <= maxLength ? output : "";
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function authenticatedAgent(authorization, env = {}) {
  try {
    const tenant = resolveTenant(authorization, env);
    return {
      id: `tenant-agent-${stableHash(tenant.tenant_id)}`,
      label: "Tenant-scoped preview agent",
      tenant,
    };
  } catch (error) {
    if (error instanceof TenantError) throw new DemoSourcingError(error.code, "A valid tenant credential is required.");
    throw error;
  }
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 80).toLowerCase()).filter(Boolean))].slice(0, 20);
}

function normalizeCriteria(value = {}) {
  const priceMax = value.price_max === undefined || value.price_max === null ? null : Number(value.price_max);
  return {
    category: cleanText(value.category, 100).toLowerCase(),
    use_case: cleanText(value.use_case, 160).toLowerCase(),
    ship_to: cleanText(value.ship_to, 2).toUpperCase(),
    price_max: Number.isFinite(priceMax) && priceMax >= 0 ? priceMax : null,
    materials: cleanList(value.materials),
    must_have: cleanList(value.must_have),
    exclude: cleanList(value.exclude),
    keywords: cleanList(value.keywords),
  };
}

function normalizeCreateRequest(value = {}) {
  const query = cleanText(value.query, 300);
  const idempotencyKey = cleanText(value.idempotency_key, 128);
  const searchId = cleanText(value.search_id, 180);
  const criteria = normalizeCriteria(value.criteria);
  if (query.length < 3) throw new DemoSourcingError("INVALID_QUERY", "A specific product request is required.");
  if (value.plan_id !== "preview") {
    throw new DemoSourcingError("DEMO_PREVIEW_ONLY", "The public demo supports only the non-billable preview plan.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/.test(idempotencyKey)) {
    throw new DemoSourcingError("INVALID_IDEMPOTENCY_KEY", "Use a stable idempotency key between 12 and 128 characters.");
  }
  if (!/^search_demo_[A-Za-z0-9-]{20,}$/.test(searchId)) {
    throw new DemoSourcingError("SEARCH_PROOF_REQUIRED", "Use the search_id from a terminal confirm_search response.");
  }
  if (value.confirmed !== true) {
    throw new DemoSourcingError("USER_CONFIRMATION_REQUIRED", "Set confirmed=true only after explicit user confirmation.");
  }
  if (!/^[A-Z]{2}$/.test(criteria.ship_to)) {
    throw new DemoSourcingError("SOURCING_DESTINATION_REQUIRED", "criteria.ship_to must be an ISO alpha-2 destination.");
  }
  const hasStructuredIntent = Boolean(
    criteria.category
    || criteria.use_case
    || criteria.materials.length
    || criteria.must_have.length
    || criteria["keywords"].length,
  );
  if (!hasStructuredIntent) {
    throw new DemoSourcingError("SOURCING_INTENT_REQUIRED", "Provide at least one structured product criterion.");
  }
  return { query, criteria, search_id: searchId, confirmed: true, plan_id: "preview", idempotency_key: idempotencyKey };
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    status_history: [...task.status_history],
    query: task.query,
    criteria: { ...task.criteria },
    search_id: task.search_id,
    confirmed: task.confirmed,
    plan_id: task.plan_id,
    human_result_limit: 3,
    result_count: task.results.length,
    published_count: 0,
    billable: false,
    durable: false,
    mode: "synthetic_demo",
    illustrative_only: true,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function syntheticResults(query, criteria, tenant) {
  const selected = [];
  const seen = new Set();
  for (const product of [
    ...searchCatalog(query, { limit: 3 }, tenant).items,
    ...listCatalog({ limit: tenant.max_page_size }, tenant).items,
  ]) {
    if (seen.has(product.public_id)) continue;
    seen.add(product.public_id);
    selected.push(product);
    if (selected.length === 3) break;
  }
  return selected.map((product, index) => ({
    id: `demo-result-${index + 1}-${product.public_id}`,
    rank: index + 1,
    title: product.title,
    category: product.category,
    summary: product.description,
    why: `Synthetic reviewed fixture for ${criteria.ship_to}; verify all commercial facts in a real deployment.`,
    source: product.source,
    governance_status: "REVIEWED_PREVIEW",
    match_status: "illustrative_only",
    criteria_satisfied: false,
    availability: "demo_only",
    available: false,
    purchasable: false,
    product_url: null,
    add_to_cart_url: null,
  }));
}

function proofAgentId(tenant) {
  return `tenant-agent-${stableHash(tenant.tenant_id)}`;
}

function cleanupSearchProofs(now = Date.now()) {
  for (const [id, proof] of SEARCH_PROOFS) {
    if (proof.expires_at_ms <= now) SEARCH_PROOFS.delete(id);
  }
}

export function recordDemoCatalogMiss({ query, criteria, operation, exhaustive, dynamic_request_recommended }, tenant) {
  if (operation !== "confirm_search" || exhaustive !== true || dynamic_request_recommended !== true) return null;
  cleanupSearchProofs();
  const id = `search_demo_${crypto.randomUUID()}`;
  SEARCH_PROOFS.set(id, {
    id,
    agent_id: proofAgentId(tenant),
    query: cleanText(query, 300),
    criteria: normalizeCriteria(criteria),
    expires_at_ms: Date.now() + SEARCH_PROOF_TTL_MS,
    task_id: null,
  });
  return id;
}

function requireSearchProof(request, agent) {
  cleanupSearchProofs();
  const proof = SEARCH_PROOFS.get(request.search_id);
  if (!proof || proof.agent_id !== agent.id) {
    throw new DemoSourcingError("SEARCH_PROOF_NOT_FOUND", "The catalog miss proof is missing, expired, or belongs to another tenant.");
  }
  if (proof.query !== request.query || JSON.stringify(proof.criteria) !== JSON.stringify(request.criteria)) {
    throw new DemoSourcingError("SEARCH_PROOF_MISMATCH", "The sourcing request must reuse the confirmed search query and criteria exactly.");
  }
  return proof;
}

function taskForAgent(taskId, agent) {
  const task = TASKS.get(cleanText(taskId, 180));
  if (!task || task.agent_id !== agent.id) {
    throw new DemoSourcingError("SOURCING_TASK_NOT_FOUND", "No synthetic sourcing task exists for this agent.");
  }
  return task;
}

function dailyPreviewUsage(agentId, now) {
  const day = now.slice(0, 10);
  return [...TASKS.values()].filter((task) => task.agent_id === agentId && task.created_at.startsWith(day)).length;
}

export function getDemoAgentAccess({ authorization, env = {} }) {
  const agent = authenticatedAgent(authorization, env);
  const now = new Date().toISOString();
  const dailyLimit = 3;
  const usedToday = dailyPreviewUsage(agent.id, now);
  return {
    authenticated: true,
    agent: {
      id: agent.id,
      label: agent.label,
      tenant_id: agent.tenant.tenant_id,
      scopes: ["catalog:read", "sourcing:read", "sourcing:write"],
    },
    preview_access: {
      daily_limit: dailyLimit,
      used_today: usedToday,
      remaining_today: Math.max(0, dailyLimit - usedToday),
      billable: false,
    },
    transactional_permissions: { cart: false, checkout: false, order: false, payment: false },
    mode: "synthetic_demo",
  };
}

export function createDemoSourcingTask(value, { authorization, env = {} }) {
  const agent = authenticatedAgent(authorization, env);
  const request = normalizeCreateRequest(value);
  const requestHash = stableHash(JSON.stringify(request));
  const idempotencyScope = `${agent.id}:${request.idempotency_key}`;
  const existingId = IDEMPOTENCY.get(idempotencyScope);
  if (existingId) {
    const existing = TASKS.get(existingId);
    if (existing.request_hash !== requestHash) {
      throw new DemoSourcingError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to a different request.");
    }
    return { task: publicTask(existing), idempotent: true };
  }

  const proof = requireSearchProof(request, agent);
  if (proof.task_id) {
    throw new DemoSourcingError("SEARCH_PROOF_ALREADY_USED", "This confirmed catalog miss already created a preview task.");
  }

  const now = new Date().toISOString();
  if (dailyPreviewUsage(agent.id, now) >= 3) {
    throw new DemoSourcingError("FREE_PREVIEW_DAILY_LIMIT", "The local synthetic preview quota is exhausted for this UTC day.");
  }
  const task = {
    id: `task_demo_${stableHash(idempotencyScope)}`,
    agent_id: agent.id,
    request_hash: requestHash,
    ...request,
    status: "RESULTS_READY",
    status_history: [...TASK_STATES],
    results: syntheticResults(request.query, request.criteria, agent.tenant),
    created_at: now,
    updated_at: now,
  };
  TASKS.set(task.id, task);
  IDEMPOTENCY.set(idempotencyScope, task.id);
  proof.task_id = task.id;
  return { task: publicTask(task), idempotent: false };
}

export function getDemoSourcingTask(taskId, context) {
  const agent = authenticatedAgent(context.authorization, context.env);
  return { task: publicTask(taskForAgent(taskId, agent)) };
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const offset = Number.parseInt(atob(value), 10);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

export function listDemoSourcingResults(taskId, { cursor = "", limit = 50 } = {}, context) {
  const agent = authenticatedAgent(context.authorization, context.env);
  const task = taskForAgent(taskId, agent);
  const offset = decodeCursor(cursor);
  if (offset === null) throw new DemoSourcingError("INVALID_CURSOR", "The result cursor is invalid.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DemoSourcingError("INVALID_LIMIT", "The result page size must be between 1 and 100.");
  }
  const pageSize = limit;
  const results = task.results.slice(offset, offset + pageSize).map((result) => ({ ...result }));
  const nextOffset = offset + results.length;
  return {
    task_id: task.id,
    status: task.status,
    results,
    count: results.length,
    next_cursor: nextOffset < task.results.length ? btoa(String(nextOffset)).replace(/=+$/g, "") : null,
    exhaustive: nextOffset >= task.results.length,
    mode: "synthetic_demo",
    illustrative_only: true,
  };
}

export function resetDemoSourcingState() {
  TASKS.clear();
  IDEMPOTENCY.clear();
  SEARCH_PROOFS.clear();
}
