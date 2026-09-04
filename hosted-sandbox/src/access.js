const INVITE_HEADER = "x-sandbox-invite";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", ["127", "0", "0", "1"].join("."), "[::1]"]);

function validInvite(value) {
  return typeof value === "string"
    && value.length >= 20
    && value.length <= 256
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertSameOrigin(request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin" || fetchSite === "none";
}

export async function authorizeInvite(request, env) {
  if (env.SANDBOX_ACCESS_MODE !== "protected") return false;
  const expected = String(env.SANDBOX_INVITE_SHA256 || "").toLowerCase();
  const supplied = request.headers.get(INVITE_HEADER);
  if (!HEX_SHA256.test(expected) || !validInvite(supplied)) return false;
  return constantTimeEqual(await sha256(supplied), expected);
}

export const inviteHeaderName = INVITE_HEADER;
