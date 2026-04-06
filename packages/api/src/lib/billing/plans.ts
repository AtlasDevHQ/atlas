/**
 * Plan definitions and limits for Atlas billing tiers.
 *
 * Per-seat pricing with model-aware token budgets.
 *
 * Self-hosted deployments default to "free" (unlimited, BYOK only).
 * SaaS workspaces start as "trial" (14-day trial of Starter).
 * Paid tiers: "starter", "pro", "business".
 *
 * BYOT (Bring Your Own Token) is orthogonal — a boolean flag on the org
 * that bypasses token enforcement (unlimited queries when set).
 */

import type { PlanTier } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanFeatures {
  /** Whether the plan supports custom domains. */
  customDomain: boolean;
  /** Whether the plan supports SSO/SCIM. */
  sso: boolean;
  /** Whether the plan supports data residency selection. */
  dataResidency: boolean;
  /** SLA commitment, e.g. "99.9%". null = no SLA. */
  sla: string | null;
}

export interface PlanLimits {
  /** Included token budget per seat per month. -1 = unlimited (BYOK / self-hosted). */
  tokenBudgetPerSeat: number;
  /** Max organization seats. -1 = unlimited. */
  maxSeats: number;
  /** Max datasource connections. -1 = unlimited. */
  maxConnections: number;
}

export interface PlanDefinition {
  name: PlanTier;
  displayName: string;
  /** Price in USD per seat per month. 0 = free. */
  pricePerSeat: number;
  /** Default AI model for this plan tier. */
  defaultModel: string;
  /** Cost in USD per 1M output-equivalent tokens above the included budget. 0 = no overage. */
  overagePerMillionTokens: number;
  limits: PlanLimits;
  features: PlanFeatures;
  trialDays?: number;
}

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

const UNLIMITED = -1;

/** Trial duration in days. Single source of truth — used in plan definitions, Stripe config, and enforcement. */
export const TRIAL_DAYS = 14;

const NO_FEATURES: PlanFeatures = {
  customDomain: false,
  sso: false,
  dataResidency: false,
  sla: null,
};

const PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    name: "free",
    displayName: "Self-Hosted",
    pricePerSeat: 0,
    defaultModel: "user-configured",
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: UNLIMITED,
      maxSeats: UNLIMITED,
      maxConnections: UNLIMITED,
    },
    features: { ...NO_FEATURES },
  },
  trial: {
    name: "trial",
    displayName: "Starter Trial",
    pricePerSeat: 0,
    defaultModel: "claude-haiku-4-5",
    overagePerMillionTokens: 0,
    trialDays: TRIAL_DAYS,
    limits: {
      tokenBudgetPerSeat: 2_000_000,
      maxSeats: 10,
      maxConnections: 1,
    },
    features: { ...NO_FEATURES },
  },
  starter: {
    name: "starter",
    displayName: "Starter",
    pricePerSeat: 29,
    defaultModel: "claude-haiku-4-5",
    overagePerMillionTokens: 1.0,
    limits: {
      tokenBudgetPerSeat: 2_000_000,
      maxSeats: 10,
      maxConnections: 1,
    },
    features: { ...NO_FEATURES },
  },
  pro: {
    name: "pro",
    displayName: "Pro",
    pricePerSeat: 59,
    defaultModel: "claude-sonnet-4-6",
    overagePerMillionTokens: 0.8,
    limits: {
      tokenBudgetPerSeat: 5_000_000,
      maxSeats: 25,
      maxConnections: 3,
    },
    features: {
      customDomain: true,
      sso: false,
      dataResidency: false,
      sla: null,
    },
  },
  business: {
    name: "business",
    displayName: "Business",
    pricePerSeat: 99,
    defaultModel: "claude-sonnet-4-6",
    overagePerMillionTokens: 0.6,
    limits: {
      tokenBudgetPerSeat: 15_000_000,
      maxSeats: UNLIMITED,
      maxConnections: UNLIMITED,
    },
    features: {
      customDomain: true,
      sso: true,
      dataResidency: true,
      sla: "99.9%",
    },
  },
};

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getPlanDefinition(tier: PlanTier): Readonly<PlanDefinition> {
  return PLANS[tier];
}

export function getPlanLimits(tier: PlanTier): Readonly<PlanLimits> {
  return PLANS[tier].limits;
}

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED;
}

/**
 * Compute the total token budget for a workspace based on its plan and seat count.
 * Returns -1 (unlimited) for free tier or when tokenBudgetPerSeat is unlimited.
 */
export function computeTokenBudget(tier: PlanTier, seatCount: number): number {
  const limits = getPlanLimits(tier);
  if (isUnlimited(limits.tokenBudgetPerSeat)) return UNLIMITED;
  return limits.tokenBudgetPerSeat * Math.max(1, seatCount);
}

/**
 * Returns plan configs in the format expected by @better-auth/stripe's
 * `subscription.plans` option. Only called when STRIPE_SECRET_KEY is set.
 */
export function getStripePlans(): Array<{
  name: string;
  priceId: string;
  annualDiscountPriceId?: string;
  limits: Record<string, number>;
  freeTrial?: { days: number };
}> {
  const plans: Array<{
    name: string;
    priceId: string;
    annualDiscountPriceId?: string;
    limits: Record<string, number>;
    freeTrial?: { days: number };
  }> = [];

  const starterPriceId = process.env.STRIPE_STARTER_PRICE_ID;
  if (starterPriceId) {
    plans.push({
      name: "starter",
      priceId: starterPriceId,
      annualDiscountPriceId: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID,
      limits: {
        tokenBudgetPerSeat: PLANS.starter.limits.tokenBudgetPerSeat,
        seats: PLANS.starter.limits.maxSeats,
        connections: PLANS.starter.limits.maxConnections,
      },
      freeTrial: { days: TRIAL_DAYS },
    });
  }

  const proPriceId = process.env.STRIPE_PRO_PRICE_ID;
  if (proPriceId) {
    plans.push({
      name: "pro",
      priceId: proPriceId,
      annualDiscountPriceId: process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
      limits: {
        tokenBudgetPerSeat: PLANS.pro.limits.tokenBudgetPerSeat,
        seats: PLANS.pro.limits.maxSeats,
        connections: PLANS.pro.limits.maxConnections,
      },
    });
  }

  const businessPriceId = process.env.STRIPE_BUSINESS_PRICE_ID;
  if (businessPriceId) {
    plans.push({
      name: "business",
      priceId: businessPriceId,
      limits: {
        tokenBudgetPerSeat: PLANS.business.limits.tokenBudgetPerSeat,
        seats: UNLIMITED,
        connections: UNLIMITED,
      },
    });
  }

  return plans;
}

/**
 * Resolve a Stripe price ID back to an Atlas PlanTier.
 *
 * Checks both monthly and annual price IDs from environment variables.
 * Returns null if the price ID doesn't match any configured plan.
 */
export function resolvePlanTierFromPriceId(priceId: string): PlanTier | null {
  const starterPriceId = process.env.STRIPE_STARTER_PRICE_ID;
  const starterAnnualPriceId = process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
  const proPriceId = process.env.STRIPE_PRO_PRICE_ID;
  const proAnnualPriceId = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
  const businessPriceId = process.env.STRIPE_BUSINESS_PRICE_ID;

  if (starterPriceId && (priceId === starterPriceId || (starterAnnualPriceId && priceId === starterAnnualPriceId))) {
    return "starter";
  }
  if (proPriceId && (priceId === proPriceId || (proAnnualPriceId && priceId === proAnnualPriceId))) {
    return "pro";
  }
  if (businessPriceId && priceId === businessPriceId) {
    return "business";
  }
  return null;
}
