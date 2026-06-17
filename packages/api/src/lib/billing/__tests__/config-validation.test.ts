/**
 * Tests for the pure billing-config validation primitives (#3435).
 *
 * Network-free: no Stripe SDK, no Layer DAG. The live price-resolution +
 * livemode comparison lives in `BillingConfigGuardLive` and is exercised by
 * `effect/__tests__/saas-guards.test.ts`.
 */

import { describe, it, expect } from "bun:test";

import {
  MONTHLY_PRICE_ID_ENV_VARS,
  ANNUAL_PRICE_ID_ENV_VARS,
  findMissingMonthlyPriceIdEnvVars,
  findMissingMonthlyPriceIds,
  detectStripeKeyMode,
  isPriceModeConsistent,
} from "@atlas/api/lib/billing/config-validation";

describe("billing/config-validation", () => {
  describe("MONTHLY_PRICE_ID_ENV_VARS", () => {
    it("enumerates the three paid-tier monthly price vars", () => {
      expect([...MONTHLY_PRICE_ID_ENV_VARS]).toEqual([
        "STRIPE_STARTER_PRICE_ID",
        "STRIPE_PRO_PRICE_ID",
        "STRIPE_BUSINESS_PRICE_ID",
      ]);
    });

    it("is disjoint from the annual vars", () => {
      for (const monthly of MONTHLY_PRICE_ID_ENV_VARS) {
        expect(ANNUAL_PRICE_ID_ENV_VARS).not.toContain(monthly);
      }
    });
  });

  describe("findMissingMonthlyPriceIdEnvVars", () => {
    it("returns all three when env is empty", () => {
      expect(findMissingMonthlyPriceIdEnvVars({})).toEqual([
        "STRIPE_STARTER_PRICE_ID",
        "STRIPE_PRO_PRICE_ID",
        "STRIPE_BUSINESS_PRICE_ID",
      ]);
    });

    it("returns empty when all three monthly vars are set", () => {
      expect(
        findMissingMonthlyPriceIdEnvVars({
          STRIPE_STARTER_PRICE_ID: "price_a",
          STRIPE_PRO_PRICE_ID: "price_b",
          STRIPE_BUSINESS_PRICE_ID: "price_c",
        }),
      ).toEqual([]);
    });

    it("flags only the missing tier", () => {
      expect(
        findMissingMonthlyPriceIdEnvVars({
          STRIPE_STARTER_PRICE_ID: "price_a",
          STRIPE_BUSINESS_PRICE_ID: "price_c",
        }),
      ).toEqual(["STRIPE_PRO_PRICE_ID"]);
    });

    it("treats an empty string as missing", () => {
      expect(
        findMissingMonthlyPriceIdEnvVars({
          STRIPE_STARTER_PRICE_ID: "",
          STRIPE_PRO_PRICE_ID: "price_b",
          STRIPE_BUSINESS_PRICE_ID: "price_c",
        }),
      ).toEqual(["STRIPE_STARTER_PRICE_ID"]);
    });

    it("does NOT require the optional annual vars", () => {
      expect(
        findMissingMonthlyPriceIdEnvVars({
          STRIPE_STARTER_PRICE_ID: "price_a",
          STRIPE_PRO_PRICE_ID: "price_b",
          STRIPE_BUSINESS_PRICE_ID: "price_c",
          // every annual var deliberately absent
        }),
      ).toEqual([]);
    });
  });

  describe("findMissingMonthlyPriceIds (settings-aware, #3703)", () => {
    it("returns all three when the resolver finds nothing", () => {
      expect(findMissingMonthlyPriceIds(() => undefined)).toEqual([
        "STRIPE_STARTER_PRICE_ID",
        "STRIPE_PRO_PRICE_ID",
        "STRIPE_BUSINESS_PRICE_ID",
      ]);
    });

    it("returns empty when the resolver supplies all three", () => {
      const store: Record<string, string> = {
        STRIPE_STARTER_PRICE_ID: "price_a",
        STRIPE_PRO_PRICE_ID: "price_b",
        STRIPE_BUSINESS_PRICE_ID: "price_c",
      };
      expect(findMissingMonthlyPriceIds((k) => store[k])).toEqual([]);
    });

    it("flags only the tier the resolver leaves unset (e.g. settings supply the rest)", () => {
      const store: Record<string, string> = {
        STRIPE_STARTER_PRICE_ID: "price_a",
        STRIPE_BUSINESS_PRICE_ID: "price_c",
      };
      expect(findMissingMonthlyPriceIds((k) => store[k])).toEqual(["STRIPE_PRO_PRICE_ID"]);
    });

    it("treats an empty string from the resolver as missing", () => {
      const store: Record<string, string> = {
        STRIPE_STARTER_PRICE_ID: "",
        STRIPE_PRO_PRICE_ID: "price_b",
        STRIPE_BUSINESS_PRICE_ID: "price_c",
      };
      expect(findMissingMonthlyPriceIds((k) => store[k])).toEqual(["STRIPE_STARTER_PRICE_ID"]);
    });
  });

  describe("detectStripeKeyMode", () => {
    it("classifies a standard test key", () => {
      expect(detectStripeKeyMode("sk_test_abc123")).toBe("test");
    });

    it("classifies a standard live key", () => {
      expect(detectStripeKeyMode("sk_live_abc123")).toBe("live");
    });

    it("returns unknown for undefined / null / empty", () => {
      expect(detectStripeKeyMode(undefined)).toBe("unknown");
      expect(detectStripeKeyMode(null)).toBe("unknown");
      expect(detectStripeKeyMode("")).toBe("unknown");
    });

    it("returns unknown for restricted, publishable, or typo keys", () => {
      expect(detectStripeKeyMode("rk_live_abc")).toBe("unknown");
      expect(detectStripeKeyMode("pk_test_abc")).toBe("unknown");
      expect(detectStripeKeyMode("whatever")).toBe("unknown");
    });
  });

  describe("isPriceModeConsistent", () => {
    it("live key pairs with a livemode price", () => {
      expect(isPriceModeConsistent("live", true)).toBe(true);
      expect(isPriceModeConsistent("live", false)).toBe(false);
    });

    it("test key pairs with a non-livemode price", () => {
      expect(isPriceModeConsistent("test", false)).toBe(true);
      expect(isPriceModeConsistent("test", true)).toBe(false);
    });

    it("unknown key mode is never consistent", () => {
      expect(isPriceModeConsistent("unknown", true)).toBe(false);
      expect(isPriceModeConsistent("unknown", false)).toBe(false);
    });
  });
});
