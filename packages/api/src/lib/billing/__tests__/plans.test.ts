/**
 * Tests for billing plan definitions and limits.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  getPlanDefinition,
  getPlanLimits,
  isUnlimited,
  computeTokenBudget,
  getStripePlans,
  resolvePlanTierFromPriceId,
} from "@atlas/api/lib/billing/plans";

describe("billing/plans", () => {
  describe("getPlanDefinition", () => {
    it("returns definition for all tiers", () => {
      for (const tier of ["free", "trial", "starter", "pro", "business"] as const) {
        const def = getPlanDefinition(tier);
        expect(def.name).toBe(tier);
        expect(def.displayName).toBeTruthy();
        expect(def.limits).toBeDefined();
        expect(def.features).toBeDefined();
      }
    });

    it("free tier has unlimited limits", () => {
      const limits = getPlanLimits("free");
      expect(isUnlimited(limits.tokenBudgetPerSeat)).toBe(true);
      expect(isUnlimited(limits.maxSeats)).toBe(true);
      expect(isUnlimited(limits.maxConnections)).toBe(true);
    });

    it("business tier has unlimited seats and connections", () => {
      const limits = getPlanLimits("business");
      expect(isUnlimited(limits.maxSeats)).toBe(true);
      expect(isUnlimited(limits.maxConnections)).toBe(true);
      expect(isUnlimited(limits.tokenBudgetPerSeat)).toBe(false);
      expect(limits.tokenBudgetPerSeat).toBe(15_000_000);
    });

    it("trial tier has same limits as starter", () => {
      const trial = getPlanLimits("trial");
      const starter = getPlanLimits("starter");
      expect(trial.tokenBudgetPerSeat).toBe(starter.tokenBudgetPerSeat);
      expect(trial.maxSeats).toBe(starter.maxSeats);
      expect(trial.maxConnections).toBe(starter.maxConnections);
    });

    it("starter tier has finite limits", () => {
      const limits = getPlanLimits("starter");
      expect(isUnlimited(limits.tokenBudgetPerSeat)).toBe(false);
      expect(limits.tokenBudgetPerSeat).toBe(2_000_000);
      expect(limits.maxSeats).toBe(10);
      expect(limits.maxConnections).toBe(1);
    });

    it("pro tier has expected limits", () => {
      const limits = getPlanLimits("pro");
      expect(limits.tokenBudgetPerSeat).toBe(5_000_000);
      expect(limits.maxSeats).toBe(25);
      expect(limits.maxConnections).toBe(3);
    });

    it("trial definition includes trialDays", () => {
      const def = getPlanDefinition("trial");
      expect(def.trialDays).toBe(14);
    });

    it("plan definitions include pricing and model info", () => {
      expect(getPlanDefinition("starter").pricePerSeat).toBe(29);
      expect(getPlanDefinition("pro").pricePerSeat).toBe(59);
      expect(getPlanDefinition("business").pricePerSeat).toBe(99);
      expect(getPlanDefinition("starter").defaultModel).toBe("claude-haiku-4-5");
      expect(getPlanDefinition("pro").defaultModel).toBe("claude-sonnet-4-6");
      expect(getPlanDefinition("business").defaultModel).toBe("claude-sonnet-4-6");
    });

    it("plan features are tier-appropriate", () => {
      const starter = getPlanDefinition("starter");
      expect(starter.features.customDomain).toBe(false);
      expect(starter.features.sso).toBe(false);

      const pro = getPlanDefinition("pro");
      expect(pro.features.customDomain).toBe(true);
      expect(pro.features.sso).toBe(false);

      const business = getPlanDefinition("business");
      expect(business.features.customDomain).toBe(true);
      expect(business.features.sso).toBe(true);
      expect(business.features.dataResidency).toBe(true);
      expect(business.features.sla).toBe("99.9%");
    });

    it("overage rates decrease with higher tiers", () => {
      expect(getPlanDefinition("starter").overagePerMillionTokens).toBe(1.0);
      expect(getPlanDefinition("pro").overagePerMillionTokens).toBe(0.8);
      expect(getPlanDefinition("business").overagePerMillionTokens).toBe(0.6);
    });
  });

  describe("isUnlimited", () => {
    it("returns true for -1", () => {
      expect(isUnlimited(-1)).toBe(true);
    });

    it("returns false for positive numbers", () => {
      expect(isUnlimited(0)).toBe(false);
      expect(isUnlimited(100)).toBe(false);
      expect(isUnlimited(10_000)).toBe(false);
    });
  });

  describe("computeTokenBudget", () => {
    it("returns -1 (unlimited) for free tier", () => {
      expect(computeTokenBudget("free", 5)).toBe(-1);
    });

    it("scales with seat count for starter tier", () => {
      // 2M per seat
      expect(computeTokenBudget("starter", 1)).toBe(2_000_000);
      expect(computeTokenBudget("starter", 5)).toBe(10_000_000);
      expect(computeTokenBudget("starter", 10)).toBe(20_000_000);
    });

    it("scales with seat count for pro tier", () => {
      // 5M per seat
      expect(computeTokenBudget("pro", 1)).toBe(5_000_000);
      expect(computeTokenBudget("pro", 3)).toBe(15_000_000);
    });

    it("scales with seat count for business tier", () => {
      // 15M per seat
      expect(computeTokenBudget("business", 1)).toBe(15_000_000);
      expect(computeTokenBudget("business", 10)).toBe(150_000_000);
    });

    it("uses minimum of 1 seat", () => {
      expect(computeTokenBudget("starter", 0)).toBe(2_000_000);
      expect(computeTokenBudget("starter", -1)).toBe(2_000_000);
    });
  });

  describe("getStripePlans", () => {
    function cleanStripeEnv() {
      delete process.env.STRIPE_STARTER_PRICE_ID;
      delete process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
      delete process.env.STRIPE_PRO_PRICE_ID;
      delete process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
      delete process.env.STRIPE_BUSINESS_PRICE_ID;
    }
    beforeEach(cleanStripeEnv);
    afterEach(cleanStripeEnv);

    it("returns empty array when no price IDs are set", () => {
      const plans = getStripePlans();
      expect(plans).toEqual([]);
    });

    it("includes starter plan when STRIPE_STARTER_PRICE_ID is set", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_123";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("starter");
      expect(plans[0].priceId).toBe("price_starter_123");
      expect(plans[0].freeTrial).toEqual({ days: 14 });
    });

    it("includes annual price ID when set", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_123";
      process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = "price_starter_annual_456";
      const plans = getStripePlans();
      expect(plans[0].annualDiscountPriceId).toBe("price_starter_annual_456");
    });

    it("includes pro plan when STRIPE_PRO_PRICE_ID is set", () => {
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("pro");
      expect(plans[0].priceId).toBe("price_pro_789");
      expect(plans[0].freeTrial).toBeUndefined();
    });

    it("includes business plan when STRIPE_BUSINESS_PRICE_ID is set", () => {
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("business");
      expect(plans[0].priceId).toBe("price_biz_789");
      expect(plans[0].freeTrial).toBeUndefined();
    });

    it("includes all plans when all price IDs are set", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_123";
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_456";
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(3);
      expect(plans.map((p) => p.name)).toEqual(["starter", "pro", "business"]);
    });
  });

  describe("resolvePlanTierFromPriceId", () => {
    function cleanStripeEnv() {
      delete process.env.STRIPE_STARTER_PRICE_ID;
      delete process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
      delete process.env.STRIPE_PRO_PRICE_ID;
      delete process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
      delete process.env.STRIPE_BUSINESS_PRICE_ID;
    }
    beforeEach(cleanStripeEnv);
    afterEach(cleanStripeEnv);

    it("returns null when no price IDs are configured", () => {
      expect(resolvePlanTierFromPriceId("price_unknown")).toBeNull();
    });

    it("resolves starter monthly price ID", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_monthly";
      expect(resolvePlanTierFromPriceId("price_starter_monthly")).toBe("starter");
    });

    it("resolves starter annual price ID", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_monthly";
      process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = "price_starter_annual";
      expect(resolvePlanTierFromPriceId("price_starter_annual")).toBe("starter");
    });

    it("resolves pro price ID", () => {
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_001";
      expect(resolvePlanTierFromPriceId("price_pro_001")).toBe("pro");
    });

    it("resolves pro annual price ID", () => {
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_monthly";
      process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_annual";
      expect(resolvePlanTierFromPriceId("price_pro_annual")).toBe("pro");
    });

    it("resolves business price ID", () => {
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_001";
      expect(resolvePlanTierFromPriceId("price_biz_001")).toBe("business");
    });

    it("returns null for unrecognized price ID", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_monthly";
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_001";
      expect(resolvePlanTierFromPriceId("price_unknown_999")).toBeNull();
    });

    it("does not match starter annual price when only monthly is set", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_monthly";
      // STRIPE_STARTER_ANNUAL_PRICE_ID is not set
      expect(resolvePlanTierFromPriceId("price_starter_annual")).toBeNull();
    });
  });
});
