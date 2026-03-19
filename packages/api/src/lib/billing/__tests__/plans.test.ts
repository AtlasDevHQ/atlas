/**
 * Tests for billing plan definitions and limits.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  getPlanDefinition,
  getPlanLimits,
  isUnlimited,
  getStripePlans,
} from "@atlas/api/lib/billing/plans";

describe("billing/plans", () => {
  describe("getPlanDefinition", () => {
    it("returns definition for all tiers", () => {
      for (const tier of ["free", "trial", "team", "enterprise"] as const) {
        const def = getPlanDefinition(tier);
        expect(def.name).toBe(tier);
        expect(def.displayName).toBeTruthy();
        expect(def.limits).toBeDefined();
      }
    });

    it("free tier has unlimited limits", () => {
      const limits = getPlanLimits("free");
      expect(isUnlimited(limits.queriesPerMonth)).toBe(true);
      expect(isUnlimited(limits.tokensPerMonth)).toBe(true);
      expect(isUnlimited(limits.maxMembers)).toBe(true);
      expect(isUnlimited(limits.maxConnections)).toBe(true);
    });

    it("enterprise tier has unlimited limits", () => {
      const limits = getPlanLimits("enterprise");
      expect(isUnlimited(limits.queriesPerMonth)).toBe(true);
      expect(isUnlimited(limits.tokensPerMonth)).toBe(true);
    });

    it("trial tier has same limits as team", () => {
      const trial = getPlanLimits("trial");
      const team = getPlanLimits("team");
      expect(trial.queriesPerMonth).toBe(team.queriesPerMonth);
      expect(trial.tokensPerMonth).toBe(team.tokensPerMonth);
      expect(trial.maxMembers).toBe(team.maxMembers);
      expect(trial.maxConnections).toBe(team.maxConnections);
    });

    it("team tier has finite limits", () => {
      const limits = getPlanLimits("team");
      expect(isUnlimited(limits.queriesPerMonth)).toBe(false);
      expect(limits.queriesPerMonth).toBeGreaterThan(0);
      expect(isUnlimited(limits.tokensPerMonth)).toBe(false);
      expect(limits.tokensPerMonth).toBeGreaterThan(0);
    });

    it("trial definition includes trialDays", () => {
      const def = getPlanDefinition("trial");
      expect(def.trialDays).toBe(14);
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

  describe("getStripePlans", () => {
    function cleanStripeEnv() {
      delete process.env.STRIPE_TEAM_PRICE_ID;
      delete process.env.STRIPE_TEAM_ANNUAL_PRICE_ID;
      delete process.env.STRIPE_ENTERPRISE_PRICE_ID;
    }
    beforeEach(cleanStripeEnv);
    afterEach(cleanStripeEnv);

    it("returns empty array when no price IDs are set", () => {
      const plans = getStripePlans();
      expect(plans).toEqual([]);
    });

    it("includes team plan when STRIPE_TEAM_PRICE_ID is set", () => {
      process.env.STRIPE_TEAM_PRICE_ID = "price_team_123";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("team");
      expect(plans[0].priceId).toBe("price_team_123");
      expect(plans[0].freeTrial).toEqual({ days: 14 });
    });

    it("includes annual price ID when set", () => {
      process.env.STRIPE_TEAM_PRICE_ID = "price_team_123";
      process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = "price_team_annual_456";
      const plans = getStripePlans();
      expect(plans[0].annualDiscountPriceId).toBe("price_team_annual_456");
    });

    it("includes enterprise plan when STRIPE_ENTERPRISE_PRICE_ID is set", () => {
      process.env.STRIPE_ENTERPRISE_PRICE_ID = "price_ent_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("enterprise");
      expect(plans[0].priceId).toBe("price_ent_789");
      expect(plans[0].freeTrial).toBeUndefined();
    });

    it("includes both plans when both price IDs are set", () => {
      process.env.STRIPE_TEAM_PRICE_ID = "price_team_123";
      process.env.STRIPE_ENTERPRISE_PRICE_ID = "price_ent_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(2);
      expect(plans.map((p) => p.name)).toEqual(["team", "enterprise"]);
    });
  });
});
