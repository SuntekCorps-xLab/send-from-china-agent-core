export const ALPHA_KEY = "key_test_alpha_1234567890";
export const BETA_KEY = "key_test_beta_12345678901";
export const INTERNAL_KEY = "key_test_internal_1234567";

export const ENV = {
  ALLOWED_ORIGINS: "https://app.example.com,http://localhost:8787",
  TENANT_KEYS: JSON.stringify({
    [ALPHA_KEY]: { tenant_id: "tenant_alpha", max_page_size: 5, daily_quota: 100 },
    [BETA_KEY]: { tenant_id: "tenant_beta", max_page_size: 5, daily_quota: 100 },
    [INTERNAL_KEY]: {
      tenant_id: "tenant_internal",
      product_ids: null,
      price_tier: "test",
      allow_full_enumeration: true,
      max_page_size: 20,
      daily_quota: 100,
    },
  }),
};

export function authorization(key = ALPHA_KEY) {
  return { Authorization: `Bearer ${key}` };
}
