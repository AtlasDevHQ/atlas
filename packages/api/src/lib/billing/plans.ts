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
import { getSettingAuto } from "@atlas/api/lib/settings";

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
  /**
   * Max distinct chat-pillar integrations a workspace may install. -1 =
   * unlimited. The cap counts `workspace_plugins WHERE pillar = 'chat'` —
   * the six chat platforms (Slack, Teams, Discord, Google Chat, Telegram,
   * WhatsApp). The "All 8 chat integrations" figure marketed on /pricing
   * also counts Linear + GitHub, but those are `pillar = 'action'`, so they
   * do NOT consume a chat-integration slot. Marketed tiers: Starter 1 /
   * Pro 3 / Business unlimited. Enforced atomically at chat install time by
   * `checkChatIntegrationLimitAndInstall` (#2953, #3001).
   */
  maxChatIntegrations: number;
  /**
   * Included proactive-chat classifier invocations per workspace per
   * month (#3436). -1 = unlimited. This is the tier-derived default for
   * `workspace_proactive_config.monthly_classifier_cap` — when that
   * column is NULL the quota gate falls back to this value (the column
   * is an operator/admin override, not the only cap). Sizing: a
   * classify is one small haiku-class call (~$0.0005), so even the
   * Business cap bounds worst-case spend at low tens of dollars while
   * staying invisible to legitimate usage. Enforced in
   * `lib/proactive/quota.ts:getEffectiveMonthlyClassifierCap`.
   */
  monthlyProactiveClassifierCap: number;
}

export interface PlanDefinition {
  name: PlanTier;
  displayName: string;
  /** Price in USD per seat per month. 0 = free. */
  pricePerSeat: number;
  /** Default AI model for this plan tier. */
  defaultModel: string;
  /**
   * Included at-cost usage credit per seat per month, in USD (Structure B,
   * #4034). Pooled per-seat: the workspace's included usage budget is
   * `includedUsageDollarsPerSeat × seatCount`, so team size ladders the pool and
   * there is no per-tier credit ladder. 0 = no included credit (free/locked).
   * AI usage is metered at provider cost (zero markup) and drawn against this;
   * enforcement against it lands in #4038. The flat $20 on every paid tier is a
   * working number — hot-reloadable, recalibrate ~30d post-launch.
   */
  includedUsageDollarsPerSeat: number;
  /**
   * DEPRECATED (Structure B, #4034): the legacy synthetic $/1M-token overage
   * rate. Zeroed on every tier — Structure B bills usage at provider cost (zero
   * markup) via the at-cost meter, not a per-token markup. Zeroing here only
   * neutralizes the DISPLAY accrual (`computeOverageCost` → $0); the token-based
   * OverageMeter (#3992) keeps reporting token deltas to its Stripe price until
   * the at-cost meter repoint lands (#4039). Retained only so the field doesn't
   * break the wire type mid-migration; removed when dollar-native enforcement
   * lands (#4038).
   */
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

/**
 * Initial unclaimed-grace window (hours) for a Workspace provisioned over
 * MCP by the anonymous onboarding caller (`start_trial`, ADR-0018).
 *
 * A self-serve trial is provisioned into a SHORT grace window rather than the
 * full {@link TRIAL_DAYS}: the 14-day clock only starts when a human *claims*
 * the account on the web (verify email → set credential → accept ToS). Until
 * then the Workspace sits on `plan_tier='trial'` with `trial_ends_at = NOW() +
 * TRIAL_GRACE_HOURS`, so an abandoned signup can't squat on a 14-day free
 * window and the grace reaper (#3652) has a bounded horizon to sweep. Setup
 * (datasource connect, semantic layer) stays open during grace because Gate 0
 * only blocks once `trial_ends_at` lapses.
 */
export const TRIAL_GRACE_HOURS = 72;

/**
 * Default duration (days) of a platform-admin plan-override window (#3427).
 *
 * When an operator sets `plan_tier` directly, the Stripe webhook tier sync
 * skips its write until `plan_override_until` lapses. A bounded default means
 * an operator grant auto-heals back to Stripe authority instead of pinning the
 * tier forever — long enough (90 days) to cover a comp / dispute / manual
 * support grant, short enough that a forgotten override eventually re-syncs.
 */
export const PLAN_OVERRIDE_DAYS = 90;

/** The tiers self-serve checkout can move a workspace to (#3418). */
export type PaidPlanTier = "starter" | "pro" | "business";

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
    includedUsageDollarsPerSeat: 0,
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: UNLIMITED,
      maxSeats: UNLIMITED,
      maxConnections: UNLIMITED,
      maxChatIntegrations: UNLIMITED,
      monthlyProactiveClassifierCap: UNLIMITED,
    },
    features: { ...NO_FEATURES },
  },
  trial: {
    name: "trial",
    displayName: "Starter Trial",
    pricePerSeat: 0,
    // Gateway-canonical IDs (slash+dot) — SaaS resolves models through
    // Vercel AI Gateway and the gateway expects this format. The older
    // hyphen format (`claude-haiku-4-5`) is migrated lazily by the
    // billing-page alias map for any legacy `ATLAS_MODEL` settings.
    defaultModel: "anthropic/claude-haiku-4.5",
    includedUsageDollarsPerSeat: 20,
    overagePerMillionTokens: 0,
    trialDays: TRIAL_DAYS,
    limits: {
      tokenBudgetPerSeat: 2_000_000,
      maxSeats: 10,
      maxConnections: 1,
      maxChatIntegrations: 1,
      monthlyProactiveClassifierCap: 5_000,
    },
    features: { ...NO_FEATURES },
  },
  starter: {
    name: "starter",
    displayName: "Starter",
    pricePerSeat: 39,
    defaultModel: "anthropic/claude-haiku-4.5",
    includedUsageDollarsPerSeat: 20,
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: 2_000_000,
      maxSeats: 10,
      maxConnections: 1,
      maxChatIntegrations: 1,
      monthlyProactiveClassifierCap: 5_000,
    },
    features: { ...NO_FEATURES },
  },
  pro: {
    name: "pro",
    displayName: "Pro",
    pricePerSeat: 69,
    defaultModel: "anthropic/claude-sonnet-4.6",
    includedUsageDollarsPerSeat: 20,
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: 5_000_000,
      maxSeats: 25,
      maxConnections: 3,
      maxChatIntegrations: 3,
      monthlyProactiveClassifierCap: 20_000,
    },
    features: {
      customDomain: true,
      sso: false,
      dataResidency: false,
      sla: null,
    },
  },
  // SaaS churn landing tier (#3421): a workspace whose subscription has
  // actually ended (customer.subscription.deleted). Zero entitlements —
  // enforcement blocks chat/query with a resubscribe message before any
  // budget math, and every resource cap is 0 so nothing new can be added.
  // Never produced on self-hosted ("free" stays the unlimited tier there).
  locked: {
    name: "locked",
    displayName: "Locked",
    pricePerSeat: 0,
    defaultModel: "anthropic/claude-haiku-4.5",
    includedUsageDollarsPerSeat: 0,
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: 0,
      maxSeats: 0,
      maxConnections: 0,
      maxChatIntegrations: 0,
      monthlyProactiveClassifierCap: 0,
    },
    features: { ...NO_FEATURES },
  },
  business: {
    name: "business",
    displayName: "Business",
    pricePerSeat: 149,
    defaultModel: "anthropic/claude-sonnet-4.6",
    includedUsageDollarsPerSeat: 20,
    overagePerMillionTokens: 0,
    limits: {
      tokenBudgetPerSeat: 15_000_000,
      maxSeats: UNLIMITED,
      maxConnections: UNLIMITED,
      maxChatIntegrations: UNLIMITED,
      monthlyProactiveClassifierCap: 100_000,
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
 *
 * Every plan sets `seatPriceId === priceId` — the plugin's "seat-only
 * plan" shape (#3418): checkout emits a single line item priced per seat
 * with quantity = member count, and the plugin's member
 * add/remove/invite-accept hooks keep the Stripe quantity synced to
 * membership automatically. This matches Atlas's $/seat pricing and the
 * member-count basis enforcement uses for token budgets. The pairing is
 * pinned by plans.test.ts — a drift would re-add a base line item on top
 * of the seat item (double billing).
 *
 * Price IDs resolve via `getSettingAuto` (#3703) — platform-scoped settings
 * registry. These keys are `scope: "platform"` and read with no orgId, so the
 * effective precedence is `platform DB override > env > default` (the workspace
 * tier is unreachable for platform-scoped reads). The env var is the self-host
 * / boot fallback tier. `getSettingAuto` is a synchronous read of the in-process
 * settings cache (kept fresh by writes + the SaaS refresh tick); because the
 * `@better-auth/stripe` plugin is handed this FUNCTION (not its return value),
 * plans are re-resolved on each subscription operation, so a pricing change set
 * from Admin → Settings takes effect without a redeploy.
 *
 * NOTE (#3435/#3703): each tier below is conditionally pushed only when its
 * monthly price ID resolves, so a missing one SILENTLY OMITS that tier from
 * checkout. This function deliberately stays silent (it has many legitimate
 * callers that don't want boot noise); the loud check lives at boot in
 * `BillingConfigGuardLive` (`lib/effect/saas-guards.ts`), which WARNS (no
 * longer crashes) a SaaS boot when any required monthly price ID is absent
 * after settings resolution. The required-key SSOT is
 * `MONTHLY_PRICE_ID_ENV_VARS` in `lib/billing/config-validation.ts`.
 */
export function getStripePlans(): Array<{
  name: string;
  priceId: string;
  annualDiscountPriceId?: string;
  seatPriceId?: string;
  limits: Record<string, number>;
  freeTrial?: { days: number };
}> {
  const plans: Array<{
    name: string;
    priceId: string;
    annualDiscountPriceId?: string;
    seatPriceId?: string;
    limits: Record<string, number>;
    freeTrial?: { days: number };
  }> = [];

  const starterPriceId = getSettingAuto("STRIPE_STARTER_PRICE_ID");
  if (starterPriceId) {
    plans.push({
      name: "starter",
      priceId: starterPriceId,
      seatPriceId: starterPriceId,
      annualDiscountPriceId: getSettingAuto("STRIPE_STARTER_ANNUAL_PRICE_ID"),
      limits: {
        tokenBudgetPerSeat: PLANS.starter.limits.tokenBudgetPerSeat,
        seats: PLANS.starter.limits.maxSeats,
        connections: PLANS.starter.limits.maxConnections,
        chatIntegrations: PLANS.starter.limits.maxChatIntegrations,
      },
      freeTrial: { days: TRIAL_DAYS },
    });
  }

  const proPriceId = getSettingAuto("STRIPE_PRO_PRICE_ID");
  if (proPriceId) {
    plans.push({
      name: "pro",
      priceId: proPriceId,
      seatPriceId: proPriceId,
      annualDiscountPriceId: getSettingAuto("STRIPE_PRO_ANNUAL_PRICE_ID"),
      limits: {
        tokenBudgetPerSeat: PLANS.pro.limits.tokenBudgetPerSeat,
        seats: PLANS.pro.limits.maxSeats,
        connections: PLANS.pro.limits.maxConnections,
        chatIntegrations: PLANS.pro.limits.maxChatIntegrations,
      },
      freeTrial: { days: TRIAL_DAYS },
    });
  }

  const businessPriceId = getSettingAuto("STRIPE_BUSINESS_PRICE_ID");
  if (businessPriceId) {
    plans.push({
      name: "business",
      priceId: businessPriceId,
      seatPriceId: businessPriceId,
      annualDiscountPriceId: getSettingAuto("STRIPE_BUSINESS_ANNUAL_PRICE_ID"),
      limits: {
        tokenBudgetPerSeat: PLANS.business.limits.tokenBudgetPerSeat,
        seats: PLANS.business.limits.maxSeats,
        connections: PLANS.business.limits.maxConnections,
        chatIntegrations: PLANS.business.limits.maxChatIntegrations,
      },
      freeTrial: { days: TRIAL_DAYS },
    });
  }

  return plans;
}

/**
 * Resolve a Stripe price ID back to an Atlas PlanTier.
 *
 * Checks both monthly and annual price IDs, resolved via `getSettingAuto`
 * (#3703) — platform settings with env fallback, hot-reloadable in SaaS.
 * Returns null if the price ID doesn't match any configured plan.
 */
export function resolvePlanTierFromPriceId(priceId: string): PlanTier | null {
  const starterPriceId = getSettingAuto("STRIPE_STARTER_PRICE_ID");
  const starterAnnualPriceId = getSettingAuto("STRIPE_STARTER_ANNUAL_PRICE_ID");
  const proPriceId = getSettingAuto("STRIPE_PRO_PRICE_ID");
  const proAnnualPriceId = getSettingAuto("STRIPE_PRO_ANNUAL_PRICE_ID");
  const businessPriceId = getSettingAuto("STRIPE_BUSINESS_PRICE_ID");
  const businessAnnualPriceId = getSettingAuto("STRIPE_BUSINESS_ANNUAL_PRICE_ID");

  if (starterPriceId && (priceId === starterPriceId || (starterAnnualPriceId && priceId === starterAnnualPriceId))) {
    return "starter";
  }
  if (proPriceId && (priceId === proPriceId || (proAnnualPriceId && priceId === proAnnualPriceId))) {
    return "pro";
  }
  if (businessPriceId && (priceId === businessPriceId || (businessAnnualPriceId && priceId === businessAnnualPriceId))) {
    return "business";
  }
  return null;
}
