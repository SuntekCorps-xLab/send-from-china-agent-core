export const SANDBOX_STATUS_CONTRACT = "shopify-live-sandbox-status/v1";
export const SHOPIFY_SANDBOX_API_VERSION = "2026-07";

export const SANDBOX_MODES = Object.freeze([
  "synthetic_local_sandbox",
  "shopify_read_only",
]);

export const CREDENTIAL_STATES = Object.freeze([
  "mock_ready",
  "credential_missing",
  "authentication_failed",
  "permission_required",
  "quota_exceeded",
  "service_unavailable",
  "succeeded",
]);

export const STATUS_ERROR_CODES = Object.freeze([
  "CREDENTIAL_MISSING",
  "AUTHENTICATION_FAILED",
  "PERMISSION_REQUIRED",
  "QUOTA_EXCEEDED",
  "SERVICE_UNAVAILABLE",
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "contract",
  "mode",
  "verified",
  "credential_state",
  "data_source",
  "api_version",
  "quota",
  "writes",
  "non_transactional",
  "capabilities",
  "checked_at",
  "error_code",
  "purchasable",
  "shipping_rates",
  "commerce_writes",
  "credential_exposed",
]);

const QUOTA_FIELDS = Object.freeze([
  "limit",
  "remaining",
  "window_seconds",
  "concurrency_limit",
  "reset_at",
]);

const CAPABILITY_FIELDS = Object.freeze([
  "doctor",
  "catalog_search",
  "search_contract_v2",
  "product_detail",
  "storefront_health",
  "cart",
  "checkout",
  "order",
  "payment",
  "inventory",
  "publication",
  "product_mutation",
]);

const STATUS_ERROR_SET = new Set(STATUS_ERROR_CODES);
const CREDENTIAL_STATE_SET = new Set(CREDENTIAL_STATES);
const MODE_SET = new Set(SANDBOX_MODES);
const STATUS_ERROR_BY_STATE = Object.freeze({
  credential_missing: "CREDENTIAL_MISSING",
  authentication_failed: "AUTHENTICATION_FAILED",
  permission_required: "PERMISSION_REQUIRED",
  quota_exceeded: "QUOTA_EXCEEDED",
  service_unavailable: "SERVICE_UNAVAILABLE",
});

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function isoTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validQuota(value) {
  if (!exactFields(value, QUOTA_FIELDS)) return false;
  if (!["limit", "remaining", "window_seconds", "concurrency_limit"]
    .every((field) => Number.isInteger(value[field]) && value[field] >= 0)) return false;
  if (value.remaining > value.limit) return false;
  return value.reset_at === null || isoTimestamp(value.reset_at);
}

function validCapabilities(value) {
  return exactFields(value, CAPABILITY_FIELDS)
    && CAPABILITY_FIELDS.every((field) => typeof value[field] === "boolean")
    && ["cart", "checkout", "order", "payment", "inventory", "publication", "product_mutation"]
      .every((field) => value[field] === false);
}

export function validateSandboxStatus(value) {
  if (!exactFields(value, TOP_LEVEL_FIELDS)
    || value.contract !== SANDBOX_STATUS_CONTRACT
    || !MODE_SET.has(value.mode)
    || typeof value.verified !== "boolean"
    || !CREDENTIAL_STATE_SET.has(value.credential_state)
    || !["synthetic_fixture", "shopify_storefront_graphql"].includes(value.data_source)
    || !(value.api_version === null || value.api_version === SHOPIFY_SANDBOX_API_VERSION)
    || !validQuota(value.quota)
    || value.writes !== false
    || value.non_transactional !== true
    || !validCapabilities(value.capabilities)
    || !isoTimestamp(value.checked_at)
    || !(value.error_code === null || STATUS_ERROR_SET.has(value.error_code))
    || value.purchasable !== false
    || value.shipping_rates !== false
    || value.commerce_writes !== false
    || value.credential_exposed !== false) return false;

  if (value.mode === "synthetic_local_sandbox") {
    return value.verified === true
      && value.credential_state === "mock_ready"
      && value.data_source === "synthetic_fixture"
      && value.api_version === null
      && value.error_code === null
      && value.capabilities.catalog_search
      && value.capabilities.search_contract_v2
      && value.capabilities.product_detail
      && !value.capabilities.storefront_health;
  }
  if (value.data_source !== "shopify_storefront_graphql"
    || value.api_version !== SHOPIFY_SANDBOX_API_VERSION) return false;
  if (value.verified) {
    return value.credential_state === "succeeded"
      && value.error_code === null
      && value.capabilities.catalog_search
      && value.capabilities.search_contract_v2
      && value.capabilities.product_detail
      && value.capabilities.storefront_health;
  }
  return value.credential_state !== "mock_ready"
    && value.credential_state !== "succeeded"
    && value.error_code === STATUS_ERROR_BY_STATE[value.credential_state]
    && !value.capabilities.catalog_search
    && !value.capabilities.search_contract_v2
    && !value.capabilities.product_detail
    && !value.capabilities.storefront_health;
}

function capabilities(reads) {
  return Object.freeze({
    doctor: true,
    catalog_search: reads,
    search_contract_v2: reads,
    product_detail: reads,
    storefront_health: reads,
    cart: false,
    checkout: false,
    order: false,
    payment: false,
    inventory: false,
    publication: false,
    product_mutation: false,
  });
}

export function syntheticSandboxStatus(checkedAt) {
  const readCapabilities = Object.freeze({
    doctor: true,
    catalog_search: true,
    search_contract_v2: true,
    product_detail: true,
    storefront_health: false,
    cart: false,
    checkout: false,
    order: false,
    payment: false,
    inventory: false,
    publication: false,
    product_mutation: false,
  });
  const output = Object.freeze({
    contract: SANDBOX_STATUS_CONTRACT,
    mode: "synthetic_local_sandbox",
    verified: true,
    credential_state: "mock_ready",
    data_source: "synthetic_fixture",
    api_version: null,
    quota: Object.freeze({ limit: 0, remaining: 0, window_seconds: 0, concurrency_limit: 0, reset_at: null }),
    writes: false,
    non_transactional: true,
    capabilities: readCapabilities,
    checked_at: checkedAt,
    error_code: null,
    purchasable: false,
    shipping_rates: false,
    commerce_writes: false,
    credential_exposed: false,
  });
  if (!validateSandboxStatus(output)) throw new TypeError("Invalid synthetic sandbox status");
  return output;
}

export function shopifySandboxStatus(value) {
  const output = Object.freeze({
    contract: SANDBOX_STATUS_CONTRACT,
    mode: "shopify_read_only",
    verified: value.verified,
    credential_state: value.credential_state,
    data_source: "shopify_storefront_graphql",
    api_version: value.api_version,
    quota: Object.freeze({ ...value.quota }),
    writes: false,
    non_transactional: true,
    capabilities: capabilities(value.verified),
    checked_at: value.checked_at,
    error_code: value.error_code,
    purchasable: false,
    shipping_rates: false,
    commerce_writes: false,
    credential_exposed: false,
  });
  if (!validateSandboxStatus(output)) throw new TypeError("Invalid Shopify sandbox status");
  return output;
}
