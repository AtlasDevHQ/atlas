/**
 * Tests for billing plan definitions and limits.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  getPlanDefinition,
  getPlanLimits,
  isUnlimited,
  computeTokenBudget,
  computeUsageDollarBudget,
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
      expect(isUnlimited(limits.maxChatIntegrations)).toBe(true);
      expect(isUnlimited(limits.monthlyProactiveClassifierCap)).toBe(true);
    });

    it("business tier has unlimited seats and connections", () => {
      const limits = getPlanLimits("business");
      expect(isUnlimited(limits.maxSeats)).toBe(true);
      expect(isUnlimited(limits.maxConnections)).toBe(true);
      expect(isUnlimited(limits.maxChatIntegrations)).toBe(true);
      expect(isUnlimited(limits.tokenBudgetPerSeat)).toBe(false);
      expect(limits.tokenBudgetPerSeat).toBe(15_000_000);
    });

    it("trial tier has same limits as starter", () => {
      const trial = getPlanLimits("trial");
      const starter = getPlanLimits("starter");
      expect(trial.tokenBudgetPerSeat).toBe(starter.tokenBudgetPerSeat);
      expect(trial.maxSeats).toBe(starter.maxSeats);
      expect(trial.maxConnections).toBe(starter.maxConnections);
      expect(trial.maxChatIntegrations).toBe(starter.maxChatIntegrations);
      expect(trial.monthlyProactiveClassifierCap).toBe(
        starter.monthlyProactiveClassifierCap,
      );
    });

    it("every paid/SaaS tier bounds the proactive classifier cap (#3436)", () => {
      // NULL workspace column = this tier default; only self-hosted is
      // unlimited, so a Starter workspace's classifier spend is bounded
      // out of the box instead of requiring an operator-set column.
      expect(getPlanLimits("trial").monthlyProactiveClassifierCap).toBe(5_000);
      expect(getPlanLimits("starter").monthlyProactiveClassifierCap).toBe(5_000);
      expect(getPlanLimits("pro").monthlyProactiveClassifierCap).toBe(20_000);
      expect(getPlanLimits("business").monthlyProactiveClassifierCap).toBe(100_000);
      expect(getPlanLimits("locked").monthlyProactiveClassifierCap).toBe(0);
    });

    it("starter tier has finite limits", () => {
      const limits = getPlanLimits("starter");
      expect(isUnlimited(limits.tokenBudgetPerSeat)).toBe(false);
      expect(limits.tokenBudgetPerSeat).toBe(2_000_000);
      expect(limits.maxSeats).toBe(10);
      expect(limits.maxConnections).toBe(1);
      expect(limits.maxChatIntegrations).toBe(1);
    });

    it("pro tier has expected limits", () => {
      const limits = getPlanLimits("pro");
      expect(limits.tokenBudgetPerSeat).toBe(5_000_000);
      expect(limits.maxSeats).toBe(25);
      expect(limits.maxConnections).toBe(3);
      expect(limits.maxChatIntegrations).toBe(3);
    });

    it("trial definition includes trialDays", () => {
      const def = getPlanDefinition("trial");
      expect(def.trialDays).toBe(14);
    });

    it("plan definitions include pricing and model info (Structure B ladder, #4034)", () => {
      expect(getPlanDefinition("starter").pricePerSeat).toBe(39);
      expect(getPlanDefinition("pro").pricePerSeat).toBe(69);
      expect(getPlanDefinition("business").pricePerSeat).toBe(149);
      expect(getPlanDefinition("starter").defaultModel).toBe("anthropic/claude-haiku-4.5");
      expect(getPlanDefinition("pro").defaultModel).toBe("anthropic/claude-sonnet-4.6");
      expect(getPlanDefinition("business").defaultModel).toBe("anthropic/claude-sonnet-4.6");
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

    it("every paid tier carries the flat $20/seat at-cost credit; free/locked carry none (#4034)", () => {
      // Flat $20 on every paid tier (pooled per-seat via × seatCount); the trial
      // mirrors Starter. Free (BYOK/self-hosted) and locked (churned) carry no
      // included credit.
      expect(getPlanDefinition("starter").includedUsageDollarsPerSeat).toBe(20);
      expect(getPlanDefinition("pro").includedUsageDollarsPerSeat).toBe(20);
      expect(getPlanDefinition("business").includedUsageDollarsPerSeat).toBe(20);
      expect(getPlanDefinition("trial").includedUsageDollarsPerSeat).toBe(20);
      expect(getPlanDefinition("free").includedUsageDollarsPerSeat).toBe(0);
      expect(getPlanDefinition("locked").includedUsageDollarsPerSeat).toBe(0);
    });

    it("margin floor = seat price − included credit is positive on every paid tier (#4034)", () => {
      // The gap between the seat fee and the included at-cost credit is the
      // guaranteed per-seat margin floor (entry $39 − $20 = $19), independent of
      // usage. Pins the "credit sized below the seat price" invariant.
      for (const tier of ["starter", "pro", "business"] as const) {
        const def = getPlanDefinition(tier);
        expect(def.pricePerSeat - def.includedUsageDollarsPerSeat).toBeGreaterThan(0);
      }
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

  // Structure B included-credit denomination parity (#4040). The drift these
  // pin: the at-cost credit MUST stay denominated in dollars (a flat $20/seat
  // pool), never re-conflated with the millions-scale token budget the old
  // markup model used. A future edit that pasted a token-scale number into
  // includedUsageDollarsPerSeat — or otherwise broke the `$20 × seats` pool
  // relationship — fails here before it can reach enforcement (#4038).
  describe("computeUsageDollarBudget (credit denomination, #4040)", () => {
    it("pools the flat per-seat dollar credit by seat count", () => {
      for (const tier of ["starter", "pro", "business", "trial"] as const) {
        const perSeat = getPlanDefinition(tier).includedUsageDollarsPerSeat;
        expect(perSeat).toBe(20);
        expect(computeUsageDollarBudget(tier, 1)).toBe(perSeat);
        expect(computeUsageDollarBudget(tier, 5)).toBe(perSeat * 5);
        expect(computeUsageDollarBudget(tier, 25)).toBe(perSeat * 25);
      }
    });

    it("floors seat count at 1 so a transient 0/negative count keeps one seat's credit", () => {
      expect(computeUsageDollarBudget("starter", 0)).toBe(20);
      expect(computeUsageDollarBudget("starter", -3)).toBe(20);
    });

    it("yields no credit for tiers without included usage (free/locked)", () => {
      expect(computeUsageDollarBudget("free", 10)).toBe(0);
      expect(computeUsageDollarBudget("locked", 10)).toBe(0);
    });

    it("keeps the credit dollar-denominated, never token-scale (mismatch guard)", () => {
      // The tokens↔dollars slip this catches: a token-scale number (e.g. the old
      // 2_000_000-token budget) pasted into includedUsageDollarsPerSeat. A real
      // at-cost credit is a small, positive dollar figure well under $1000/seat,
      // and lives on a categorically smaller scale than the per-seat token budget
      // (the budget is >1000× the credit). Either bound trips on a token-scale
      // value — independent of the exact $20 pinned above, so a future $-recalibration
      // stays green while a denomination slip fails.
      for (const tier of ["starter", "pro", "business", "trial"] as const) {
        const def = getPlanDefinition(tier);
        expect(def.includedUsageDollarsPerSeat).toBeGreaterThan(0);
        expect(def.includedUsageDollarsPerSeat).toBeLessThan(1000);
        expect(
          def.limits.tokenBudgetPerSeat / def.includedUsageDollarsPerSeat,
        ).toBeGreaterThan(1000);
      }
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
      expect(plans[0].freeTrial).toEqual({ days: 14 });
    });

    it("includes business plan when STRIPE_BUSINESS_PRICE_ID is set", () => {
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("business");
      expect(plans[0].priceId).toBe("price_biz_789");
      expect(plans[0].freeTrial).toEqual({ days: 14 });
    });

    it("includes all plans when all price IDs are set", () => {
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_123";
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_456";
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      const plans = getStripePlans();
      expect(plans.length).toBe(3);
      expect(plans.map((p) => p.name)).toEqual(["starter", "pro", "business"]);
    });

    it("business plan limits reference PLANS.business.limits, not hardcoded UNLIMITED (#3438)", () => {
      // Drift trap: the business stripe-plan limits previously hardcoded
      // seats/connections/chatIntegrations: -1 instead of reading from the
      // canonical PLANS definition like starter/pro do. Assert they track
      // the source of truth so a future cap change in PLANS.business can't
      // silently diverge from what Stripe advertises.
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      const business = getStripePlans().find((p) => p.name === "business");
      const limits = getPlanLimits("business");
      expect(business?.limits).toEqual({
        tokenBudgetPerSeat: limits.tokenBudgetPerSeat,
        seats: limits.maxSeats,
        connections: limits.maxConnections,
        chatIntegrations: limits.maxChatIntegrations,
      });
    });

    it("sets seatPriceId === priceId on every plan (seat-only auto-managed seats, #3418)", () => {
      // seatPriceId === priceId is the plugin's "seat-only plan" shape:
      // checkout emits a single per-seat line item with quantity = member
      // count, and the plugin's member add/remove hooks keep the Stripe
      // quantity synced. A drift between the two would silently re-add a
      // base line item on top of the seat item — double billing.
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_123";
      process.env.STRIPE_PRO_PRICE_ID = "price_pro_456";
      process.env.STRIPE_BUSINESS_PRICE_ID = "price_biz_789";
      for (const plan of getStripePlans()) {
        expect(plan.seatPriceId).toBe(plan.priceId);
      }
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
