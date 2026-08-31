import {
  createShopifyReadOnlyProvider,
  shopifyConfigFromEnvironment,
} from "./shopify-provider.mjs";

if (process.env.SHOPIFY_LIVE_SMOKE !== "1") {
  process.stderr.write("Shopify live smoke requires explicit SHOPIFY_LIVE_SMOKE=1 opt-in.\n");
  process.exitCode = 2;
} else {
  const provider = createShopifyReadOnlyProvider({
    ...shopifyConfigFromEnvironment(process.env),
    readinessTtlMs: 0,
  });
  const status = await provider.getStatus({ force: true });
  if (!status.verified) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    process.exitCode = 1;
  } else {
    const result = await provider.search({
      contract_version: "2.0",
      product_identity: {
        name: "product_identity",
        value: String(process.env.SHOPIFY_LIVE_SMOKE_QUERY || "product").slice(0, 100),
        source: "explicit",
        scope: "product",
        hardness: "hard"
      },
      hard_constraints: [],
      soft_context: [],
      transaction_context: [],
      limit: 1,
      cursor: null
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: status.mode,
      verified: status.verified,
      writes: false,
      result_count: result.results.length
    })}\n`);
  }
}
