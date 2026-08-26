// Generated from contracts/search-v2-*.schema.json. Do not edit by hand.
// request-schema-sha256: d4aa3f5ae0e9a598b220d7427ba79904c156c5f5de8a7ad546beb9182888179c
// response-schema-sha256: dd8189b6f3294c3b499f9ccb1de12a3e283d5de2eaecb2ac2e65e0c054c440a6
export type SearchConditionSource = "explicit" | "inferred" | "default";
export type SearchConditionScope = "product" | "session" | "transaction";
export type SearchConditionHardness = "hard" | "soft" | "informational";
export type SearchConditionValue = string | number | boolean | Array<string | number | boolean>;

export interface SearchCondition {
  "name": string;
  "value": string | number | boolean | Array<string | number | boolean>;
  "source": SearchConditionSource;
  "scope": SearchConditionScope;
  "hardness": SearchConditionHardness;
}

export interface SearchProductIdentityCondition extends SearchCondition {
  name: "product_identity";
  value: string;
  scope: "product";
  hardness: "hard";
}

export interface SearchExplicitHardConstraint extends SearchCondition {
  source: "explicit";
  scope: "product";
  hardness: "hard";
}

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

export type SearchTransactionCondition =
  | SearchHardTransactionCondition
  | SearchInformationalTransactionCondition;

// Ergonomic SDK input. normalizeSearchContractV2Request() turns this shape into
// the exact SearchContractV2WireRequest accepted by POST /api/search/v2.
export interface SearchContractV2Request {
  contract_version?: "2.0";
  product_identity: string | SearchCondition;
  hard_constraints?: SearchCondition[];
  soft_context?: SearchCondition[];
  transaction_context?: SearchCondition[];
  limit?: number;
  cursor?: string | null;
}

export interface SearchContractV2WireRequest {
  contract_version: "2.0";
  product_identity: SearchProductIdentityCondition;
  hard_constraints: SearchExplicitHardConstraint[];
  soft_context: SearchSoftContextCondition[];
  transaction_context: SearchTransactionCondition[];
  limit: number;
  cursor?: string | null;
}

export interface NormalizedSearchContractV2Request extends SearchContractV2WireRequest {
  cursor: string | null;
}

export interface SearchRelaxation {
  "condition": string;
  "from"?: unknown;
  "to"?: unknown;
  "reason": string;
}

export interface SearchProductImage {
  "url": string;
  "alt"?: string;
}

export interface SearchProductPrice {
  "amount": number;
  "currency": string;
  "tier"?: string;
}

export interface SearchProduct {
  "public_id"?: string;
  "slug"?: string;
  "title": string;
  "description"?: string;
  "category"?: string;
  "tags"?: Array<string>;
  "images"?: SearchProductImage[];
  "attributes"?: Record<string, string | number>;
  "price"?: SearchProductPrice;
  "availability_band"?: string;
  "lead_time_days"?: number;
  "as_of"?: string;
  "purchasable"?: boolean;
  "product_url"?: string;
  "add_to_cart_url"?: string;
}

export interface SearchPagination {
  "limit": number;
  "cursor": string | null;
  "next_cursor": string | null;
  "has_more": boolean;
}

export interface SearchScope {
  "plan_complete": boolean;
  "scope_exhausted": boolean;
  "global_catalog_exhaustive": boolean;
  "scan_limit_reached": boolean;
  "degraded": boolean;
  "degraded_reason": string | null;
}

export interface SearchCompatibility {
  "adapter": "product_search_v1";
  "legacy_status": string;
}

export interface SearchNormalizedIntent {
  product_identity: SearchProductIdentityCondition;
  hard_constraints: SearchExplicitHardConstraint[];
  soft_context: SearchSoftContextCondition[];
  transaction_context: SearchTransactionCondition[];
}

export interface SearchContractV2Response {
  contract_version: "2.0";
  trace_id: string;
  status: "results" | "needs_clarification" | "no_match" | "degraded";
  normalized_intent: SearchNormalizedIntent;
  relaxations: SearchRelaxation[];
  missing_criteria: string[];
  results: SearchProduct[];
  pagination: SearchPagination;
  search_scope: SearchScope;
  compatibility?: SearchCompatibility;
}
