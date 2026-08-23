import { getActiveSnapshot } from "./snapshot.js";

const DAILY_USAGE = new Map();

export class TenantError extends Error {
  constructor(code, status = 401, retryAfter = null) {
    super("Tenant authorization failed.");
    this.name = "TenantError";
    this.code = code;
    this.status = status;
    this.retry_after = retryAfter;
  }
}

export function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function configuredKeys(env) {
  // TODO(phase2): move to KV.
  let parsed;
  try { parsed = JSON.parse(String(env.TENANT_KEYS || "")); }
  catch { throw new TenantError("AUTH_CONFIGURATION_ERROR", 503); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TenantError("AUTH_CONFIGURATION_ERROR", 503);
  }
  return parsed;
}

function tenantRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TenantError("AUTH_CONFIGURATION_ERROR", 503);
  const tenantId = String(record.tenant_id || "");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(tenantId)) throw new TenantError("AUTH_CONFIGURATION_ERROR", 503);
  const snapshotScope = getActiveSnapshot().tenant_scopes[tenantId];
  const configuredIds = record.product_ids === null
    ? null
    : (Array.isArray(record.product_ids) ? record.product_ids : snapshotScope?.product_ids);
  const allowFullEnumeration = record.allow_full_enumeration === true;
  const allowedProductIds = configuredIds === null && allowFullEnumeration
    ? null
    : new Set(Array.isArray(configuredIds) ? configuredIds.map(String) : []);
  return Object.freeze({
    tenant_id: tenantId,
    price_tier: String(record.price_tier || snapshotScope?.price_tier || "default"),
    allowed_product_ids: allowedProductIds,
    allow_full_enumeration: allowFullEnumeration,
    max_page_size: boundedInteger(record.max_page_size, 20, 1, 100),
    daily_quota: boundedInteger(record.daily_quota, 1000, 1, 1000000),
  });
}

export function resolveTenant(authorization, env = {}) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  if (!match) throw new TenantError("MISSING_CREDENTIAL", 401);
  const registry = configuredKeys(env);
  let matched = null;
  for (const [key, record] of Object.entries(registry)) {
    if (constantTimeEqual(match[1], key)) matched = record;
  }
  if (!matched) throw new TenantError("INVALID_CREDENTIAL", 401);
  return tenantRecord(matched);
}

export function consumeTenantQuota(tenant, now = Date.now()) {
  // TODO(phase2): durable counter.
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  const key = `${tenant.tenant_id}:${day}`;
  const used = DAILY_USAGE.get(key) || 0;
  if (used >= tenant.daily_quota) {
    const nextDay = Date.parse(`${day}T00:00:00Z`) + 86400000;
    const retryAfter = Math.max(1, Math.ceil((nextDay - date.getTime()) / 1000));
    throw new TenantError("QUOTA_EXCEEDED", 429, retryAfter);
  }
  DAILY_USAGE.set(key, used + 1);
  return { used: used + 1, remaining: tenant.daily_quota - used - 1 };
}

export function resetTenantState() {
  DAILY_USAGE.clear();
}
