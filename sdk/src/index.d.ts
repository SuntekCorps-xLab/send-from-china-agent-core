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
