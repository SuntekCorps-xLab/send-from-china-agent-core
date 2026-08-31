const BASE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-send-from-china-sandbox-mode": "shopify_read_only",
  "x-send-from-china-sandbox-boundary": "protected; shopify-storefront-read-only; no-commerce-writes",
});

export function withSecurityHeaders(response, contentType = null) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) headers.set(name, value);
  if (contentType) headers.set("content-type", contentType);
  headers.delete("set-cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(value, status = 200) {
  return withSecurityHeaders(new Response(JSON.stringify(value), { status }), "application/json; charset=utf-8");
}

export function error(code, status) {
  return json({ error: { code } }, status);
}
