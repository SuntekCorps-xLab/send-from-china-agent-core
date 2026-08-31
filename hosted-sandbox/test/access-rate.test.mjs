import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSameOrigin, authorizeInvite } from "../src/access.js";
import { createRateLimitGate } from "../src/rate-limit.js";
import { INVITE, inviteHash } from "./helpers.mjs";

test("invite verification is hash-pinned and rejects missing or malformed configuration", async () => {
  const request = new Request("https://sandbox.example/sandbox/status", { headers: { "x-sandbox-invite": INVITE } });
  assert.equal(await authorizeInvite(request, { SANDBOX_ACCESS_MODE: "protected", SANDBOX_INVITE_SHA256: inviteHash() }), true);
  assert.equal(await authorizeInvite(request, { SANDBOX_ACCESS_MODE: "open", SANDBOX_INVITE_SHA256: inviteHash() }), false);
  assert.equal(await authorizeInvite(request, { SANDBOX_ACCESS_MODE: "protected", SANDBOX_INVITE_SHA256: "0".repeat(64) }), false);
  assert.equal(await authorizeInvite(new Request(request.url), {
    SANDBOX_ACCESS_MODE: "protected", SANDBOX_INVITE_SHA256: inviteHash(),
  }), false);
});

test("same-origin boundary accepts hosted HTTPS and loopback HTTP only", () => {
  assert.equal(assertSameOrigin(new Request("https://sandbox.example/sandbox/status", {
    headers: { origin: "https://sandbox.example", "sec-fetch-site": "same-origin" },
  })), true);
  assert.equal(assertSameOrigin(new Request("http://127.0.0.1:8787/sandbox/status")), true);
  assert.equal(assertSameOrigin(new Request("http://public.example/sandbox/status")), false);
  assert.equal(assertSameOrigin(new Request("https://sandbox.example/sandbox/status", {
    headers: { origin: "https://other.example" },
  })), false);
});

test("public rate limiting fails closed without a valid binding or configuration", async () => {
  for (const env of [
    { SANDBOX_DEPLOYMENT_MODE: "public", SANDBOX_RATE_LIMIT_LIMIT: "60", SANDBOX_RATE_LIMIT_PERIOD: "60" },
    { SANDBOX_DEPLOYMENT_MODE: "public", SANDBOX_RATE_LIMIT_LIMIT: "bad", SANDBOX_RATE_LIMIT_PERIOD: "60", SANDBOX_RATE_LIMITER: { limit() {} } },
    { SANDBOX_DEPLOYMENT_MODE: "preview", SANDBOX_RATE_LIMIT_LIMIT: "60", SANDBOX_RATE_LIMIT_PERIOD: "60", SANDBOX_RATE_LIMITER: { limit() {} } },
  ]) {
    const gate = createRateLimitGate(env);
    assert.equal(gate.configured, false);
    assert.equal(await gate.allow("actor"), false);
  }
  const denied = createRateLimitGate({
    SANDBOX_DEPLOYMENT_MODE: "public",
    SANDBOX_RATE_LIMIT_LIMIT: "60",
    SANDBOX_RATE_LIMIT_PERIOD: "60",
    SANDBOX_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  assert.equal(denied.configured, true);
  assert.equal(await denied.allow("actor"), false);
});
