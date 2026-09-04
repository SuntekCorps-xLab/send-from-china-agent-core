import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createShopifyReadOnlyProvider,
  SHOPIFY_STOREFRONT_API_VERSION,
  shopifyConfigFromEnvironment,
} from "./shopify-provider.mjs";
import { shopifySandboxStatus } from "./status-contract.mjs";

export async function runShopifyDoctor(options = {}) {
  const environment = options.environment || {};
  const args = Array.isArray(options.args) ? options.args : [];
  const json = args.includes("--json");
  const unsupported = args.filter((argument) => argument !== "--json");
  const writeOutput = typeof options.writeOutput === "function" ? options.writeOutput : () => {};
  const writeError = typeof options.writeError === "function" ? options.writeError : () => {};
  if (unsupported.length) {
    writeError("Shopify sandbox doctor rejected an unsupported argument.\n");
    return Object.freeze({ exitCode: 2, status: null });
  }
  let status;
  try {
    const provider = options.provider || createShopifyReadOnlyProvider({
      ...shopifyConfigFromEnvironment(environment),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
      ...(options.quotaLimit ? { quotaLimit: options.quotaLimit } : {}),
      ...(options.quotaWindowMs ? { quotaWindowMs: options.quotaWindowMs } : {}),
      ...(options.concurrencyLimit ? { concurrencyLimit: options.concurrencyLimit } : {}),
      readinessTtlMs: 0,
    });
    status = await provider.getStatus({ force: true });
  } catch {
    status = shopifySandboxStatus({
      verified: false,
      credential_state: "service_unavailable",
      api_version: SHOPIFY_STOREFRONT_API_VERSION,
      quota: { limit: 0, remaining: 0, window_seconds: 0, concurrency_limit: 0, reset_at: null },
      checked_at: new Date().toISOString(),
      error_code: "SERVICE_UNAVAILABLE",
    });
  }
  if (json) writeOutput(`${JSON.stringify(status)}\n`);
  else if (status.verified) writeOutput("Shopify read-only sandbox doctor: succeeded.\n");
  else writeError(`Shopify read-only sandbox doctor: ${status.error_code}.\n`);
  return Object.freeze({ exitCode: status.verified ? 0 : 1, status });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runShopifyDoctor({
    environment: process.env,
    args: process.argv.slice(2),
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
  process.exitCode = result.exitCode;
}
