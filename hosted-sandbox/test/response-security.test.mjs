import assert from "node:assert/strict";
import { test } from "node:test";
import { withSecurityHeaders } from "../src/responses.js";

test("Shopify images are restricted to the exact CDN without broadening script or API egress", () => {
  const response = withSecurityHeaders(new Response("fixture", {
    headers: { "set-cookie": "untrusted=fixture", "content-security-policy": "default-src *" },
  }));
  const directives = new Map(response.headers.get("content-security-policy").split(";")
    .map((value) => value.trim().split(/\s+/u)).filter(([name]) => name).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get("img-src"), ["'self'", "data:", "https://cdn.shopify.com"]);
  for (const name of ["connect-src", "script-src", "style-src", "font-src"]) {
    assert.deepEqual(directives.get(name), ["'self'"]);
  }
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});