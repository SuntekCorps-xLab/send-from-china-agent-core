import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createSandboxBrowserClient } from "../browser-client.mjs";
import { syntheticSandboxStatus } from "../status-contract.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("browser client is loopback-only and forces credentialless no-store requests", async () => {
  const calls = [];
  const status = syntheticSandboxStatus("2026-08-31T00:00:00.000Z");
  const client = createSandboxBrowserClient({
    origin: `http://${["127", "0", "0", "1"].join(".")}:8787`,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(status);
    },
  });
  await client.requestJson("/sandbox/status", {
    credentials: "include",
    cache: "force-cache",
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/sandbox/status");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("authorization"), null);
  assert.equal(calls[0].init.headers.get("cookie"), null);
});

test("browser client allows hosted HTTPS but rejects public HTTP, cross-origin, and non-sandbox targets", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(syntheticSandboxStatus("2026-08-31T00:00:00.000Z")); };
  for (const origin of [
    "http://example.com",
    `http://${["10", "0", "0", "8"].join(".")}:8787`,
    "ftp://localhost:8787",
  ]) {
    const client = createSandboxBrowserClient({ origin, fetchImpl });
    await assert.rejects(client.getStatus(), /loopback HTTP or hosted HTTPS/);
  }

  const hosted = createSandboxBrowserClient({ origin: "https://sandbox.example", fetchImpl });
  await hosted.getStatus();
  assert.equal(calls, 1);

  const local = createSandboxBrowserClient({ origin: "http://localhost:8787", fetchImpl });
  for (const target of [
    "https://example.com/sandbox/status",
    "//example.com/sandbox/status",
    "/api/search",
    "/health",
  ]) {
    await assert.rejects(local.requestJson(target), /local sandbox/);
  }
  assert.equal(calls, 1);
});

test("hosted browser client keeps an invite proof in memory and sends it only same-origin", async () => {
  const calls = [];
  const client = createSandboxBrowserClient({
    origin: "https://sandbox.example",
    inviteToken: "invite-proof-with-enough-entropy-123456",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(syntheticSandboxStatus("2026-08-31T00:00:00.000Z"));
    },
  });
  await client.getStatus();
  assert.equal(calls[0].url, "https://sandbox.example/sandbox/status");
  assert.equal(calls[0].init.headers.get("x-sandbox-invite"), "invite-proof-with-enough-entropy-123456");
  await assert.rejects(client.requestJson("https://other.example/sandbox/status"), /local sandbox/);
  assert.equal(calls.length, 1);
});

test("browser client rejects all credential and mode authority headers before fetch", async () => {
  let calls = 0;
  const client = createSandboxBrowserClient({
    origin: "http://[::1]:8787",
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });
  for (const header of [
    "authorization",
    "cookie",
    "set-cookie",
    "x-shopify-access-token",
    "x-shopify-storefront-access-token",
    "x-sandbox-mode",
    "x-shopify-sandbox-mode",
    "x-sandbox-invite",
  ]) {
    await assert.rejects(client.requestJson("/sandbox/status", {
      headers: { [header]: "browser-secret" },
    }), /credentials are not accepted/);
  }
  assert.equal(calls, 0);
});

test("browser status validation rejects unknown root, quota, and capability fields", async () => {
  const base = syntheticSandboxStatus("2026-08-31T00:00:00.000Z");
  const invalidStatuses = [
    { ...base, unknown: true },
    { ...base, quota: { ...base.quota, unknown: true } },
    { ...base, capabilities: { ...base.capabilities, unknown: true } },
  ];
  for (const invalid of invalidStatuses) {
    const client = createSandboxBrowserClient({
      origin: "http://localhost:8787",
      fetchImpl: async () => jsonResponse(invalid),
    });
    await assert.rejects(client.getStatus(), /SANDBOX_STATUS_INVALID/);
  }
});

test("browser assets contain no credential storage or external resource path", async () => {
  const names = ["index.html", "app.js", "styles.css", "browser-client.mjs", "status-contract.mjs"];
  const contents = await Promise.all(names.map((name) => readFile(new URL(`../${name}`, import.meta.url), "utf8")));
  const source = contents.join("\n");
  assert.doesNotMatch(source, /document\.cookie|localStorage|sessionStorage|indexedDB|cookieStore|CacheStorage|globalThis\.caches|navigator\.storage|serviceWorker/iu);
  assert.doesNotMatch(source, /https?:\/\/|(?:src|href)\s*=\s*["']\/\//iu);
  assert.doesNotMatch(contents[2], /@import|url\s*\(/iu);
});
