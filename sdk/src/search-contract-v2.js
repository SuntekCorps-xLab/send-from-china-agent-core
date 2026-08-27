export const SEARCH_CONTRACT_VERSION = "2.0";

const CONDITION_SOURCES = new Set(["explicit", "inferred", "default"]);
const CONDITION_SCOPES = new Set(["product", "session", "transaction"]);
const CONDITION_HARDNESS = new Set(["hard", "soft", "informational"]);
const PRICE_HARD_CONSTRAINTS = new Set(["price_min", "price_max"]);
const TEXT_HARD_CONSTRAINTS = new Set(["material", "color", "must_have", "exclude"]);
const PRODUCT_HARD_CONSTRAINTS = new Set([...PRICE_HARD_CONSTRAINTS, ...TEXT_HARD_CONSTRAINTS]);
const TRANSACTION_CONDITIONS = new Set(["ship_to", "quantity", "delivery_days_max"]);
const WIRE_REQUEST_FIELDS = new Set([
  "contract_version", "product_identity", "hard_constraints", "soft_context",
  "transaction_context", "limit", "cursor",
]);
const CONDITION_FIELDS = new Set(["name", "value", "source", "scope", "hardness"]);
const V1_CRITERIA = new Set([
  "category", "use_case", "price_max", "materials", "must_have", "exclude", "keywords",
]);
const PUBLIC_SEARCH_PRODUCT_FIELDS = Object.freeze([
  "public_id", "slug", "title", "description", "category", "tags", "images", "attributes",
  "price", "availability_band", "lead_time_days", "as_of", "purchasable",
  "product_url", "add_to_cart_url",
]);
const PRIVATE_ATTRIBUTE_NAMES = new Set([
  "api_key", "competitor_price", "cost", "cost_price", "credential", "credentials",
  "internal_id", "internal_product_id", "margin", "margin_rate", "platform_listing_id",
  "private_id", "secret", "source", "source_id", "source_url", "supplier", "supplier_id",
  "supplier_name", "supplier_url", "token", "vendor", "vendor_id", "warehouse_code",
  "wholesale_price",
]);
export const PUBLIC_ATTRIBUTE_POLICY_VERSION = "public-product-attributes/v1";
export const PUBLIC_ATTRIBUTE_NAMES = Object.freeze([
  "age_range", "battery_mah", "battery_wh", "brand", "capacity_l", "capacity_ml",
  "certification", "certifications", "color", "colors", "colour", "compartment_count",
  "compatibility", "compatible_models", "depth_cm", "depth_in", "depth_mm",
  "diameter_cm", "diameter_in", "diameter_mm", "dimensions", "feature", "features",
  "finish", "gender", "height_cm", "height_in", "height_mm", "length_cm", "length_in",
  "length_mm", "material", "materials", "model", "pack_size", "pattern", "piece_count",
  "pieces", "pocket_count", "pockets", "power", "shape", "size", "sizes", "style",
  "styles", "thickness_cm", "thickness_in", "thickness_mm", "use_case", "voltage",
  "volume_l", "volume_ml", "weight", "weight_g", "weight_kg", "weight_lb", "weight_oz",
  "width_cm", "width_in", "width_mm",
]);
const PUBLIC_ATTRIBUTE_NAME_SET = new Set(PUBLIC_ATTRIBUTE_NAMES);

function invalid(message) {
  throw new TypeError(`Invalid Search Contract v2 request: ${message}`);
}

function hasExactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.has(key));
}

function assertWireCondition(value, group) {
  if (!hasExactFields(value, CONDITION_FIELDS) || Object.keys(value).length !== CONDITION_FIELDS.size) {
    invalid(`${group} conditions must contain only name, value, source, scope, and hardness`);
  }
  if (typeof value.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.name)) {
    invalid(`${group} condition names must use lower_snake_case strings`);
  }
  cleanCondition(value);
}

function cleanValue(value) {
  if (typeof value === "string") {
    const output = value.trim();
    if (!output || output.length > 300) invalid("condition strings must contain 1 to 300 characters");
    return output;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("condition numbers must be finite");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (!value.length || value.length > 50) invalid("condition arrays must contain 1 to 50 values");
    const output = [];
    for (const item of value) {
      const cleaned = cleanValue(item);
      if (Array.isArray(cleaned)) invalid("nested condition arrays are not supported");
      if (!output.some((existing) => Object.is(existing, cleaned))) output.push(cleaned);
    }
    return output;
  }
  invalid("condition values must be a string, number, boolean, or flat array");
}

function cleanCondition(value, defaults = {}) {
  const input = typeof value === "string" ? { value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("conditions must be objects");
  const name = String(defaults.name || input.name || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) invalid("condition names must use lower_snake_case");
  const source = String(input.source || defaults.source || "explicit");
  const scope = String(defaults.scope || input.scope || "product");
  const hardness = String(defaults.hardness || input.hardness || "soft");
  if (!CONDITION_SOURCES.has(source)) invalid(`unsupported source for ${name}`);
  if (!CONDITION_SCOPES.has(scope)) invalid(`unsupported scope for ${name}`);
  if (!CONDITION_HARDNESS.has(hardness)) invalid(`unsupported hardness for ${name}`);
  return Object.freeze({ name, value: cleanValue(input.value), source, scope, hardness });
}

function cleanConditions(value, defaults = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) invalid("condition groups must be arrays of at most 50 items");
  return value.map((item) => cleanCondition(item, defaults));
}

function assertTextCriterionValue(value, name) {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || items.length > 20
    || items.some((item) => typeof item !== "string" || !item.trim() || item.length > 80)) {
    invalid(`${name} must be a non-empty string or an array of 1 to 20 strings of at most 80 characters`);
  }
}

function assertHardConstraintValue(condition) {
  if (!PRODUCT_HARD_CONSTRAINTS.has(condition.name)) {
    invalid("hard_constraints supports only price_min, price_max, material, color, must_have, and exclude");
  }
  if (PRICE_HARD_CONSTRAINTS.has(condition.name)) {
    if (typeof condition.value !== "number" || !Number.isFinite(condition.value) || condition.value < 0) {
      invalid(`${condition.name} must be a non-negative finite number`);
    }
  } else if (TEXT_HARD_CONSTRAINTS.has(condition.name)) {
    assertTextCriterionValue(condition.value, condition.name);
  }
}

function assertTransactionConditionValue(condition) {
  if (!TRANSACTION_CONDITIONS.has(condition.name)) {
    invalid("transaction_context supports only ship_to, quantity, and delivery_days_max");
  }
  if (condition.name === "ship_to") {
    if (typeof condition.value !== "string" || condition.value.trim().length < 2 || condition.value.length > 100) {
      invalid("ship_to must be a string of 2 to 100 characters");
    }
  } else if (!Number.isInteger(condition.value) || condition.value < 1) {
    invalid(`${condition.name} must be a positive integer`);
  }
}

function normalizedIntent(request) {
  return Object.freeze({
    product_identity: request.product_identity,
    hard_constraints: request.hard_constraints,
    soft_context: request.soft_context,
    transaction_context: request.transaction_context,
  });
}

export function normalizeSearchContractV2Request(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request must be an object");
  if (value.contract_version !== undefined && String(value.contract_version) !== SEARCH_CONTRACT_VERSION) {
    invalid(`contract_version must be ${SEARCH_CONTRACT_VERSION}`);
  }
  const productIdentity = cleanCondition(value.product_identity, {
    name: "product_identity", scope: "product", hardness: "hard",
  });
  const explicitHard = [];
  const demotedContext = [];
  for (const condition of cleanConditions(value.hard_constraints, { scope: "product", hardness: "hard" })) {
    if (condition.source === "explicit") {
      assertHardConstraintValue(condition);
      explicitHard.push(condition);
    } else {
      demotedContext.push(Object.freeze({ ...condition, scope: "session", hardness: "soft" }));
    }
  }
  const softContext = [
    ...demotedContext,
    ...cleanConditions(value.soft_context).map((condition) => Object.freeze({
      ...condition,
      hardness: condition.hardness === "informational" ? "informational" : "soft",
    })),
  ];
  const transactionContext = cleanConditions(value.transaction_context, { scope: "transaction" }).map((condition) => {
    assertTransactionConditionValue(condition);
    const hardness = condition.source === "explicit" && condition.hardness === "hard" ? "hard" : "informational";
    return Object.freeze({ ...condition, scope: "transaction", hardness });
  });
  const limit = value.limit === undefined ? 20 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid("limit must be an integer from 1 to 50");
  const cursor = value.cursor === undefined || value.cursor === null || value.cursor === ""
    ? null : String(value.cursor);
  if (cursor !== null && cursor.length > 1000) invalid("cursor is too long");
  return Object.freeze({
    contract_version: SEARCH_CONTRACT_VERSION,
    product_identity: productIdentity,
    hard_constraints: Object.freeze(explicitHard),
    soft_context: Object.freeze(softContext),
    transaction_context: Object.freeze(transactionContext),
    limit,
    cursor,
  });
}

// HTTP Search Contract v2 accepts only the normative, normalized wire shape.
// SDK callers may continue to use normalizeSearchContractV2Request() with its
// documented ergonomic defaults before sending the request.
export function parseSearchContractV2Request(value) {
  if (!hasExactFields(value, WIRE_REQUEST_FIELDS)) invalid("request contains an unknown field");
  for (const field of [
    "contract_version", "product_identity", "hard_constraints", "soft_context",
    "transaction_context", "limit",
  ]) {
    if (!Object.hasOwn(value, field)) invalid(`request is missing ${field}`);
  }
  if (value.contract_version !== SEARCH_CONTRACT_VERSION) invalid(`contract_version must be ${SEARCH_CONTRACT_VERSION}`);
  assertWireCondition(value.product_identity, "product_identity");
  if (value.product_identity.name !== "product_identity"
    || typeof value.product_identity.value !== "string"
    || value.product_identity.scope !== "product"
    || value.product_identity.hardness !== "hard") {
    invalid("product_identity is not normalized");
  }
  for (const [group, conditions] of [
    ["hard_constraints", value.hard_constraints],
    ["soft_context", value.soft_context],
    ["transaction_context", value.transaction_context],
  ]) {
    if (!Array.isArray(conditions) || conditions.length > 50) invalid(`${group} must be an array of at most 50 conditions`);
    for (const condition of conditions) assertWireCondition(condition, group);
  }
  if (value.hard_constraints.some((condition) => condition.source !== "explicit"
    || condition.scope !== "product" || condition.hardness !== "hard")) {
    invalid("hard_constraints must be explicit hard product conditions");
  }
  if (value.soft_context.some((condition) => condition.scope === "transaction"
    || !new Set(["soft", "informational"]).has(condition.hardness))) {
    invalid("soft_context cannot contain hard or transaction conditions");
  }
  if (value.transaction_context.some((condition) => condition.scope !== "transaction"
    || !new Set(["hard", "informational"]).has(condition.hardness)
    || (condition.hardness === "hard" && condition.source !== "explicit"))) {
    invalid("transaction_context is not normalized");
  }
  for (const condition of value.hard_constraints) assertHardConstraintValue(condition);
  for (const condition of value.transaction_context) assertTransactionConditionValue(condition);
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50) {
    invalid("limit must be an integer from 1 to 50");
  }
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== "string") {
    invalid("cursor must be a string or null");
  }
  return normalizeSearchContractV2Request(value);
}

function listValue(value) {
  return Array.isArray(value) ? value : [value];
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function appendUnique(target, values) {
  for (const value of listValue(values)) {
    const cleaned = String(value).trim();
    if (cleaned && !target.includes(cleaned)) target.push(cleaned);
  }
}

function intentFingerprint(request) {
  const intent = JSON.stringify(normalizedIntent(request));
  let hash = 14695981039346656037n;
  for (let index = 0; index < intent.length; index += 1) {
    hash ^= BigInt(intent.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function wrapCursor(cursor, request) {
  if (!cursor) return null;
  const output = `sc2_${intentFingerprint(request)}_${String(cursor)}`;
  if (output.length > 1000) invalid("cursor is too long");
  return output;
}

function unwrapCursor(cursor, request) {
  if (!cursor) return null;
  const match = /^sc2_([0-9a-f]{16})_([\s\S]+)$/.exec(String(cursor));
  if (!match || match[1] !== intentFingerprint(request)) invalid("cursor does not belong to this normalized intent");
  return match[2];
}

function normalizedAttributeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function publicAttributeName(value) {
  return typeof value === "string"
    && value === normalizedAttributeName(value)
    && PUBLIC_ATTRIBUTE_NAME_SET.has(value);
}

function privateAttributeName(value) {
  const name = normalizedAttributeName(value);
  return PRIVATE_ATTRIBUTE_NAMES.has(name)
    || /^(?:api_key|credential|internal|margin|private|secret|supplier|token|vendor|warehouse)(?:_|$)/.test(name)
    || /^(?:cost|wholesale)(?:_|$)/.test(name)
    || /^source_(?:id|url|record|reference)$/.test(name);
}

function containsPrivateAttribute(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsPrivateAttribute(item, seen));
  return Object.entries(value).some(([key, item]) => privateAttributeName(key) || containsPrivateAttribute(item, seen));
}

function privateIpv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function privateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".corp")) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host)) return privateIpv4(host);
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    if (privateIpv4(mapped)) return true;
    const pair = mapped.split(":");
    if (pair.length === 2 && pair.every((item) => /^[0-9a-f]{1,4}$/u.test(item))) {
      const numeric = (Number.parseInt(pair[0], 16) * 65_536) + Number.parseInt(pair[1], 16);
      return privateIpv4([
        (numeric >>> 24) & 255, (numeric >>> 16) & 255, (numeric >>> 8) & 255, numeric & 255,
      ].join("."));
    }
  }
  const first = Number.parseInt(host.split(":").find((item) => item.length > 0) || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function containsPrivateNetworkUrl(value) {
  for (const match of String(value).matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const candidate = match[0].replace(/[),.;!?]+$/gu, "");
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol)
        && (url.username || url.password || privateHostname(url.hostname))) return true;
    } catch {
      // A field that semantically requires a URL performs stricter validation later.
    }
  }
  return false;
}

function containsPrivateScalar(value) {
  if (typeof value !== "string") return false;
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(value)
    || /\b(?:github_pat|ghp|gho|ghu|ghs|ghr|sk_live|shpat|shpca|shppa)_[A-Za-z0-9_-]{12,}\b/iu.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/u.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /(?:^|[?&;\s])(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|session|signature|token)\s*[=:]\s*[^&;\s]{6,}/iu.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || containsPrivateNetworkUrl(value);
}

function publicAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 50) return undefined;
  const output = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)
      || !publicAttributeName(key)
      || privateAttributeName(key)
      || containsPrivateAttribute(item)) continue;
    if (typeof item === "string" && item.length <= 300 && !containsPrivateScalar(item)) output[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
  }
  return output;
}

function publicString(value, maximum, options = {}) {
  if (typeof value !== "string" || value.length > maximum || containsPrivateScalar(value)) return undefined;
  if (options.nonEmpty && !value.trim()) return undefined;
  if (options.pattern && !options.pattern.test(value)) return undefined;
  return value;
}

function publicHttpsUrl(value) {
  const text = publicString(value, 2048, { nonEmpty: true });
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || privateHostname(url.hostname)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function publicTags(value) {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const output = value.map((item) => publicString(item, 100, { nonEmpty: true }));
  return output.some((item) => item === undefined) ? undefined : Object.freeze(output);
}

function publicImages(value) {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const url = publicHttpsUrl(item.url);
    if (!url) return undefined;
    const image = { url };
    if (item.alt !== undefined) {
      const alt = publicString(item.alt, 300);
      if (alt === undefined) return undefined;
      image.alt = alt;
    }
    output.push(Object.freeze(image));
  }
  return Object.freeze(output);
}

function publicPrice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) return undefined;
  const output = { amount: value.amount, currency: value.currency };
  if (value.tier !== undefined) {
    const tier = publicString(value.tier, 80);
    if (tier === undefined) return undefined;
    output.tier = tier;
  }
  return Object.freeze(output);
}

function publicProduct(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = {};
  for (const field of PUBLIC_SEARCH_PRODUCT_FIELDS) {
    if (value[field] === undefined) continue;
    if (field === "attributes") {
      const attributes = publicAttributes(value.attributes);
      if (attributes !== undefined) output.attributes = attributes;
    } else if (field === "images") {
      const images = publicImages(value.images);
      if (images !== undefined) output.images = images;
    } else if (field === "price") {
      const price = publicPrice(value.price);
      if (price !== undefined) output.price = price;
    } else if (field === "tags") {
      const tags = publicTags(value.tags);
      if (tags !== undefined) output.tags = tags;
    } else if (["product_url", "add_to_cart_url"].includes(field)) {
      const url = publicHttpsUrl(value[field]);
      if (url !== undefined) output[field] = url;
    } else if (field === "public_id") {
      if (typeof value.public_id === "string" && /^[A-Za-z0-9]{22}$/u.test(value.public_id)) {
        output.public_id = value.public_id;
      }
    } else if (field === "slug") {
      const slug = publicString(value.slug, 100, { pattern: /^[a-z0-9-]{1,100}$/u });
      if (slug !== undefined) output.slug = slug;
    } else if (field === "title") {
      const title = publicString(value.title, 300, { nonEmpty: true });
      if (title !== undefined) output.title = title;
    } else if (field === "description") {
      const description = publicString(value.description, 5000);
      if (description !== undefined) output.description = description;
    } else if (field === "category") {
      const category = publicString(value.category, 200);
      if (category !== undefined) output.category = category;
    } else if (field === "availability_band") {
      if (typeof value.availability_band === "string" && value.availability_band.length <= 30) {
        output.availability_band = value.availability_band;
      }
    } else if (field === "lead_time_days") {
      if (Number.isInteger(value.lead_time_days) && value.lead_time_days >= 0 && value.lead_time_days <= 3650) {
        output.lead_time_days = value.lead_time_days;
      }
    } else if (field === "as_of") {
      if (typeof value.as_of === "string" && value.as_of.length <= 40 && Number.isFinite(Date.parse(value.as_of))) {
        output.as_of = value.as_of;
      }
    } else if (field === "purchasable" && typeof value.purchasable === "boolean") {
      output.purchasable = value.purchasable;
    }
  }
  return typeof output.title === "string" && output.title.trim() ? Object.freeze(output) : null;
}

function invalidResponse() {
  throw new TypeError("Invalid Search Contract v2 response");
}

function responseString(value, maximum, options = {}) {
  if (typeof value !== "string" || value.length > maximum
    || (options.nonEmpty && !value.trim())
    || (options.pattern && !options.pattern.test(value))
    || (options.values && !options.values.has(value))) invalidResponse();
  return value;
}

function responseCursor(value) {
  if (value === null) return null;
  return responseString(value, 1000);
}

function responseRelaxationScalar(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 300 && value.trim()) return value;
  return invalidResponse();
}

function responseRelaxationValue(value) {
  if (!Array.isArray(value)) return responseRelaxationScalar(value);
  if (value.length < 1 || value.length > 50) return invalidResponse();
  return Object.freeze(value.map(responseRelaxationScalar));
}

function responseRelaxation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  const condition = responseString(value.condition, 64, {
    pattern: /^[a-z][a-z0-9_]{0,63}$/u, nonEmpty: true,
  });
  const reason = responseString(value.reason, 300, { nonEmpty: true });
  return Object.freeze({
    condition,
    ...(value.from !== undefined ? { from: responseRelaxationValue(value.from) } : {}),
    ...(value.to !== undefined ? { to: responseRelaxationValue(value.to) } : {}),
    reason,
  });
}

// A v2 server is expected to honor the response schema, but the SDK does not
// treat an upstream JSON object as a trusted public projection. Rebuild the
// response from known contract fields and reapply the product attribute policy
// before returning it to an application.
export function projectSearchContractV2Response(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  if (value.contract_version !== SEARCH_CONTRACT_VERSION) return invalidResponse();
  const traceId = responseString(value.trace_id, 200, { nonEmpty: true });
  const status = responseString(value.status, 30, {
    values: new Set(["results", "needs_clarification", "no_match", "degraded"]),
  });
  const pagination = value.pagination;
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)
    || !Number.isInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 50
    || typeof pagination.has_more !== "boolean") return invalidResponse();
  const cursor = responseCursor(pagination.cursor);
  const nextCursor = responseCursor(pagination.next_cursor);
  if ((pagination.has_more && !nextCursor) || (!pagination.has_more && nextCursor !== null)) return invalidResponse();
  const intent = value.normalized_intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return invalidResponse();
  const parsedIntent = parseSearchContractV2Request({
    contract_version: SEARCH_CONTRACT_VERSION,
    product_identity: intent.product_identity,
    hard_constraints: intent.hard_constraints,
    soft_context: intent.soft_context,
    transaction_context: intent.transaction_context,
    limit: pagination.limit,
    cursor,
  });
  if (!Array.isArray(value.relaxations) || value.relaxations.length > 100
    || !Array.isArray(value.missing_criteria) || value.missing_criteria.length > 50
    || !Array.isArray(value.results) || value.results.length > 50) return invalidResponse();
  const missingCriteria = value.missing_criteria.map((item) => responseString(item, 64, {
    pattern: /^[a-z][a-z0-9_]{0,63}$/u,
  }));
  const results = value.results.map(publicProduct).filter(Boolean);
  const searchScope = value.search_scope;
  const scopeBooleans = [
    "plan_complete", "scope_exhausted", "global_catalog_exhaustive", "scan_limit_reached", "degraded",
  ];
  if (!searchScope || typeof searchScope !== "object" || Array.isArray(searchScope)
    || scopeBooleans.some((field) => typeof searchScope[field] !== "boolean")) return invalidResponse();
  const degradedReason = searchScope.degraded_reason === null ? null
    : responseString(searchScope.degraded_reason, 200, { nonEmpty: true });
  if ((status === "degraded") !== (searchScope.degraded === true)
    || (status === "degraded" ? degradedReason === null : degradedReason !== null)) return invalidResponse();
  if (status === "no_match" && (results.length || pagination.has_more || nextCursor !== null
    || !searchScope.plan_complete || !searchScope.scope_exhausted || searchScope.scan_limit_reached)) {
    return invalidResponse();
  }
  const output = {
    contract_version: SEARCH_CONTRACT_VERSION,
    trace_id: traceId,
    status,
    normalized_intent: normalizedIntent(parsedIntent),
    relaxations: Object.freeze(value.relaxations.map(responseRelaxation)),
    missing_criteria: Object.freeze(missingCriteria),
    results: Object.freeze(results),
    pagination: Object.freeze({ limit: pagination.limit, cursor, next_cursor: nextCursor, has_more: pagination.has_more }),
    search_scope: Object.freeze({
      plan_complete: searchScope.plan_complete,
      scope_exhausted: searchScope.scope_exhausted,
      global_catalog_exhaustive: searchScope.global_catalog_exhaustive,
      scan_limit_reached: searchScope.scan_limit_reached,
      degraded: searchScope.degraded,
      degraded_reason: degradedReason,
    }),
  };
  if (value.compatibility !== undefined) {
    const compatibility = value.compatibility;
    if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)
      || compatibility.adapter !== "product_search_v1") return invalidResponse();
    output.compatibility = Object.freeze({
      adapter: "product_search_v1",
      legacy_status: responseString(compatibility.legacy_status, 100),
    });
  }
  return Object.freeze(output);
}

function cleanRelaxation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const condition = String(value.condition || "").trim().toLowerCase();
  const reason = String(value.reason || "").trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(condition) || !reason) return null;
  return Object.freeze({
    condition,
    ...(value.from !== undefined ? { from: responseRelaxationValue(value.from) } : {}),
    ...(value.to !== undefined ? { to: responseRelaxationValue(value.to) } : {}),
    reason: reason.slice(0, 300),
  });
}

export function adaptSearchContractV2RequestToV1(value, options = {}) {
  const request = normalizeSearchContractV2Request(value);
  const criteria = {};
  const relaxations = [];
  for (const condition of request.hard_constraints) {
    let name = condition.name;
    if (name === "material") name = "materials";
    if (name === "keyword") name = "keywords";
    if (!V1_CRITERIA.has(name)) {
      relaxations.push(Object.freeze({
        condition: condition.name,
        from: condition.value,
        reason: "The v1 compatibility path cannot enforce this condition.",
      }));
      continue;
    }
    if (["materials", "must_have", "exclude", "keywords"].includes(name)) {
      const output = Array.isArray(criteria[name]) ? criteria[name] : [];
      appendUnique(output, condition.value);
      criteria[name] = output.slice(0, 20);
    } else if (name === "price_max") {
      const price = Number(firstValue(condition.value));
      if (Number.isFinite(price) && price >= 0) criteria.price_max = price;
      else relaxations.push(Object.freeze({
        condition: condition.name, from: condition.value,
        reason: "The v1 compatibility path requires a non-negative numeric maximum price.",
      }));
    } else {
      criteria[name] = String(firstValue(condition.value));
    }
  }
  const destination = request.transaction_context.find((condition) => condition.name === "ship_to");
  if (destination) criteria.ship_to = String(firstValue(destination.value)).trim().toUpperCase();
  for (const condition of request.soft_context) {
    relaxations.push(Object.freeze({
      condition: condition.name,
      from: condition.value,
      reason: "The v1 compatibility path preserves product-first recall and cannot apply separate soft reranking.",
    }));
  }
  for (const condition of request.transaction_context) {
    if (condition.name === "ship_to") continue;
    relaxations.push(Object.freeze({
      condition: condition.name,
      from: condition.value,
      reason: "The v1 compatibility path preserves this transaction context but does not evaluate it during catalog retrieval.",
    }));
  }
  const operation = String(options.operation || "search");
  if (!new Set(["search", "confirm_search", "more"]).has(operation)) invalid("unsupported v1 operation");
  return Object.freeze({
    request,
    arguments: Object.freeze({
      query: String(request.product_identity.value),
      criteria: Object.freeze(criteria),
      operation,
      limit: request.limit,
      ...(request.cursor ? { cursor: unwrapCursor(request.cursor, request) } : {}),
    }),
    relaxations: Object.freeze(relaxations),
  });
}

export function adaptSearchContractV1ResponseToV2(value, context = {}) {
  const legacy = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const request = normalizeSearchContractV2Request(context.request);
  const results = Object.freeze((Array.isArray(legacy.products) ? legacy.products : [])
    .map(publicProduct).filter(Boolean).slice(0, request.limit));
  const legacyStatus = String(legacy.status || "").toLowerCase();
  const exhaustive = legacy.exhaustive === true;
  const scopeExhausted = legacy.search_scope_exhausted === true;
  const scanLimitReached = legacy.scan_limit_reached === true || legacy.truncated === true;
  const nextCursor = wrapCursor(legacy.next_cursor, request);
  const missingCriteria = Object.freeze((Array.isArray(legacy.missing_criteria) ? legacy.missing_criteria : [])
    .map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z][a-z0-9_]{0,63}$/.test(item)));
  let status = "degraded";
  if (results.length) status = "results";
  else if (legacyStatus === "needs_clarification" || missingCriteria.length) status = "needs_clarification";
  else if (legacyStatus === "no_match" && exhaustive && scopeExhausted && !scanLimitReached) status = "no_match";
  const relaxations = Object.freeze([
    ...(Array.isArray(context.relaxations) ? context.relaxations : []),
    ...(Array.isArray(legacy.relaxations) ? legacy.relaxations.map(cleanRelaxation).filter(Boolean) : []),
  ]);
  const degraded = status === "degraded";
  const traceId = String(context.traceId || legacy.trace_id || legacy.search_id || "compat-v1-trace-unavailable").slice(0, 200);
  return Object.freeze({
    contract_version: SEARCH_CONTRACT_VERSION,
    trace_id: traceId || "compat-v1-trace-unavailable",
    status,
    normalized_intent: normalizedIntent(request),
    relaxations,
    missing_criteria: missingCriteria,
    results,
    pagination: Object.freeze({
      limit: request.limit,
      cursor: request.cursor,
      next_cursor: nextCursor,
      has_more: Boolean(nextCursor),
    }),
    search_scope: Object.freeze({
      plan_complete: exhaustive,
      scope_exhausted: scopeExhausted,
      global_catalog_exhaustive: legacy.global_catalog_exhaustive === true,
      scan_limit_reached: scanLimitReached,
      degraded,
      degraded_reason: degraded ? "The v1 response did not prove a complete terminal search outcome." : null,
    }),
    compatibility: Object.freeze({ adapter: "product_search_v1", legacy_status: legacyStatus || "unknown" }),
  });
}

export function createSearchContractV1Adapter() {
  return Object.freeze({
    normalizeRequest: normalizeSearchContractV2Request,
    toV1Arguments: adaptSearchContractV2RequestToV1,
    fromV1Response: adaptSearchContractV1ResponseToV2,
  });
}
