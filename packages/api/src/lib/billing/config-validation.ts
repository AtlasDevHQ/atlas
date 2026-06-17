/**
 * Pure, network-free billing-config validation primitives (#3435).
 *
 * These back the boot-time `BillingConfigGuardLive` SaaS guard in
 * `lib/effect/saas-guards.ts`. They are kept here — beside `plans.ts`, the
 * single source of truth for which `STRIPE_*_PRICE_ID` env vars map to a plan
 * tier — and free of any Stripe SDK / network dependency so they can be unit
 * tested in isolation (no Layer DAG, no live Stripe account).
 *
 * Two classes of misconfig are detectable without touching Stripe and so are
 * checked here:
 *
 *   1. **Missing monthly price IDs.** `getStripePlans()` (`plans.ts`) silently
 *      omits a tier whose monthly `STRIPE_{STARTER,PRO,BUSINESS}_PRICE_ID` is
 *      unset — the plan never appears in checkout and the region looks healthy.
 *      {@link findMissingMonthlyPriceIds} (settings-aware, #3703) /
 *      {@link findMissingMonthlyPriceIdEnvVars} (pure env) name the absent
 *      keys. Since #3703 these are operator-actionable boot WARNINGS, not boot
 *      crashes — the price IDs are runtime-editable platform settings.
 *
 *   2. **Secret-key mode.** `sk_test_…` vs `sk_live_…` is the only test/live
 *      signal available locally — a Stripe *price* ID (`price_…`) carries no
 *      mode in its string. {@link detectStripeKeyMode} extracts the key's mode
 *      so the guard can (a) reject a malformed/restricted key shape at boot and
 *      (b) hand the expected mode to the network-resolution warn-path, which
 *      compares it against each resolved price's `livemode`.
 *
 * The "do these price IDs actually exist in the configured account, and does
 * each price's `livemode` match the key mode?" check is inherently a network
 * call and lives in the guard (a loud warn, never a boot crash — a Stripe
 * outage must not wedge boot). It is NOT here because it isn't pure.
 */

/** Monthly price-ID env var for each paid tier — the SSOT `getStripePlans()` reads. */
export const MONTHLY_PRICE_ID_ENV_VARS = [
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_BUSINESS_PRICE_ID",
] as const;

/** Annual (discount) price-ID env vars. Optional — absence is not a misconfig. */
export const ANNUAL_PRICE_ID_ENV_VARS = [
  "STRIPE_STARTER_ANNUAL_PRICE_ID",
  "STRIPE_PRO_ANNUAL_PRICE_ID",
  "STRIPE_BUSINESS_ANNUAL_PRICE_ID",
] as const;

export type MonthlyPriceIdEnvVar = (typeof MONTHLY_PRICE_ID_ENV_VARS)[number];

/**
 * Return the subset of {@link MONTHLY_PRICE_ID_ENV_VARS} that resolve to a
 * missing (undefined or empty-string) value through `resolve` (#3703).
 *
 * Price IDs are now platform-scoped SETTINGS (registry-backed, env-fallback,
 * hot-reloadable) rather than env-only, so the boot guard resolves them via
 * `getSettingAuto` instead of reading `process.env` directly — a price set
 * only in the Admin console must NOT register as missing. This is the
 * settings-aware sibling of {@link findMissingMonthlyPriceIdEnvVars}: same
 * empty-string-counts-as-missing semantics, but the lookup is injected so the
 * function stays pure and unit-testable with a stub resolver.
 */
export function findMissingMonthlyPriceIds(
  resolve: (settingKey: MonthlyPriceIdEnvVar) => string | undefined,
): MonthlyPriceIdEnvVar[] {
  return MONTHLY_PRICE_ID_ENV_VARS.filter((key) => {
    const value = resolve(key);
    return value === undefined || value === "";
  });
}

/**
 * Stripe secret-key mode, derived from the `sk_test_` / `sk_live_` prefix.
 *
 *   - `"test"` / `"live"` — a well-formed standard secret key.
 *   - `"unknown"` — anything else: empty, a restricted key (`rk_…`, whose mode
 *     isn't encoded in the prefix), a publishable key pasted by mistake
 *     (`pk_…`), or an outright typo. The guard treats `"unknown"` as a
 *     fail-fast boot error: a SaaS region must run on a standard secret key
 *     whose mode we can pin against resolved prices.
 */
export type StripeKeyMode = "test" | "live" | "unknown";

/**
 * Return the subset of {@link MONTHLY_PRICE_ID_ENV_VARS} that are unset or
 * empty in `env`. An empty string counts as missing — Stripe never issues an
 * empty price ID, and `getStripePlans()` would push a plan with `priceId: ""`
 * that 400s at checkout.
 *
 * Annual price IDs are intentionally excluded: they are an optional discount
 * lever, and `getStripePlans()` passes `annualDiscountPriceId: undefined`
 * cleanly when unset.
 */
export function findMissingMonthlyPriceIdEnvVars(
  env: Record<string, string | undefined> = process.env,
): MonthlyPriceIdEnvVar[] {
  return MONTHLY_PRICE_ID_ENV_VARS.filter((key) => {
    const value = env[key];
    return value === undefined || value === "";
  });
}

/**
 * Classify a Stripe secret key by its mode prefix. See {@link StripeKeyMode}
 * for the `"unknown"` semantics. The check is prefix-only and never logs or
 * echoes the key (it is a secret — callers pass it but it never reaches a log
 * line or error message).
 */
export function detectStripeKeyMode(
  secretKey: string | undefined | null,
): StripeKeyMode {
  if (typeof secretKey !== "string" || secretKey.length === 0) return "unknown";
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return "unknown";
}

/**
 * Whether a resolved Stripe price's `livemode` is consistent with the secret
 * key's mode. `livemode === true` ⇒ the price lives in the live account, which
 * must pair with an `sk_live_` key; `false` ⇒ test account ⇒ `sk_test_`.
 *
 * Returns `false` (inconsistent) whenever `keyMode === "unknown"` — a key whose
 * mode we can't determine can't be proven consistent with anything. Callers
 * that reach this function have already passed the boot-time key-shape gate, so
 * in practice `keyMode` is `"test"` or `"live"`; the `"unknown"` branch is a
 * defensive total-function fallback.
 */
export function isPriceModeConsistent(
  keyMode: StripeKeyMode,
  priceLivemode: boolean,
): boolean {
  if (keyMode === "live") return priceLivemode === true;
  if (keyMode === "test") return priceLivemode === false;
  return false;
}
