import path from "node:path";
import { fileURLToPath } from "node:url";

import { createShopifyReadOnlyProvider, shopifyConfigFromEnvironment } from "./shopify-provider.mjs";
import { startSandbox } from "./server.mjs";

const DEFAULT_PORT = 8787;

export async function startVerifiedShopifySandbox(options = {}) {
  const provider = options.provider || createShopifyReadOnlyProvider({
    ...shopifyConfigFromEnvironment(options.environment || {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const status = await provider.getStatus({ force: true });
  if (!status.verified) return Object.freeze({ status, sandbox: null });
  const sandbox = await startSandbox({
    port: options.port === undefined ? DEFAULT_PORT : options.port,
    host: options.host,
    mode: "shopify_read_only",
    shopifyProvider: provider,
  });
  return Object.freeze({ status, sandbox });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configuredPort = process.env.SANDBOX_PORT ? Number(process.env.SANDBOX_PORT) : DEFAULT_PORT;
  const started = await startVerifiedShopifySandbox({ environment: process.env, port: configuredPort });
  if (!started.sandbox) {
    process.stderr.write(`Shopify read-only sandbox not started: ${started.status.error_code}.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Agent Core Shopify read-only sandbox: ${started.sandbox.baseUrl}/sandbox\n`);
    process.stdout.write("The Storefront credential remains in this server process.\n");
  }
}
