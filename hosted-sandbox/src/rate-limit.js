function positiveInteger(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isInteger(number) && number > 0 && number <= maximum ? number : null;
}

export function createRateLimitGate(env) {
  const deploymentMode = String(env.SANDBOX_DEPLOYMENT_MODE || "");
  const limit = positiveInteger(env.SANDBOX_RATE_LIMIT_LIMIT, 60, 10_000);
  const period = positiveInteger(env.SANDBOX_RATE_LIMIT_PERIOD, 60, 60);
  const binding = env.SANDBOX_RATE_LIMITER;
  const configured = Boolean(["public", "test"].includes(deploymentMode)
    && limit !== null
    && (period === 10 || period === 60)
    && binding && typeof binding.limit === "function");

  return Object.freeze({
    configured,
    quota: Object.freeze({
      limit: limit || 0,
      remaining: 0,
      window_seconds: period || 0,
      concurrency_limit: 0,
      reset_at: null,
    }),
    async allow(key) {
      if (deploymentMode !== "public" && deploymentMode !== "test") return false;
      if (!configured) return false;
      try {
        const outcome = await binding.limit({ key });
        return outcome && outcome.success === true;
      } catch {
        return false;
      }
    },
  });
}
