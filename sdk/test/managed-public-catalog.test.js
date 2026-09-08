import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGED_PUBLIC_CATALOG,
  ManagedPublicCatalogError,
  createManagedPublicCatalogClient,
} from "../src/index.js";
import {
  managedMcpSdkFlow,
  selfHostedHttpFlow,
  selfHostedMcpSdkFlow,
} from "../../examples/catalog-read-profiles.mjs";

function response(body, options = {}) {
  const value = new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: options.status || 200,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  Object.defineProperty(value, "url", { value: options.url ?? MANAGED_PUBLIC_CATALOG.endpoint });
  Object.defineProperty(value, "redirected", { value: options.redirected === true });
  return value;
}

function streamedResponse(stream, options = {}) {
  const value = new Response(stream, {
    status: options.status || 200,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  Object.defineProperty(value, "url", { value: options.url ?? MANAGED_PUBLIC_CATALOG.endpoint });
  Object.defineProperty(value, "redirected", { value: options.redirected === true });
  return value;
}

function tools() {
  const readTools = MANAGED_PUBLIC_CATALOG.tools.map((name) => ({
    name,
    description: `Fixture schema for ${name}`,
    inputSchema: name === "get_product"
      ? {
          type: "object",
          properties: { handle: { type: "string" } },
          required: ["handle"],
          additionalProperties: false,
        }
      : name === "product_search"
        ? {
            type: "object",
            properties: {
              query: { type: "string" },
              criteria: { type: "object" },
              mode: { type: "string", enum: ["catalog", "recommendations"], default: "catalog" },
              operation: { type: "string", enum: ["search", "confirm_search", "more"], default: "search" },
              limit: { type: "integer" },
              cursor: { type: "string" },
            },
          }
        : { type: "object", properties: {} },
  }));
  return [...readTools, ...[
    "create_product_request",
    "get_agent_access",
    "create_sourcing_task",
    "get_sourcing_task",
    "list_sourcing_results",
    "request_storylab_governance",
  ].map((name) => ({
    name,
    description: "Authenticated tool deliberately unavailable in this SDK profile.",
    inputSchema: { type: "object", properties: {} },
  }))];
}

function searchProduct(overrides = {}) {
  return {
    title: "Verified public desk organizer",
    handle: "verified-desk-organizer",
    price_usd: 29.95,
    currency: "USD",
    url: "https://sendfromchina.ai/products/verified-desk-organizer",
    image: "https://cdn.example.com/verified-desk-organizer.jpg",
    summary: "Published storefront fixture.",
    why: "Matches the requested catalog criteria.",
    available: true,
    catalog_available: true,
    purchasable: false,
    purchase_status: "verification_required",
    market_compatibility: {
      status: "review_required",
      review_required: true,
      country: "US",
      reason: "Checkout remains the source of market truth.",
    },
    commercial_review_required: true,
    ...overrides,
  };
}

function detailProduct(overrides = {}) {
  return {
    title: "Verified public desk organizer",
    handle: "verified-desk-organizer",
    url: "https://sendfromchina.ai/products/verified-desk-organizer",
    price: 29.95,
    currency: "USD",
    price_usd: 29.95,
    image: "https://cdn.example.com/verified-desk-organizer.jpg",
    summary: "Published storefront fixture.",
    catalog_available: true,
    purchasable: false,
    purchase_status: "verification_required",
    cart_verification_required: true,
    ...overrides,
  };
}

function search(overrides = {}) {
  return {
    contract_version: "2.0",
    trace_id: "fixture-trace",
    normalized_intent: {
      product_identity: {
        name: "product_identity", value: "desk organizer", source: "explicit", scope: "product", hardness: "hard",
      },
      hard_constraints: [],
      soft_context: [],
      transaction_context: [],
    },
    relaxations: [],
    search_id: "fixture-search-proof",
    criteria: {
      category: "", use_case: "", audience: "", age_min: null, age_max: null,
      price_min: null, price_max: null, price_flexible: false, quantity: 1,
      ship_to: "", delivery_days_max: null, colors: [], materials: [], must_have: [],
      exclude: [], keywords: [],
    },
    mode: "catalog",
    status: "results",
    action: "results",
    results: [searchProduct()],
    count: 1,
    has_more: false,
    next_cursor: null,
    exhaustive: true,
    search_scope_exhausted: true,
    degraded: false,
    retrieval_incomplete: false,
    pagination: { limit: 5, cursor: null, next_cursor: null, has_more: false },
    search_scope: {
      plan_complete: true,
      scope_exhausted: true,
      global_catalog_exhaustive: false,
      scan_limit_reached: false,
      degraded: false,
      degraded_reason: null,
    },
    ...overrides,
  };
}

function managedFixture(overrides = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    if (overrides.fetch) return overrides.fetch({ url: String(url), init, body, calls });
    let result;
    if (body.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "world-products", version: "1.0.0" },
      };
    } else if (body.method === "tools/list") {
      result = { tools: overrides.tools || tools() };
    } else if (body.params?.name === "product_search") {
      result = {
        content: [{ type: "text", text: "fixture search" }],
        structuredContent: overrides.search || search(),
        isError: false,
      };
    } else if (body.params?.name === "get_product") {
      result = {
        content: [{ type: "text", text: "fixture product" }],
        structuredContent: overrides.product || detailProduct(),
        isError: false,
      };
    } else {
      throw new Error("Unexpected fixture request");
    }
    return response({ jsonrpc: "2.0", id: body.id, result });
  };
  return { fetch, calls };
}

test("managed profile discovers the fixed anonymous read surface before search and detail", async () => {
  const fixture = managedFixture();
  const client = createManagedPublicCatalogClient({ fetch: fixture.fetch });

  const discovery = await client.ready();
  const found = await client.productSearch({ query: "desk organizer", operation: "search", limit: 5 });
  const detail = await client.getProduct({ handle: found.products[0].handle });
  const handoff = client.resolvePurchaseHandoff(detail);

  assert.equal(found.products[0].handle, "verified-desk-organizer");
  assert.equal(detail.catalog_available, true);
  assert.deepEqual(discovery.tools, MANAGED_PUBLIC_CATALOG.tools);
  assert.deepEqual(handoff, {
    kind: "product",
    url: "https://sendfromchina.ai/products/verified-desk-organizer",
    requires_user: true,
  });
  assert.deepEqual(fixture.calls.map((call) => call.body.method), [
    "initialize", "tools/list", "tools/call", "tools/call",
  ]);
  assert.equal(fixture.calls[2].body.params.name, "product_search");
  assert.deepEqual(fixture.calls[3].body.params.arguments, { handle: "verified-desk-organizer" });

  for (const call of fixture.calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(call.url, MANAGED_PUBLIC_CATALOG.endpoint);
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.cache, "no-store");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.get("cache-control"), "no-store");
  }
  assert.equal(new Headers(fixture.calls[0].init.headers).has("mcp-protocol-version"), false);
  assert.equal(new Headers(fixture.calls[1].init.headers).get("mcp-protocol-version"), "2025-06-18");
});

test("managed projection drops proofs, raw request text, variants, and evidence records", async () => {
  const fixture = managedFixture({
    search: search({ request_query: "raw buyer text" }),
    product: detailProduct({
      product_type: "fixture",
      fact_evidence: [{ basis: "fixture", field: "price", value: "29.95" }],
      variants: [{
        variant_id: "internal-variant-id",
        title: "Fixture variant",
        price: 29.95,
        currency: "USD",
        price_usd: 29.95,
        available: true,
        catalog_available: true,
        purchasable: false,
        purchase_status: "verification_required",
        options: { Style: "Fixture" },
        add_to_cart_url: null,
      }],
      note: "raw detail note",
    }),
  });
  const client = createManagedPublicCatalogClient({ fetch: fixture.fetch });
  const found = await client.productSearch({ query: "desk" });
  const detail = await client.getProduct({ handle: found.products[0].handle });
  const publicText = JSON.stringify({ found, detail });
  assert.doesNotMatch(publicText, /raw buyer|fixture-search-proof|internal-variant-id|raw detail note/iu);
  assert.equal(found.boundary.writes, false);
  assert.equal("availableForSale" in detail, false);
  assert.equal("shopify_verified_at" in detail, false);
});

test("managed profile cannot be switched to an arbitrary endpoint or credential", () => {
  assert.throws(() => createManagedPublicCatalogClient({ baseUrl: "https://elsewhere.example" }), /Unsupported/u);
  assert.throws(() => createManagedPublicCatalogClient({ token: "must-not-be-accepted" }), /Unsupported/u);
  const client = createManagedPublicCatalogClient({ fetch: async () => response({}) });
  assert.equal("createSourcingTask" in client, false);
  assert.equal("getQuote" in client, false);
  assert.equal("callTool" in client, false);
});

test("managed profile accepts the verified read-only confirmation wire and rejects unknown operations", async () => {
  let calls = 0;
  const client = createManagedPublicCatalogClient({ fetch: async () => { calls += 1; return response({}); } });
  await assert.rejects(client.productSearch({ query: "desk", operation: "mutation" }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(client.getProduct({ slug: "verified-desk-organizer" }), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(calls, 0);
});

test("managed profile fails closed when discovery loses a read tool or changes handle schema", async () => {
  for (const toolList of [
    tools().filter((entry) => entry.name !== "browse_catalog"),
    tools().map((entry) => entry.name === "get_product"
      ? { ...entry, inputSchema: { type: "object", properties: { slug: {} }, required: ["slug"], additionalProperties: false } }
      : entry),
  ]) {
    const fixture = managedFixture({ tools: toolList });
    const client = createManagedPublicCatalogClient({ fetch: fixture.fetch });
    await assert.rejects(client.ready(), { code: "INVALID_RESPONSE" });
    assert.deepEqual(fixture.calls.map((call) => call.body.method), ["initialize", "tools/list"]);
  }
});

test("managed profile rejects unknown fields and noncanonical product URLs", async () => {
  for (const unsafeProduct of [
    searchProduct({ vendor: "private supplier" }),
    searchProduct({ url: "https://evil.example/products/verified-desk-organizer" }),
    searchProduct({ url: "https://sendfromchina.ai/products/different-handle" }),
    searchProduct({ url: "https://sendfromchina.ai/products/verified-desk-organizer?variant=secret" }),
  ]) {
    const fixture = managedFixture({ search: search({ results: [unsafeProduct] }) });
    const client = createManagedPublicCatalogClient({ fetch: fixture.fetch });
    await assert.rejects(client.productSearch({ query: "desk" }), { code: "INVALID_RESPONSE" });
  }
});

test("managed profile rejects redirects, oversized bodies, invalid JSON, and quota errors", async () => {
  const cases = [
    {
      expected: "INVALID_RESPONSE",
      response: (body) => response({ jsonrpc: "2.0", id: body.id, result: {} }, {
        redirected: true,
        url: "https://redirect.example/mcp",
      }),
    },
    {
      expected: "RESPONSE_TOO_LARGE",
      response: () => response("{}", { headers: { "content-length": String(600 * 1024) } }),
    },
    { expected: "RESPONSE_TOO_LARGE", response: () => response("x".repeat(600 * 1024)) },
    { expected: "INVALID_RESPONSE", response: () => response("not-json") },
    {
      expected: "QUOTA_EXCEEDED",
      response: (body) => response({
        jsonrpc: "2.0", id: body.id, error: { code: "raw-private-code", message: "credential=must-not-leak" },
      }, { status: 429, headers: { "retry-after": "credential=must-not-leak" } }),
    },
  ];
  for (const current of cases) {
    let calls = 0;
    const client = createManagedPublicCatalogClient({
      fetch: async (_url, init) => {
        calls += 1;
        return current.response(JSON.parse(init.body));
      },
    });
    await assert.rejects(client.ready(), (error) => {
      assert.ok(error instanceof ManagedPublicCatalogError);
      assert.equal(error.code, current.expected);
      assert.doesNotMatch(String(error), /credential|raw-private/iu);
      assert.equal(error.retryAfter, "");
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("managed profile cancels a chunked body as soon as limit plus one byte is observed", async () => {
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array((256 * 1024) + 1));
    },
    cancel() { canceled = true; },
  });
  const client = createManagedPublicCatalogClient({ fetch: async () => streamedResponse(stream) });
  await assert.rejects(client.ready(), { code: "RESPONSE_TOO_LARGE" });
  assert.equal(canceled, true);
});

test("managed profile enforces timeout and pre-aborted requests with injected fetch", async () => {
  for (const fetch of [
    async () => new Promise(() => {}),
    async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: MANAGED_PUBLIC_CATALOG.endpoint,
      headers: new Headers({ "content-type": "application/json" }),
      arrayBuffer: async () => new Promise(() => {}),
    }),
    async () => streamedResponse(new ReadableStream({ pull: async () => new Promise(() => {}) })),
  ]) {
    const timeoutClient = createManagedPublicCatalogClient({ timeoutMs: 5, fetch });
    await assert.rejects(timeoutClient.ready(), { code: "REQUEST_TIMEOUT" });
  }

  let calls = 0;
  const controller = new AbortController();
  controller.abort("credential=must-not-leak");
  const abortedClient = createManagedPublicCatalogClient({
    fetch: async () => { calls += 1; return response({}); },
  });
  await assert.rejects(abortedClient.ready({ signal: controller.signal }), (error) => {
    assert.equal(error.code, "REQUEST_ABORTED");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.doesNotMatch(String(error), /credential|must-not-leak/iu);
    return true;
  });
  assert.equal(calls, 0);
});

test("managed profile counts query limits by Unicode code point", async () => {
  const fixture = managedFixture();
  const client = createManagedPublicCatalogClient({ fetch: fixture.fetch });
  const query = "😀".repeat(300);
  await client.productSearch({ query });
  assert.equal(fixture.calls[2].body.params.arguments.query, query);

  let calls = 0;
  const rejectingClient = createManagedPublicCatalogClient({
    fetch: async () => { calls += 1; return response({}); },
  });
  await assert.rejects(rejectingClient.productSearch({ query: "😀".repeat(301) }), { code: "INVALID_ARGUMENT" });
  assert.equal(calls, 0);
});

test("managed profile keeps synthetic and malformed handoffs closed", () => {
  const client = createManagedPublicCatalogClient({ fetch: async () => response({}) });
  assert.equal(client.resolvePurchaseHandoff({ handle: "synthetic-product" }), null);
  assert.equal(client.resolvePurchaseHandoff({
    handle: "verified-desk-organizer",
    product_url: "http://sendfromchina.ai/products/verified-desk-organizer",
  }), null);
});

test("managed profile enforces its per-client concurrency cap", async () => {
  let release;
  const fixture = managedFixture({
    fetch: ({ body }) => {
      if (body.method === "initialize") {
        return response({ jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.2.0" },
        } });
      }
      if (body.method === "tools/list") {
        return response({ jsonrpc: "2.0", id: body.id, result: { tools: tools() } });
      }
      return new Promise((resolve) => {
        release = () => resolve(response({ jsonrpc: "2.0", id: body.id, result: {
          content: [{ type: "text", text: "fixture" }],
          structuredContent: search(),
          isError: false,
        } }));
      });
    },
  });
  const client = createManagedPublicCatalogClient({ fetch: fixture.fetch, maxConcurrency: 1 });
  await client.ready();
  const first = client.productSearch({ query: "desk" });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(client.getProduct({ handle: "verified-desk-organizer" }), { code: "CONCURRENCY_LIMIT" });
  release();
  await first;
});

test("documented managed MCP SDK flow is executable with injected fixtures", async () => {
  const fixture = managedFixture();
  const result = await managedMcpSdkFlow("desk organizer", { fetch: fixture.fetch });
  assert.equal(result.profile, "hosted_managed_public_mcp");
  assert.equal(result.product.handle, "verified-desk-organizer");
  assert.equal(result.purchaseHandoff.kind, "product");
  assert.deepEqual(fixture.calls[2].body.params.arguments, {
    query: "desk organizer",
    mode: "catalog",
    operation: "confirm_search",
    limit: 5,
  });
});

test("documented managed flow handles a truthful terminal miss without product detail", async () => {
  const fixture = managedFixture({
    search: search({
      status: "no_match",
      action: "sourcing",
      results: [],
      count: 0,
      has_more: false,
      next_cursor: null,
      exhaustive: true,
      search_scope_exhausted: true,
      degraded: false,
      retrieval_incomplete: false,
    }),
  });
  const result = await managedMcpSdkFlow("not in catalog", { fetch: fixture.fetch });
  assert.equal(result.search.status, "no_match");
  assert.equal(result.product, null);
  assert.equal(result.purchaseHandoff, null);
  assert.equal(fixture.calls.length, 3);
});

test("documented self-hosted MCP SDK flow uses slug and tenant authorization", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    const value = body.params.name === "product_search"
      ? {
          status: "catalog_match",
          products: [{ slug: "fixture-product" }],
          count: 1,
        }
      : {
          title: "Self-hosted fixture",
          slug: "fixture-product",
          product_url: "https://shop.example/products/fixture-product",
        };
    return response({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: "fixture" }], structuredContent: value, isError: false },
    }, { url: String(url) });
  };
  const result = await selfHostedMcpSdkFlow("desk", {
    baseUrl: "https://agent.example.test",
    token: "fixture-tenant-token",
    commerceOrigins: ["https://shop.example"],
    fetch,
  });
  assert.equal(result.profile, "self_hosted_authenticated_mcp");
  assert.deepEqual(calls.map((call) => call.body.params.arguments), [
    { query: "desk", operation: "search", limit: 5 },
    { slug: "fixture-product" },
  ]);
  assert.ok(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer fixture-tenant-token"));
  assert.equal(result.purchaseHandoff.url, "https://shop.example/products/fixture-product");
});

test("documented self-hosted HTTP flow uses search v2 then product slug", async () => {
  const calls = [];
  const normalizedIntent = {
    product_identity: {
      name: "product_identity", value: "desk", source: "explicit", scope: "product", hardness: "hard",
    },
    hard_constraints: [],
    soft_context: [],
    transaction_context: [],
  };
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/search/v2")) {
      return response({
        contract_version: "2.0",
        trace_id: "fixture-trace",
        status: "results",
        normalized_intent: normalizedIntent,
        relaxations: [],
        missing_criteria: [],
        results: [{
          title: "HTTP fixture",
          slug: "fixture-product",
          product_url: "https://shop.example/products/fixture-product",
        }],
        pagination: { limit: 5, cursor: null, next_cursor: null, has_more: false },
        search_scope: {
          plan_complete: true,
          scope_exhausted: true,
          global_catalog_exhaustive: false,
          scan_limit_reached: false,
          degraded: false,
          degraded_reason: null,
        },
      }, { url: String(url) });
    }
    return response({
      title: "HTTP fixture",
      slug: "fixture-product",
      product_url: "https://shop.example/products/fixture-product",
    }, { url: String(url) });
  };
  const result = await selfHostedHttpFlow({ product_identity: "desk", limit: 5 }, {
    baseUrl: "http://127.0.0.1:8787",
    token: "fixture-tenant-token",
    commerceOrigins: ["https://shop.example"],
    fetch,
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:8787/api/search/v2",
    "http://127.0.0.1:8787/api/products/fixture-product",
  ]);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer fixture-tenant-token");
  assert.equal(result.purchaseHandoff.kind, "product");
});
