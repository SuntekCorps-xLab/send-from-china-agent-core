import { listCatalog, searchCatalog } from "./catalog.js";

const TASK_STATES = Object.freeze(["QUEUED", "SOURCING", "GOVERNING", "RESULTS_READY"]);
const TASKS = new Map();
const IDEMPOTENCY = new Map();

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

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authenticatedAgent(authorization, env = {}) {
  const configured = String(env.DEMO_AGENT_TOKEN || "");
  if (configured.length < 16) {
    throw new DemoSourcingError(
      "SOURCING_DEMO_DISABLED",
      "Set a local DEMO_AGENT_TOKEN with at least 16 characters before testing synthetic sourcing.",
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  if (!match || !constantTimeEqual(match[1], configured)) {
    throw new DemoSourcingError("INVALID_AGENT_TOKEN", "A valid local demo agent token is required.");
  }
  return { id: `demo-agent-${stableHash(configured)}`, label: "Local synthetic sourcing agent" };
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, 20);
}

function normalizeCriteria(value = {}) {
  const priceMax = Number(value.price_max);
  return {
    category: cleanText(value.category, 100),
    use_case: cleanText(value.use_case, 160),
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
  const criteria = normalizeCriteria(value.criteria);
  if (query.length < 3) throw new DemoSourcingError("INVALID_QUERY", "A specific product request is required.");
  if (value.plan_id !== "preview") {
    throw new DemoSourcingError("DEMO_PREVIEW_ONLY", "The public demo supports only the non-billable preview plan.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/.test(idempotencyKey)) {
    throw new DemoSourcingError("INVALID_IDEMPOTENCY_KEY", "Use a stable idempotency key between 12 and 128 characters.");
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
  return { query, criteria, plan_id: "preview", idempotency_key: idempotencyKey };
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    status_history: [...task.status_history],
    query: task.query,
    criteria: { ...task.criteria },
    plan_id: task.plan_id,
    human_result_limit: 3,
    result_count: task.results.length,
    published_count: 0,
    billable: false,
    durable: false,
    mode: "synthetic_demo",
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function syntheticResults(query, criteria) {
  const selected = [];
  const seen = new Set();
  for (const product of [
    ...searchCatalog(query, { limit: 3 }).items,
    ...listCatalog({ limit: 50 }).items,
  ]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    selected.push(product);
    if (selected.length === 3) break;
  }
  return selected.map((product, index) => ({
    id: `demo-result-${index + 1}-${product.id}`,
    rank: index + 1,
    title: product.title,
    category: product.category,
    summary: product.description,
    why: `Synthetic reviewed fixture for ${criteria.ship_to}; verify all commercial facts in a real deployment.`,
    source: "synthetic_demo",
    governance_status: "REVIEWED_PREVIEW",
    availability: "demo_only",
    available: false,
    purchasable: false,
    product_url: null,
    add_to_cart_url: null,
  }));
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
    results: syntheticResults(request.query, request.criteria),
    created_at: now,
    updated_at: now,
  };
  TASKS.set(task.id, task);
  IDEMPOTENCY.set(idempotencyScope, task.id);
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
  };
}

export function resetDemoSourcingState() {
  TASKS.clear();
  IDEMPOTENCY.clear();
}
