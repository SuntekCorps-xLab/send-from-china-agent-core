import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../governance-worker/src/index.js";

const LOOPBACK = ["127", "0", "0", "1"].join(".");
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 32 * 1024;
const SANDBOX_PREFIX = "/sandbox";
const root = path.dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/sandbox", ["index.html", "text/html; charset=utf-8"]],
  ["/sandbox/", ["index.html", "text/html; charset=utf-8"]],
  ["/sandbox/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/sandbox/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const SAFE_EXACT_ROUTES = new Map([
  ["GET /.well-known/send-from-china.json", false],
  ["GET /health", false],
  ["GET /api/search", true],
  ["POST /api/search/v2", true],
  ["POST /api/quote", true],
  ["POST /api/chat", true],
  ["POST /mcp", true],
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

function localOrigin(server, host = LOOPBACK) {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function isLoopbackHost(host) {
  return [LOOPBACK, "localhost", "::1"].includes(String(host || ""));
}

function guardServerListen(server) {
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const first = args[0];
    const host = first && typeof first === "object" && !Array.isArray(first)
      ? first.host
      : (typeof args[1] === "string" ? args[1] : "");
    if (!isLoopbackHost(host)) {
      throw new TypeError("The local sandbox requires an explicit loopback listen address.");
    }
    return listen(...args);
  };
  return server;
}

function sandboxEnvironment(token) {
  return {
    TENANT_KEYS: JSON.stringify({
      [token]: {
        tenant_id: "tenant_alpha",
        max_page_size: 5,
        daily_quota: 10000,
        allow_full_enumeration: false,
      },
    }),
  };
}

function securityHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-type": contentType,
  };
}

function sandboxBoundaryHeaders() {
  return {
    "x-send-from-china-sandbox-mode": "synthetic_local_sandbox",
    "x-send-from-china-sandbox-boundary": "synthetic-fixture; no-shipping-rates; no-commerce-writes",
  };
}

const PURCHASE_EVIDENCE_KEYS = new Set([
  "add_to_cart_url", "cart_url", "checkout_url", "order_url", "payment_url",
  "product_url", "purchase_url", "supplier_url", "url",
]);

function sandboxDescriptor() {
  return {
    mode: "synthetic_local_sandbox",
    data_source: "synthetic_fixture",
    illustrative_only: true,
    purchasable: false,
    available: false,
  };
}

function isProduct(value) {
  return value && typeof value === "object"
    && typeof value.public_id === "string"
    && typeof value.title === "string";
}

function isQuote(value) {
  return value && typeof value === "object"
    && (value.quote_kind === "catalog_estimate" || typeof value.quote_id === "string");
}

function conservativeSandboxProjection(value) {
  if (Array.isArray(value)) return value.map(conservativeSandboxProjection);
  if (!value || typeof value !== "object") return value;
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (PURCHASE_EVIDENCE_KEYS.has(key) || /(?:purchase|cart|checkout|order|payment)_url$/i.test(key)) continue;
    if (key === "images" && isProduct(value)) {
      projected.images = [];
      continue;
    }
    projected[key] = conservativeSandboxProjection(child);
  }
  if (isProduct(value)) {
    Object.assign(projected, sandboxDescriptor(), { availability_band: "demo_only" });
  }
  if (isQuote(value)) {
    Object.assign(projected, sandboxDescriptor(), { availability: "demo_only", binding: false });
  }
  if (value.match_status === "illustrative_only" || value.illustrative_only === true) {
    Object.assign(projected, sandboxDescriptor(), { availability: "demo_only" });
  }
  return projected;
}

function sandboxDiscovery(body) {
  return {
    ...body,
    ...sandboxDescriptor(),
    mcp: {
      ...(body.mcp || {}),
      path: "/sandbox/mcp",
      discovery_auth_required: false,
      tool_auth: "local_server_injected_ephemeral_scope",
    },
    registration: {
      required: false,
      self_service: false,
      key_provisioning: "local_process_ephemeral",
    },
    canonical_deployment: { mcp_path: "/mcp", tool_auth: "bearer_tenant_key" },
  };
}

function sandboxMcp(body) {
  const projected = conservativeSandboxProjection(body);
  if (projected?.result?.protocolVersion && projected.result?.serverInfo) {
    projected.result.instructions = "Local synthetic sandbox: connect to /sandbox/mcp without supplying a tenant credential. Tool calls receive an ephemeral tenant scope inside this loopback process. Results are illustrative and non-purchasable. A canonical /mcp deployment still requires a bearer tenant credential.";
    projected.result.sandbox = {
      ...sandboxDescriptor(),
      mcp_path: "/sandbox/mcp",
      tool_auth: "local_server_injected_ephemeral_scope",
      canonical_deployment: { mcp_path: "/mcp", tool_auth: "bearer_tenant_key" },
    };
  }
  const toolResult = projected?.result;
  if (toolResult?.structuredContent && Array.isArray(toolResult.content)) {
    for (const block of toolResult.content) {
      if (block?.type === "text") block.text = JSON.stringify(toolResult.structuredContent);
    }
  }
  return projected;
}

function sandboxResponseBody(pathname, body) {
  if (pathname === "/.well-known/send-from-china.json") return sandboxDiscovery(body);
  if (pathname === "/mcp") return sandboxMcp(body);
  return { ...conservativeSandboxProjection(body), ...sandboxDescriptor() };
}

function sendJson(response, body, status = 200, extraHeaders = {}) {
  response.writeHead(status, { ...securityHeaders("application/json; charset=utf-8"), ...extraHeaders });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), tooLarge };
}

function requestHeaders(request, token = "") {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function sendWorkerResponse(response, workerResponse, sandboxMode = false, pathname = "") {
  const headers = {};
  for (const [name, value] of workerResponse.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  if (sandboxMode) Object.assign(headers, sandboxBoundaryHeaders());
  const contents = Buffer.from(await workerResponse.arrayBuffer());
  if (sandboxMode && String(headers["content-type"] || "").includes("application/json")) {
    try {
      const body = sandboxResponseBody(pathname, JSON.parse(contents.toString("utf8")));
      response.writeHead(workerResponse.status, headers);
      response.end(JSON.stringify(body));
      return;
    } catch {
      sendJson(response, { error: { code: "SANDBOX_RESPONSE_INVALID" } }, 500, sandboxBoundaryHeaders());
      return;
    }
  }
  response.writeHead(workerResponse.status, headers);
  response.end(contents);
}

function safeSandboxTarget(method, sourceUrl) {
  const pathname = sourceUrl.pathname.slice(SANDBOX_PREFIX.length) || "/";
  const exact = SAFE_EXACT_ROUTES.get(`${method} ${pathname}`);
  if (exact !== undefined) return { pathname, injectToken: exact };
  if (method === "GET" && /^\/api\/products\/[a-z0-9-]{1,100}$/.test(pathname)) {
    return { pathname, injectToken: true };
  }
  return null;
}

function isCanonicalWorkerRoute(pathname) {
  return pathname === "/health"
    || pathname === "/.well-known/send-from-china.json"
    || pathname === "/mcp"
    || pathname.startsWith("/api/");
}

async function serveStatic(response, asset) {
  try {
    const [filename, contentType] = asset;
    const contents = await readFile(path.join(root, filename));
    response.writeHead(200, securityHeaders(contentType));
    response.end(contents);
  } catch {
    sendJson(response, { error: { code: "SANDBOX_ASSET_NOT_FOUND" } }, 404);
  }
}

export function createSandboxServer(options = {}) {
  const token = String(options.token || randomBytes(32).toString("base64url"));
  if (token.length < 24) throw new TypeError("The sandbox token must contain at least 24 characters.");
  const environment = sandboxEnvironment(token);
  const configuredHost = String(options.host || LOOPBACK);

  const server = createServer(async (request, response) => {
    try {
      const method = String(request.method || "GET").toUpperCase();
      const origin = localOrigin(server, configuredHost);
      const sourceUrl = new URL(request.url || "/", origin);
      const browserSandbox = sourceUrl.pathname.startsWith(`${SANDBOX_PREFIX}/`);
      const asset = method === "GET" ? STATIC_ASSETS.get(sourceUrl.pathname) : null;
      if (asset) {
        await serveStatic(response, asset);
        return;
      }

      if (method === "GET" && sourceUrl.pathname === "/sandbox/status") {
        sendJson(response, {
          mode: "synthetic_local_sandbox",
          data_source: "synthetic_fixture",
          purchasable: false,
          shipping_rates: false,
          commerce_writes: false,
          credential_exposed: false,
        }, 200, sandboxBoundaryHeaders());
        return;
      }

      const body = await readBody(request);
      if (body.tooLarge) {
        sendJson(response, { error: { code: "PAYLOAD_TOO_LARGE" } }, 413, browserSandbox ? sandboxBoundaryHeaders() : {});
        return;
      }

      let targetPath = sourceUrl.pathname;
      let injectedToken = "";
      const sandboxMode = browserSandbox;
      if (sandboxMode) {
        const target = safeSandboxTarget(method, sourceUrl);
        if (!target) {
          sendJson(response, { error: { code: "SANDBOX_ROUTE_NOT_ALLOWED" } }, 404, sandboxBoundaryHeaders());
          return;
        }
        targetPath = target.pathname;
        if (target.injectToken) injectedToken = token;
      } else if (!isCanonicalWorkerRoute(sourceUrl.pathname)) {
        sendJson(response, { error: { code: "NOT_FOUND" } }, 404);
        return;
      }

      const targetUrl = new URL(`${targetPath}${sourceUrl.search}`, origin);
      const init = { method, headers: requestHeaders(request, injectedToken) };
      if (body.body.length && method !== "GET" && method !== "HEAD") init.body = body.body;
      const workerRequest = new Request(targetUrl, init);
      const workerResponse = await worker.fetch(workerRequest, {
        ...environment,
        ALLOWED_ORIGINS: origin,
      });
      await sendWorkerResponse(response, workerResponse, sandboxMode, targetPath);
    } catch {
      const sandboxMode = String(request.url || "").startsWith(`${SANDBOX_PREFIX}/`);
      sendJson(response, { error: { code: "SANDBOX_INTERNAL_ERROR" } }, 500, sandboxMode ? sandboxBoundaryHeaders() : {});
    }
  });
  guardServerListen(server);

  Object.defineProperties(server, {
    sandboxToken: { value: token, enumerable: false },
    sandboxMode: { value: "synthetic_local_sandbox", enumerable: true },
  });
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startSandbox(options = {}) {
  const host = String(options.host || LOOPBACK);
  if (!isLoopbackHost(host)) {
    throw new TypeError("The local sandbox can bind only to a loopback address.");
  }
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("The sandbox port is invalid.");
  const server = createSandboxServer({ ...options, host });
  await listen(server, port, host);
  const baseUrl = localOrigin(server, host);
  const close = () => new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
  return Object.freeze({
    server,
    baseUrl,
    token: server.sandboxToken,
    mode: server.sandboxMode,
    browserCredentialExposed: false,
    close,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configuredPort = process.env.SANDBOX_PORT ? Number(process.env.SANDBOX_PORT) : DEFAULT_PORT;
  const sandbox = await startSandbox({ port: configuredPort });
  process.stdout.write(`Agent Core synthetic sandbox: ${sandbox.baseUrl}/sandbox\n`);
  process.stdout.write("The ephemeral tenant credential remains in this process.\n");
}
