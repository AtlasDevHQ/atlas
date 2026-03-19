/**
 * Plan definitions and limits for Atlas billing tiers.
 *
 * Self-hosted deployments default to "free" (unlimited, no Stripe).
 * SaaS workspaces start as "trial" (14-day, same limits as team).
 * Paid tiers: "team" and "enterprise".
 *
 * BYOT (Bring Your Own Token) is orthogonal — a boolean flag on the org
 * that selects a different Stripe price ID, not a separate tier.
 */

import type { PlanTier } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanLimits {
  /** Max queries per billing month. -1 = unlimited. */
  queriesPerMonth: number;
  /** Max tokens per billing month. -1 = unlimited. */
  tokensPerMonth: number;
  /** Max organization members. -1 = unlimited. */
  maxMembers: number;
  /** Max datasource connections. -1 = unlimited. */
  maxConnections: number;
}

export interface PlanDefinition {
  name: PlanTier;
  displayName: string;
  limits: PlanLimits;
  trialDays?: number;
}

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

const UNLIMITED = -1;

/** Trial duration in days. Single source of truth — used in plan definitions, Stripe config, and enforcement. */
export const TRIAL_DAYS = 14;

const PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    name: "free",
    displayName: "Self-Hosted",
    limits: {
      queriesPerMonth: UNLIMITED,
      tokensPerMonth: UNLIMITED,
      maxMembers: UNLIMITED,
      maxConnections: UNLIMITED,
    },
  },
  trial: {
    name: "trial",
    displayName: "Trial",
    trialDays: TRIAL_DAYS,
    limits: {
      queriesPerMonth: 10_000,
      tokensPerMonth: 5_000_000,
      maxMembers: 25,
      maxConnections: 5,
    },
  },
  team: {
    name: "team",
    displayName: "Team",
    limits: {
      queriesPerMonth: 10_000,
      tokensPerMonth: 5_000_000,
      maxMembers: 25,
      maxConnections: 5,
    },
  },
  enterprise: {
    name: "enterprise",
    displayName: "Enterprise",
    limits: {
      queriesPerMonth: UNLIMITED,
      tokensPerMonth: UNLIMITED,
      maxMembers: UNLIMITED,
      maxConnections: UNLIMITED,
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

  const teamPriceId = process.env.STRIPE_TEAM_PRICE_ID;
  if (teamPriceId) {
    plans.push({
      name: "team",
      priceId: teamPriceId,
      annualDiscountPriceId: process.env.STRIPE_TEAM_ANNUAL_PRICE_ID,
      limits: {
        queries: PLANS.team.limits.queriesPerMonth,
        tokens: PLANS.team.limits.tokensPerMonth,
        members: PLANS.team.limits.maxMembers,
        connections: PLANS.team.limits.maxConnections,
      },
      freeTrial: { days: TRIAL_DAYS },
    });
  }

  const enterprisePriceId = process.env.STRIPE_ENTERPRISE_PRICE_ID;
  if (enterprisePriceId) {
    plans.push({
      name: "enterprise",
      priceId: enterprisePriceId,
      limits: {
        queries: UNLIMITED,
        tokens: UNLIMITED,
        members: UNLIMITED,
        connections: UNLIMITED,
      },
    });
  }

  return plans;
}
