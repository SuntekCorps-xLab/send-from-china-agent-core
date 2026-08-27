export const PUBLIC_PRODUCT_FIELDS = Object.freeze([
  "public_id", "slug", "title", "description", "category", "tags", "images",
  "attributes", "price", "availability_band", "lead_time_days", "as_of", "purchasable",
]);

// `source` is accepted only in the deployment-side snapshot so older published
// artifacts remain loadable. It is deliberately excluded from every product
// response; provenance must never become a supplier or source-system channel.
export const SNAPSHOT_PRODUCT_FIELDS = Object.freeze([...PUBLIC_PRODUCT_FIELDS, "source"]);

const AVAILABILITY_BANDS = new Set(["in_stock", "low", "out_of_stock"]);
const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

// Attributes are an explicitly versioned public schema, not an arbitrary
// extension bag. Keep this list synchronized with the Search Contract adapter.
// New names require a contract review and positive/negative compatibility tests.
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

export class FieldPolicyError extends Error {
  constructor(code = "INVALID_PUBLIC_PRODUCT") {
    super("Product data does not satisfy the public field policy.");
    this.name = "FieldPolicyError";
    this.code = code;
  }
}

function optionalString(value, maxLength = 2000) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new FieldPolicyError();
  return value;
}

function publicString(value, maxLength = 2000) {
  const output = optionalString(value, maxLength);
  if (output !== undefined && containsPrivateScalar(output)) throw new FieldPolicyError();
  return output;
}

function cleanTags(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new FieldPolicyError();
  if (value.some((item) => typeof item !== "string" || item.length > 100
    || containsPrivateScalar(item))) throw new FieldPolicyError();
  return [...value];
}

function cleanImages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new FieldPolicyError();
  return value.map((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) throw new FieldPolicyError();
    const url = optionalString(image.url, 2048);
    const alt = publicString(image.alt, 300);
    if (!url || !publicHttpsUrl(url)) throw new FieldPolicyError();
    const output = { url };
    if (alt !== undefined) output.alt = alt;
    return output;
  });
}

function cleanAttributes(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FieldPolicyError();
  const entries = Object.entries(value);
  if (entries.length > 50) throw new FieldPolicyError();
  const output = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new FieldPolicyError();
    if (!publicAttributeName(key) || privateAttributeName(key) || containsPrivateAttribute(item)) continue;
    if (typeof item !== "string" && typeof item !== "number") continue;
    if (typeof item === "string" && item.length > 300) throw new FieldPolicyError();
    if (typeof item === "string" && containsPrivateScalar(item)) continue;
    if (typeof item === "number" && !Number.isFinite(item)) throw new FieldPolicyError();
    output[key] = item;
  }
  return output;
}

const PRIVATE_ATTRIBUTE_NAMES = new Set([
  "api_key", "competitor_price", "cost", "cost_price", "credential", "credentials",
  "internal_id", "internal_product_id", "margin", "margin_rate", "platform_listing_id",
  "private_id", "secret", "source", "source_id", "source_url", "supplier", "supplier_id",
  "supplier_name", "supplier_url", "token", "vendor", "vendor_id", "warehouse_code",
  "wholesale_price",
]);

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
    || host.endsWith(".internal") || host.endsWith(".corp") || host.endsWith(".lan")
    || host.endsWith(".localdomain") || host.endsWith(".home.arpa")) return true;
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
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

function decodedSecurityText(value) {
  let output = String(value || "");
  for (let pass = 0; pass < 32; pass += 1) {
    const decoded = output.replace(/%([0-9a-f]{2})/giu,
      (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === output) break;
    output = decoded;
  }
  return output;
}

function normalizedSecurityText(value) {
  return decodedSecurityText(value).replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function containsBasicCredential(value) {
  const match = /\bBasic\s+([A-Za-z0-9+/]{2,}={0,2})(?=$|[^A-Za-z0-9+/=])/iu
    .exec(decodedSecurityText(value));
  if (!match) return false;
  const token = match[1].replace(/=+$/u, "");
  if (!token || token.length % 4 === 1) return false;
  try {
    return globalThis.atob(`${token}${"=".repeat((4 - (token.length % 4)) % 4)}`).includes(":");
  } catch {
    return false;
  }
}

function containsCredentialMarker(value, genericWithin = false) {
  const normalized = normalizedSecurityText(value);
  return /(?:^|_)(?:access_?token|refresh_?token|id_?token|auth_?token|api_?key|x_?api_?key|authorization|bearer_?token|client_?secret|session_?(?:id|key|token)|signature_?(?:id|key|token))(?:_|$)/u
    .test(normalized)
    || (genericWithin
      && /(?:^|_)(?:credential|password|session|signature|token|secret)(?:_|$)/u.test(normalized));
}

function containsCredentialAssignment(value) {
  const decoded = decodedSecurityText(value).replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  const key = String.raw`(?:access[\s._/-]*token|refresh[\s._/-]*token|id[\s._/-]*token|auth[\s._/-]*token|api[\s._/-]*key|x[\s._/-]*api[\s._/-]*key|authorization|bearer[\s._/-]*token|client[\s._/-]*secret|credential|password|session|signature|token|secret)`;
  const explicitAssignment = new RegExp(
    String.raw`(?:^|[^a-z0-9])${key}\s*(?:=|:|=>|->)\s*[^\s,;&]+`, "iu",
  );
  return explicitAssignment.test(decoded)
    || /(?:^|[^a-z0-9])token\s+[A-Za-z0-9._~+/=-]{8,}(?=$|[^A-Za-z0-9._~+/=-])/iu.test(decoded);
}

const PROVENANCE_ROOTS = Object.freeze([
  "source", "sources", "sourcing", "supplier", "suppliers", "vendor", "vendors",
  "warehouse", "warehouses", "receipt", "receipts",
]);

function provenanceCompactToken(value) {
  const token = String(value || "").toLowerCase();
  if (token === "sourcecode") return false;
  if (/^warehousecode(?:v\d+)?$/u.test(token)) return true;
  return PROVENANCE_ROOTS.some((root) => {
    if (!token.startsWith(root) || token === root) return false;
    const suffix = token.slice(root.length);
    return /^(?:id|url|record|reference|receipt(?:s)?|portal(?:s)?)(?:v\d+)?$/u.test(suffix);
  });
}

function provenanceSegment(value) {
  const tokens = decodedSecurityText(value).replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/gu).filter(Boolean);
  if (tokens.length === 1 && PROVENANCE_ROOTS.includes(tokens[0])) return true;
  const candidates = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    candidates.push(`${tokens[index]}${tokens[index + 1]}`);
    if (index < tokens.length - 2) candidates.push(`${tokens[index]}${tokens[index + 1]}${tokens[index + 2]}`);
  }
  return candidates.some(provenanceCompactToken);
}

function containsProvenanceAssignment(value) {
  const decoded = decodedSecurityText(value);
  if (!/[=:]/u.test(decoded)) return false;
  const normalized = normalizedSecurityText(decoded);
  return /(?:^|_)(?:source_?(?:id|url|record|reference|receipt)|sourcing_?(?:id|url|record|reference|receipt)|supplier_?(?:id|url|record|reference|receipt|portal)|vendor_?(?:id|url)|warehouse_?code)(?:_|$)/u
    .test(normalized);
}

function containsCredentialMaterial(value) {
  const text = decodedSecurityText(value);
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(text)
    || /\bBearer\s+[^\s,;]+/iu.test(text)
    || containsBasicCredential(text)
    || /\b(?:github_pat|ghp|gho|ghu|ghs|ghr|sk_live|shpat|shpca|shppa)_[A-Za-z0-9_-]{12,}\b/iu.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/u.test(text)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(text)
    || containsCredentialAssignment(text)
    || containsProvenanceAssignment(text);
}

function containsSensitiveUrlSemantics(url, depth = 0) {
  const structuralComponents = [
    ...url.hostname.split("."), ...url.pathname.split("/"), url.hash,
  ];
  if (structuralComponents.some((component) => containsCredentialMarker(component)
    || containsCredentialMaterial(component)
    || provenanceSegment(component))) return true;
  for (const [key, nested] of url.searchParams) {
    if (containsCredentialMarker(key, true) || containsCredentialMarker(nested)
      || containsCredentialMaterial(key) || containsCredentialMaterial(nested)
      || provenanceSegment(key) || provenanceSegment(nested)) return true;
    if (depth < 3 && containsPrivateNetworkUrl(decodedSecurityText(nested), depth + 1)) return true;
  }
  return false;
}

function publicHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && !privateHostname(url.hostname) && !containsSensitiveUrlSemantics(url);
  } catch {
    return false;
  }
}

function containsPrivateNetworkUrl(value, depth = 0) {
  for (const match of String(value).matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const candidate = match[0].replace(/[),.;!?]+$/gu, "");
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol)
        && (url.username || url.password || privateHostname(url.hostname)
          || containsSensitiveUrlSemantics(url, depth))) return true;
    } catch {
      // A field that semantically requires a URL performs stricter validation later.
    }
  }
  return false;
}

function containsPrivateScalar(value) {
  if (typeof value !== "string") return false;
  return containsCredentialMaterial(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || containsPrivateNetworkUrl(value);
}

function cleanPrice(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FieldPolicyError();
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new FieldPolicyError();
  if (!/^[A-Z]{3}$/.test(String(value.currency || ""))) throw new FieldPolicyError();
  const output = { amount, currency: value.currency };
  if (value.tier !== undefined) output.tier = publicString(value.tier, 80);
  return output;
}

export function toPublicProduct(internalProduct, context = {}) {
  if (!internalProduct || typeof internalProduct !== "object" || Array.isArray(internalProduct)) {
    throw new FieldPolicyError();
  }
  const publicId = optionalString(internalProduct.public_id, 22);
  const title = publicString(internalProduct.title, 300);
  const availability = optionalString(internalProduct.availability_band, 30);
  if (!publicId || !PUBLIC_ID_PATTERN.test(publicId) || !title || !AVAILABILITY_BANDS.has(availability)) {
    throw new FieldPolicyError("MISSING_REQUIRED_PUBLIC_FIELD");
  }
  const output = { public_id: publicId, title, availability_band: availability };
  if (internalProduct.slug !== undefined) {
    const slug = optionalString(internalProduct.slug, 100);
    if (!SLUG_PATTERN.test(slug)) throw new FieldPolicyError();
    output.slug = slug;
  }
  const description = publicString(internalProduct.description, 5000);
  if (description !== undefined) output.description = description;
  const category = publicString(internalProduct.category, 200);
  if (category !== undefined) output.category = category;
  const tags = cleanTags(internalProduct.tags);
  if (tags !== undefined) output.tags = tags;
  const images = cleanImages(internalProduct.images);
  if (images !== undefined) output.images = images;
  const attributes = cleanAttributes(internalProduct.attributes);
  if (attributes !== undefined) output.attributes = attributes;
  const price = cleanPrice(internalProduct.price);
  if (price !== undefined) output.price = price;
  if (internalProduct.lead_time_days !== undefined) {
    const days = Number(internalProduct.lead_time_days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new FieldPolicyError();
    output.lead_time_days = days;
  }
  const asOf = context.as_of ?? internalProduct.as_of;
  if (asOf !== undefined) {
    const parsed = optionalString(asOf, 40);
    if (!parsed || !Number.isFinite(Date.parse(parsed))) throw new FieldPolicyError();
    output.as_of = parsed;
  }
  if (internalProduct.purchasable !== undefined) {
    if (typeof internalProduct.purchasable !== "boolean") throw new FieldPolicyError();
    output.purchasable = internalProduct.purchasable;
  }
  return output;
}
