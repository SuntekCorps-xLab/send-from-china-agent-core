import type {
  NormalizedSearchContractV2Request,
  PublicProductAttributeName,
  SearchContractV2Request,
  SearchContractV2Response,
  SearchContractV2WireRequest,
  SearchRelaxation,
} from "./search-contract-v2.types.generated.js";

export type {
  NormalizedSearchContractV2Request,
  PublicProductAttributeName,
  SearchCondition,
  SearchConditionHardness,
  SearchConditionScope,
  SearchConditionSource,
  SearchConditionValue,
  SearchContractV2Request,
  SearchContractV2Response,
  SearchContractV2WireRequest,
  SearchExplicitHardConstraint,
  SearchHardTransactionCondition,
  SearchInformationalTransactionCondition,
  SearchNormalizedIntent,
  SearchPagination,
  SearchProduct,
  SearchProductIdentityCondition,
  SearchProductImage,
  SearchProductPrice,
  SearchRelaxation,
  SearchScope,
  SearchSoftContextCondition,
  SearchTransactionCondition,
} from "./search-contract-v2.types.generated.js";

export interface SendFromChinaClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  commerceOrigins?: string[];
}

export interface ManagedPublicCatalogClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
}

export type ManagedPublicCatalogErrorCode =
  | "INVALID_ARGUMENT" | "INVALID_RESPONSE" | "REQUEST_ABORTED" | "REQUEST_TIMEOUT"
  | "RESPONSE_TOO_LARGE" | "CONCURRENCY_LIMIT" | "QUOTA_EXCEEDED"
  | "SERVICE_UNAVAILABLE" | "NETWORK_ERROR" | "DISCOVERY_REQUIRED";

export interface ManagedPublicCatalogHandoff {
  kind: "product";
  url: string;
  requires_user: true;
}

export interface ManagedPublicProduct {
  title: string;
  handle: string;
  price: { amount: number; currency: string };
  product_url: string;
  image_url?: string;
  summary?: string;
  catalog_available: boolean;
  purchasable: boolean;
  purchase_status: string;
  available?: boolean;
  commercial_review_required?: boolean;
  cart_verification_required?: boolean;
  market_compatibility?: {
    status: string;
    review_required: boolean;
    country: string;
    reason: string;
  };
}

export interface ManagedPublicSearchResponse {
  status: "results" | "needs_clarification" | "no_match" | "degraded";
  action: string;
  mode: "catalog" | "recommendations";
  products: readonly ManagedPublicProduct[];
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  exhaustive: boolean;
  search_scope_exhausted: boolean;
  degraded: boolean;
  retrieval_incomplete: boolean;
  boundary: { writes: false; transaction: "public_product_link_only" };
}

export interface ManagedPublicCatalogClient {
  ready(options?: { signal?: AbortSignal }): Promise<{
    endpoint: "https://wp-api.sendfromchina.ai/mcp";
    protocolVersion: "2025-06-18";
    tools: readonly string[];
    anonymous: true;
    writes: false;
  }>;
  productSearch(args: {
    query?: string;
    criteria?: Record<string, unknown>;
    mode?: "catalog" | "recommendations";
    operation?: "search" | "confirm_search" | "more";
    limit?: number;
    cursor?: string;
  }, options?: { signal?: AbortSignal }): Promise<ManagedPublicSearchResponse>;
  getProduct(args: { handle: string }, options?: { signal?: AbortSignal }): Promise<ManagedPublicProduct>;
  resolvePurchaseHandoff(product: ManagedPublicProduct | Record<string, unknown>): ManagedPublicCatalogHandoff | null;
}

export type SearchValidationField =
  | "request" | "contract_version" | "product_identity" | "hard_constraints"
  | "soft_context" | "transaction_context" | "limit" | "cursor" | "condition";
export type SearchValidationReason =
  | "invalid_type" | "missing_required" | "unknown_field" | "unsupported_value"
  | "invalid_format" | "out_of_range" | "not_normalized" | "cursor_mismatch" | "invalid_value";

export interface SendFromChinaClient {
  getCapabilities(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  listTools(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>[]>;
  getAgentAccess(args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  productSearch(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  searchContractV2(request: SearchContractV2Request, options?: {
    signal?: AbortSignal;
  }): Promise<SearchContractV2Response>;
  searchContractV2ViaV1(request: SearchContractV2Request, options?: {
    operation?: "search" | "confirm_search" | "more";
    signal?: AbortSignal;
  }): Promise<SearchContractV2Response>;
  searchCatalog(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  getProduct(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  getQuote(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  createSourcingTask(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  getSourcingTask(taskId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  listSourcingResults(taskId: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  waitForSourcingTask(taskId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  listAllSourcingResults(taskId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  resolvePurchaseHandoff(product: Record<string, unknown>): { kind: string; url: string; requires_user: true } | null;
}

export declare const SEARCH_CONTRACT_VERSION: "2.0";
export declare const PUBLIC_ATTRIBUTE_POLICY_VERSION: "public-product-attributes/v1";
export declare const PUBLIC_ATTRIBUTE_NAMES: readonly PublicProductAttributeName[];
export declare const SEARCH_VALIDATION_FIELDS: readonly SearchValidationField[];
export declare const SEARCH_VALIDATION_REASONS: readonly SearchValidationReason[];
export declare class SearchContractValidationError extends TypeError {
  field: SearchValidationField;
  reason: SearchValidationReason;
}
export declare function projectSearchContractV2Response(value: Record<string, unknown>): SearchContractV2Response;
export declare function normalizeSearchContractV2Request(value: SearchContractV2Request): NormalizedSearchContractV2Request;
export declare function parseSearchContractV2Request(value: SearchContractV2WireRequest): NormalizedSearchContractV2Request;
export declare function adaptSearchContractV2RequestToV1(value: SearchContractV2Request, options?: {
  operation?: "search" | "confirm_search" | "more";
}): {
  request: NormalizedSearchContractV2Request;
  arguments: Record<string, unknown>;
  relaxations: SearchRelaxation[];
};
export declare function adaptSearchContractV1ResponseToV2(value: Record<string, unknown>, context: {
  request: SearchContractV2Request;
  relaxations?: SearchRelaxation[];
  traceId?: string;
}): SearchContractV2Response;
export declare function createSearchContractV1Adapter(): {
  normalizeRequest: typeof normalizeSearchContractV2Request;
  toV1Arguments: typeof adaptSearchContractV2RequestToV1;
  fromV1Response: typeof adaptSearchContractV1ResponseToV2;
};

export declare class SendFromChinaError extends Error {
  code: string;
  status: number | null;
  requestId: string;
  retryAfter: string;
  searchField: SearchValidationField | null;
  searchReason: SearchValidationReason | null;
}

export declare function resolvePurchaseHandoff(product: Record<string, unknown>, options?: {
  commerceOrigins?: string[];
}): { kind: string; url: string; requires_user: true } | null;
export declare function createSendFromChinaClient(options: SendFromChinaClientOptions): SendFromChinaClient;
export declare const MANAGED_PUBLIC_CATALOG: Readonly<{
  endpoint: "https://wp-api.sendfromchina.ai/mcp";
  storefrontOrigin: "https://sendfromchina.ai";
  protocolVersion: "2025-06-18";
  tools: readonly string[];
  writes: false;
}>;
export declare class ManagedPublicCatalogError extends Error {
  code: ManagedPublicCatalogErrorCode;
  status: number | null;
  retryAfter: string;
}
export declare function createManagedPublicCatalogClient(
  options?: ManagedPublicCatalogClientOptions,
): ManagedPublicCatalogClient;
