/**
 * Settings-backed Stripe price resolution (#3703).
 *
 * `getStripePlans()` / `resolvePlanTierFromPriceId()` resolve the six price IDs
 * through `getSettingAuto` (platform settings → env → default, hot-reloadable in
 * SaaS) rather than reading `process.env` directly. These tests mock the
 * settings module so we can assert resolution goes through the registry and that
 * a settings value WINS over a divergent env var — the property that makes a
 * pricing change take effect without a redeploy.
 *
 * The env-fallback tier is covered by `plans.test.ts` (no settings mock there,
 * so `getSettingAuto` falls through to `process.env`).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Mutable backing store for the mocked settings registry. Keyed by setting key.
let settingValues: Record<string, string | undefined> = {};
void mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) => settingValues[key],
}));

const { getStripePlans, resolvePlanTierFromPriceId } = await import(
  "@atlas/api/lib/billing/plans"
);

// Ensure no real env var leaks into resolution while the settings mock drives
// the store. (The mock ignores process.env entirely, but a divergence test
// below sets an env var deliberately to prove the settings value wins.)
const PRICE_ENV_KEYS = [
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_STARTER_ANNUAL_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PRO_ANNUAL_PRICE_ID",
  "STRIPE_BUSINESS_PRICE_ID",
  "STRIPE_BUSINESS_ANNUAL_PRICE_ID",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  settingValues = {};
  savedEnv = {};
  for (const key of PRICE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PRICE_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

describe("billing/plans settings-backed resolution (#3703)", () => {
  describe("getStripePlans", () => {
    it("returns empty when no price IDs resolve from settings", () => {
      expect(getStripePlans()).toEqual([]);
    });

    it("builds a plan from a settings-resolved price ID", () => {
      settingValues = { STRIPE_STARTER_PRICE_ID: "price_starter_from_settings" };
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("starter");
      expect(plans[0].priceId).toBe("price_starter_from_settings");
      expect(plans[0].seatPriceId).toBe("price_starter_from_settings");
    });

    it("picks up the annual discount price ID from settings", () => {
      settingValues = {
        STRIPE_PRO_PRICE_ID: "price_pro",
        STRIPE_PRO_ANNUAL_PRICE_ID: "price_pro_annual",
      };
      const plans = getStripePlans();
      expect(plans[0].annualDiscountPriceId).toBe("price_pro_annual");
    });

    it("a settings value WINS over a divergent env var (hot-reload property)", () => {
      // Env says one thing, settings override says another — the override
      // (Admin → Settings) is authoritative, so a price change needs no redeploy.
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_from_env";
      settingValues = { STRIPE_BUSINESS_PRICE_ID: "price_from_settings" };
      const business = getStripePlans().find((p) => p.name === "business");
      expect(business?.priceId).toBe("price_from_settings");
    });

    it("resolves all three tiers when all settings are present", () => {
      settingValues = {
        STRIPE_STARTER_PRICE_ID: "price_s",
        STRIPE_PRO_PRICE_ID: "price_p",
        STRIPE_BUSINESS_PRICE_ID: "price_b",
      };
      expect(getStripePlans().map((p) => p.name)).toEqual(["starter", "pro", "business"]);
    });
  });

  describe("resolvePlanTierFromPriceId", () => {
    it("maps a settings-resolved monthly price ID back to its tier", () => {
      settingValues = { STRIPE_PRO_PRICE_ID: "price_pro_settings" };
      expect(resolvePlanTierFromPriceId("price_pro_settings")).toBe("pro");
    });

    it("maps a settings-resolved annual price ID back to its tier", () => {
      settingValues = {
        STRIPE_BUSINESS_PRICE_ID: "price_biz",
        STRIPE_BUSINESS_ANNUAL_PRICE_ID: "price_biz_annual",
      };
      expect(resolvePlanTierFromPriceId("price_biz_annual")).toBe("business");
    });

    it("returns null for a price ID that matches no configured tier", () => {
      settingValues = { STRIPE_STARTER_PRICE_ID: "price_s" };
      expect(resolvePlanTierFromPriceId("price_unknown")).toBeNull();
    });
  });
});
