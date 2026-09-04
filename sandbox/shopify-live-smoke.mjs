import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSearchContractV2Request, projectSearchContractV2Response } from "../sdk/src/search-contract-v2.js";
import { createShopifyReadOnlyProvider, shopifyConfigFromEnvironment } from "./shopify-provider.mjs";
import { validateSandboxStatus } from "./status-contract.mjs";

const QUERY_COUNT = 20;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SAFE_CODES = new Set([
  "CREDENTIAL_MISSING", "AUTHENTICATION_FAILED", "PERMISSION_REQUIRED",
  "QUOTA_EXCEEDED", "SERVICE_UNAVAILABLE",
]);

function parseCases(value) {
  if (!Array.isArray(value) || value.length !== QUERY_COUNT) throw new TypeError("INVALID_KNOWN_QUERY_MANIFEST");
  const identities = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["query", "hard_constraints", "expected_handles"].includes(key))
      || typeof entry.query !== "string" || !entry.query.trim() || entry.query.length > 200
      || !Array.isArray(entry.expected_handles) || !entry.expected_handles.length || entry.expected_handles.length > 20
      || entry.expected_handles.some((handle) => typeof handle !== "string" || !/^[a-z0-9-]{1,100}$/u.test(handle))
      || new Set(entry.expected_handles).size !== entry.expected_handles.length) throw new TypeError("INVALID_KNOWN_QUERY_MANIFEST");
    const request = parseSearchContractV2Request({
      contract_version: "2.0",
      product_identity: { name: "product_identity", value: entry.query.trim(), source: "explicit", scope: "product", hardness: "hard" },
      hard_constraints: entry.hard_constraints ?? [], soft_context: [], transaction_context: [], limit: 20, cursor: null,
    });
    const identity = JSON.stringify([request.product_identity.value.toLowerCase(), request.hard_constraints]);
    if (identities.has(identity)) throw new TypeError("INVALID_KNOWN_QUERY_MANIFEST");
    identities.add(identity);
    return { request, expectedHandles: entry.expected_handles };
  });
}

function receipt(state, fields = {}) {
  return Object.freeze({
    schema_version: "1.0", operation: "development_store_known_query_smoke",
    state, writes: false, expected_queries: QUERY_COUNT,
    attempted_queries: 0, passed_queries: 0, failed_queries: 0, cases: [], ...fields,
  });
}

// Reports contain case numbers and public outcomes, never query text, handles,
// domains, credentials, raw responses, or upstream exception messages.
export async function runShopifyKnownQuerySmoke(options = {}) {
  const environment = options.environment || {};
  const writeOutput = typeof options.writeOutput === "function" ? options.writeOutput : () => {};
  function finish(exitCode, report) {
    writeOutput(`${JSON.stringify(report)}\n`);
    return Object.freeze({ exitCode, report });
  }
  if (environment.SHOPIFY_LIVE_SMOKE !== "1") return finish(2, receipt("blocked", { error_code: "LIVE_OPT_IN_REQUIRED" }));
  if (environment.SHOPIFY_DEVELOPMENT_STORE_CONFIRMED !== "1") {
    return finish(2, receipt("blocked", { error_code: "DEVELOPMENT_STORE_CONFIRMATION_REQUIRED" }));
  }
  let cases;
  try { cases = parseCases(options.cases); }
  catch { return finish(2, receipt("blocked", { error_code: "INVALID_KNOWN_QUERY_MANIFEST" })); }
  let provider;
  let status;
  try {
    provider = options.provider || createShopifyReadOnlyProvider({
      ...shopifyConfigFromEnvironment(environment),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    status = await provider.getStatus({ force: true });
    if (!validateSandboxStatus(status) || status.mode !== "shopify_read_only" || !status.verified || status.writes !== false) {
      return finish(1, receipt("blocked", { error_code: SAFE_CODES.has(status?.error_code) ? status.error_code : "SERVICE_UNAVAILABLE" }));
    }
  } catch { return finish(1, receipt("blocked", { error_code: "SERVICE_UNAVAILABLE" })); }
  const outcomes = [];
  for (const [index, entry] of cases.entries()) {
    try {
      const result = projectSearchContractV2Response(await provider.search(entry.request));
      const handles = new Set(result.results.map((product) => product.handle));
      const passed = result.mode === "shopify_read_only" && result.writes === false
        && result.status === "results" && result.search_scope.degraded === false
        && result.relaxations.length === 0 && entry.expectedHandles.every((handle) => handles.has(handle));
      outcomes.push({ case: index + 1, passed, result_count: result.results.length,
        expected_count: entry.expectedHandles.length, error_code: passed ? null : "KNOWN_QUERY_MISMATCH" });
    } catch (cause) {
      outcomes.push({ case: index + 1, passed: false, result_count: 0, expected_count: entry.expectedHandles.length,
        error_code: SAFE_CODES.has(cause?.publicCode) ? cause.publicCode : "SERVICE_UNAVAILABLE" });
    }
  }
  const passed = outcomes.filter((entry) => entry.passed).length;
  return finish(passed === QUERY_COUNT ? 0 : 1, receipt(passed === QUERY_COUNT ? "passed" : "failed", {
    doctor_verified: true, attempted_queries: outcomes.length, passed_queries: passed,
    failed_queries: outcomes.length - passed, cases: outcomes,
  }));
}

async function main() {
  let cases;
  // Only read an explicitly selected manifest after both live gates are open.
  if (process.env.SHOPIFY_LIVE_SMOKE === "1" && process.env.SHOPIFY_DEVELOPMENT_STORE_CONFIRMED === "1") {
    try {
      const selected = process.env.SHOPIFY_KNOWN_QUERY_MANIFEST;
      if (typeof selected !== "string" || !selected) throw new TypeError("Missing manifest");
      const bytes = await readFile(selected);
      if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new TypeError("Oversized manifest");
      cases = JSON.parse(bytes.toString("utf8"));
    } catch { cases = null; }
  }
  const result = await runShopifyKnownQuerySmoke({ environment: process.env, cases, writeOutput: (value) => process.stdout.write(value) });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
