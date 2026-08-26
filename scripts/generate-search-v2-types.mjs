import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const requestPath = resolve(root, "contracts/search-v2-request.schema.json");
const responsePath = resolve(root, "contracts/search-v2-response.schema.json");
const [requestText, responseText] = await Promise.all([
  readFile(requestPath, "utf8"),
  readFile(responsePath, "utf8"),
]);
const requestSchema = JSON.parse(requestText);
const responseSchema = JSON.parse(responseText);
const outputPath = resolve(root, "sdk/src/search-contract-v2.types.generated.d.ts");

function union(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function schemaType(schema) {
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) {
    if (schema.$ref.endsWith("#/$defs/condition")) return "SearchCondition";
    if (schema.$ref.endsWith("#/properties/product_identity")) return "SearchProductIdentityCondition";
    throw new Error(`Unsupported type-generation reference: ${schema.$ref}`);
  }
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => schemaType({ ...schema, type })).join(" | ");
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return `Array<${schemaType(schema.items || {})}>`;
  if (schema.type === "object") {
    if (!schema.properties) {
      const additional = schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? schemaType(schema.additionalProperties) : "unknown";
      return `Record<string, ${additional}>`;
    }
    return `{ ${interfaceMembers(schema).join(" ")} }`;
  }
  throw new Error(`Unsupported type-generation schema: ${JSON.stringify(schema)}`);
}

function interfaceMembers(schema, overrides = {}) {
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).map(([name, property]) => {
    const type = overrides[name] || schemaType(property);
    return `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${type};`;
  });
}

function renderInterface(name, schema, overrides = {}) {
  return `export interface ${name} {\n${interfaceMembers(schema, overrides)
    .map((line) => `  ${line}`).join("\n")}\n}`;
}

const version = requestSchema.properties.contract_version.const;
const condition = requestSchema.$defs.condition;
const sources = condition.properties.source.enum;
const scopes = condition.properties.scope.enum;
const hardness = condition.properties.hardness.enum;
const statuses = responseSchema.properties.status.enum;
const product = responseSchema.$defs.product;
const pagination = responseSchema.properties.pagination;
const searchScope = responseSchema.properties.search_scope;
const compatibility = responseSchema.properties.compatibility;
const hardConstraintClauses = requestSchema.properties.hard_constraints.items.allOf;
const hardConstraintNames = hardConstraintClauses.find((clause) => (
  Array.isArray(clause.properties?.name?.enum)
))?.properties?.name?.enum || [];
const priceHardConstraintNames = hardConstraintClauses.find((clause) => (
  clause.then?.properties?.value?.type === "number"
))?.if?.properties?.name?.enum || [];
const textHardConstraintNames = hardConstraintClauses.find((clause) => (
  clause.then?.properties?.value?.$ref === "#/$defs/textCriterionValue"
))?.if?.properties?.name?.enum || [];
const transactionNames = requestSchema.properties.transaction_context.items.allOf.find((clause) => (
  Array.isArray(clause.properties?.name?.enum)
))?.properties?.name?.enum || [];
const unknownTransactionNames = transactionNames.filter((name) => (
  !["ship_to", "quantity", "delivery_days_max"].includes(name)
));
const canonicalHardConstraintNames = ["price_min", "price_max", "material", "color", "must_have", "exclude"];
const unknownHardConstraintNames = hardConstraintNames.filter((name) => !canonicalHardConstraintNames.includes(name));
if (hardConstraintNames.length !== canonicalHardConstraintNames.length || unknownHardConstraintNames.length
  || canonicalHardConstraintNames.some((name) => !hardConstraintNames.includes(name))
  || !priceHardConstraintNames.length || !textHardConstraintNames.length || unknownTransactionNames.length
  || !transactionNames.includes("ship_to") || !transactionNames.includes("quantity")
  || !transactionNames.includes("delivery_days_max")) {
  throw new Error("Search v2 field-specific request constraints are incomplete");
}

const output = `// Generated from contracts/search-v2-*.schema.json. Do not edit by hand.
// request-schema-sha256: ${digest(requestText)}
// response-schema-sha256: ${digest(responseText)}
export type SearchConditionSource = ${union(sources)};
export type SearchConditionScope = ${union(scopes)};
export type SearchConditionHardness = ${union(hardness)};
export type SearchConditionValue = ${schemaType(condition.properties.value)};

${renderInterface("SearchCondition", condition, {
  source: "SearchConditionSource",
  scope: "SearchConditionScope",
  hardness: "SearchConditionHardness",
})}

export interface SearchProductIdentityCondition extends SearchCondition {
  name: "product_identity";
  value: string;
  scope: "product";
  hardness: "hard";
}

export interface SearchExplicitHardConstraint extends SearchCondition {
  name: ${union(hardConstraintNames)};
  source: "explicit";
  scope: "product";
  hardness: "hard";
}

export interface SearchPriceHardConstraint extends SearchExplicitHardConstraint {
  name: ${union(priceHardConstraintNames)};
  value: number;
}

export interface SearchTextHardConstraint extends SearchExplicitHardConstraint {
  name: ${union(textHardConstraintNames)};
  value: ${schemaType(requestSchema.$defs.textCriterionValue)};
}

export type SearchWireHardConstraint =
  | SearchPriceHardConstraint
  | SearchTextHardConstraint;

export interface SearchSoftContextCondition extends SearchCondition {
  scope: "product" | "session";
  hardness: "soft" | "informational";
}

export interface SearchHardTransactionCondition extends SearchCondition {
  scope: "transaction";
  source: "explicit";
  hardness: "hard";
}

export interface SearchInformationalTransactionCondition extends SearchCondition {
  scope: "transaction";
  hardness: "informational";
}

export interface SearchShipToTransactionCondition extends SearchCondition {
  name: "ship_to";
  value: string;
  scope: "transaction";
}

export interface SearchQuantityTransactionCondition extends SearchCondition {
  name: "quantity";
  value: number;
  scope: "transaction";
}

export interface SearchDeliveryDaysTransactionCondition extends SearchCondition {
  name: "delivery_days_max";
  value: number;
  scope: "transaction";
}

export type SearchTransactionValueCondition =
  | SearchShipToTransactionCondition
  | SearchQuantityTransactionCondition
  | SearchDeliveryDaysTransactionCondition;

export type SearchTransactionCondition =
  SearchTransactionValueCondition
  & (SearchHardTransactionCondition | SearchInformationalTransactionCondition);

// Ergonomic SDK input. normalizeSearchContractV2Request() turns this shape into
// the exact SearchContractV2WireRequest accepted by POST /api/search/v2.
export interface SearchContractV2Request {
  contract_version?: ${JSON.stringify(version)};
  product_identity: string | SearchCondition;
  hard_constraints?: SearchCondition[];
  soft_context?: SearchCondition[];
  transaction_context?: SearchCondition[];
  limit?: number;
  cursor?: string | null;
}

export interface SearchContractV2WireRequest {
  contract_version: ${JSON.stringify(version)};
  product_identity: SearchProductIdentityCondition;
  hard_constraints: SearchWireHardConstraint[];
  soft_context: SearchSoftContextCondition[];
  transaction_context: SearchTransactionCondition[];
  limit: number;
  cursor?: string | null;
}

export interface NormalizedSearchContractV2Request extends SearchContractV2WireRequest {
  cursor: string | null;
}

${renderInterface("SearchRelaxation", responseSchema.$defs.relaxation)}

${renderInterface("SearchProductImage", product.properties.images.items)}

${renderInterface("SearchProductPrice", product.properties.price)}

${renderInterface("SearchProduct", product, {
  images: "SearchProductImage[]",
  price: "SearchProductPrice",
})}

${renderInterface("SearchPagination", pagination)}

${renderInterface("SearchScope", searchScope)}

${renderInterface("SearchCompatibility", compatibility)}

export interface SearchNormalizedIntent {
  product_identity: SearchProductIdentityCondition;
  hard_constraints: SearchWireHardConstraint[];
  soft_context: SearchSoftContextCondition[];
  transaction_context: SearchTransactionCondition[];
}

export interface SearchContractV2Response {
  contract_version: ${JSON.stringify(version)};
  trace_id: string;
  status: ${union(statuses)};
  normalized_intent: SearchNormalizedIntent;
  relaxations: SearchRelaxation[];
  missing_criteria: string[];
  results: SearchProduct[];
  pagination: SearchPagination;
  search_scope: SearchScope;
  compatibility?: SearchCompatibility;
}
`;

if (process.argv.includes("--write")) {
  await writeFile(outputPath, output, "utf8");
  console.log("Generated Search Contract v2 TypeScript declarations.");
} else {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    console.error("Search Contract v2 TypeScript declarations are stale. Run npm run types:generate.");
    process.exit(1);
  }
  console.log("PASS: Search Contract v2 TypeScript declarations are current");
}
