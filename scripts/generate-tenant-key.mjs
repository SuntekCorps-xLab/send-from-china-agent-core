import { randomBytes } from "node:crypto";

const tenantId = String(process.argv[2] || "tenant_local").trim();
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(tenantId)) {
  process.stderr.write("Usage: npm run tenant:key -- <tenant_id>\n");
  process.exitCode = 1;
} else {
  const tenantKey = `key_${randomBytes(24).toString("base64url")}`;
  const tenantConfig = { tenant_id: tenantId, max_page_size: 5, daily_quota: 100 };
  process.stdout.write(`${JSON.stringify({
    tenant_key: tenantKey,
    tenant_keys_json: JSON.stringify({ [tenantKey]: tenantConfig }),
    warning: "Store this value in a secret manager. Never commit it.",
  }, null, 2)}\n`);
}
