/**
 * Billing wire-format schema.
 *
 * Single source of truth for GET /api/v1/billing — the endpoint served by
 * `packages/api/src/api/routes/billing.ts` and consumed by the admin
 * billing page (`/admin/billing`) and the model-config BYOT gate
 * (`/admin/model-config`).
 *
 * Before this migration, the billing route's OpenAPI response was
 * described as `z.record(z.string(), z.unknown())` — "any object" — which
 * meant the generated OpenAPI spec documented nothing about the actual
 * shape, and the web parse relied on a schema that silently relaxed
 * every enum to `z.string()`. Centralizing here lets both sides share a
 * strict contract and the spec describes the genuine output.
 *
 * Enum handling:
 * - `plan.tier` uses `PLAN_TIERS` from `@useatlas/types` (already published).
 * - `usage.tokenOverageStatus` uses a locally-defined `OVERAGE_STATUSES`
 *   tuple, guarded at compile time by `satisfies z.ZodType<OverageStatus>`
 *   against the union type in `@useatlas/types`. Keeping the tuple here
 *   avoids bumping the `@useatlas/types` npm version for one literal
 *   constant; the `satisfies` guard still breaks this file if the union
 *   drifts from the tuple.
 *
 * `subscription.plan` and `subscription.status` stay `z.string()` —
 * Stripe controls that vocabulary and we don't want to fail parse on a
 * new Stripe status the TS union doesn't enumerate.
 *
 * Every schema uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a
 * field rename in `@useatlas/types` or in the local interfaces below
 * breaks this file at compile time instead of passing through to
 * runtime. Strict `z.enum(TUPLE)` matches the `@hono/zod-openapi`
 * extractor's expectations — it cannot serialize `ZodCatch` wrappers.
 *
 * BillingStatus + its nested interfaces live in this module (rather than
 * in `@useatlas/types`) because they describe wire shape served only by
 * one route. The `@useatlas/types` billing module keeps the scalar
 * primitives (`OverageStatus`, `PlanLimitStatus`) that are consumed
 * beyond the wire boundary (enforcement, metering).
 */
import { z } from "zod";
import { PLAN_TIERS, type PlanTier, type OverageStatus } from "@useatlas/types";

const OVERAGE_STATUSES = ["ok", "warning", "soft_limit", "hard_limit"] as const;
const OverageStatusEnum = z.enum(OVERAGE_STATUSES) satisfies z.ZodType<OverageStatus>;
const PlanTierEnum = z.enum(PLAN_TIERS);

// ---------------------------------------------------------------------------
// Interfaces — TS companions to the Zod schemas below. Declared here
// because no other package needs the BillingStatus interface outside the
// wire boundary; enforcement / metering use OverageStatus directly.
// ---------------------------------------------------------------------------

/** Plan details surfaced on the billing page. */
export interface BillingPlan {
  tier: PlanTier;
  displayName: string;
  pricePerSeat: number;
  defaultModel: string;
  byot: boolean;
  /** Raw `organization.trial_ends_at` — may be null even on a live trial (pre-backfill workspaces). */
  trialEndsAt: string | null;
  /**
   * Server-computed *effective* trial end (#3434): `trial_ends_at`, falling
   * back to `createdAt + trialDays` — the exact date enforcement cuts the
   * workspace off at. Non-null whenever `tier === "trial"` (barring
   * unparseable timestamps). Render trial countdowns from THIS field, not
   * `trialEndsAt`. Optional so a web bundle pinned to an older published
   * schema keeps parsing; consumers fall back to `trialEndsAt` when absent.
   */
  trialEndsAtEffective?: string | null;
  /**
   * Trial length in days (the API's TRIAL_DAYS constant) so UI copy never
   * hardcodes "14-day". Null for tiers without a trial; optional for
   * older-bundle tolerance (see trialEndsAtEffective).
   */
  trialDays?: number | null;
}

/** Plan limits (null = unlimited). */
export interface BillingLimits {
  tokenBudgetPerSeat: number | null;
  totalTokenBudget: number | null;
  maxSeats: number | null;
  maxConnections: number | null;
  /**
   * Max distinct chat-pillar integrations the workspace may install (null =
   * unlimited). Enforced server-side by `checkChatIntegrationLimitAndInstall`
   * via `PlanLimits.maxChatIntegrations` (#2953, #3001); surfaced here so the
   * billing page can display the cap alongside seats / connections (#3438).
   */
  maxChatIntegrations: number | null;
}

/** Current-period usage counters. */
export interface BillingUsage {
  queryCount: number;
  /** Raw token spend for the period (input + output tokens). */
  tokenCount: number;
  /**
   * Output-equivalent (model-weighted) token spend for the period (#3989) —
   * the denominator `tokenUsagePercent` and the enforced budget are computed
   * from. A turn on a pricier model contributes more here than to the raw
   * `tokenCount`, making the "model-aware budget" literally true. Optional for
   * older-bundle tolerance; falls back to `tokenCount` when absent.
   */
  weightedTokenCount?: number;
  seatCount: number;
  tokenUsagePercent: number;
  tokenOverageStatus: OverageStatus;
  periodStart: string;
  periodEnd: string;
  /**
   * #3431: where the metering window came from — `"stripe"` when anchored
   * on the org's active subscription period, `"utc-month"` for the UTC
   * calendar-month fallback (trial / unsubscribed). Lets the billing page
   * label "Current period" honestly. Optional for older-bundle tolerance.
   */
  periodSource?: "stripe" | "utc-month";
}

/** Seat limit / current count. */
export interface BillingSeatCount {
  count: number;
  max: number | null;
}

/** Connection limit / current count. */
export interface BillingConnectionCount {
  count: number;
  max: number | null;
}

/**
 * Stripe subscription summary, or `null` only when the workspace has never
 * had a subscription row at all. Critically this is NOT gated on status:
 * `past_due`, `unpaid`, and `canceled` subscriptions are returned too
 * (#3429) — those are exactly the states where the user must reach the
 * billing portal to fix payment, so hiding them strands a delinquent
 * customer. `plan` and `status` come directly from Stripe / Better Auth
 * and are intentionally free-form strings (a new Stripe status must not
 * fail parse).
 */
export interface BillingSubscription {
  stripeSubscriptionId: string;
  plan: string;
  status: string;
  /**
   * True when the subscription is set to cancel at the end of the current
   * period — still active/paid until then. The UI surfaces an end-date
   * notice instead of a plain "active" badge (#3429). Optional for
   * older-bundle tolerance; the API always sends it (default `false`).
   */
  cancelAtPeriodEnd?: boolean;
  /**
   * ISO end of the current billing period (the Better Auth Stripe plugin's
   * persisted `periodEnd`). Drives the cancel-at-period-end "ends on" copy.
   * Null when the plugin hasn't recorded one yet; optional for older-bundle
   * tolerance.
   */
  periodEnd?: string | null;
}

/**
 * A plan tier the workspace can move to via self-serve checkout (#3418).
 * `configured` is false when the deployment has no Stripe Price ID for the
 * tier — the picker renders the card but disables its CTA. Limits are
 * nullable with null = unlimited, mirroring {@link BillingLimits}.
 */
export interface BillingAvailablePlan {
  tier: PlanTier;
  displayName: string;
  pricePerSeat: number;
  tokenBudgetPerSeat: number | null;
  maxSeats: number | null;
  maxConnections: number | null;
  configured: boolean;
}

export interface BillingStatus {
  workspaceId: string;
  plan: BillingPlan;
  limits: BillingLimits;
  usage: BillingUsage;
  seats: BillingSeatCount;
  connections: BillingConnectionCount;
  currentModel: string;
  overagePerMillionTokens: number;
  subscription: BillingSubscription | null;
  /**
   * Optional so a web bundle pinned to an older published schema keeps
   * parsing (z.object strips unknown keys; the picker hides itself when
   * the field is absent). The API always sends it.
   */
  availablePlans?: BillingAvailablePlan[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const BillingPlanSchema = z.object({
  tier: PlanTierEnum,
  displayName: z.string(),
  pricePerSeat: z.number(),
  defaultModel: z.string(),
  byot: z.boolean(),
  trialEndsAt: z.string().nullable(),
  trialEndsAtEffective: z.string().nullable().optional(),
  trialDays: z.number().nullable().optional(),
}) satisfies z.ZodType<BillingPlan>;

export const BillingLimitsSchema = z.object({
  tokenBudgetPerSeat: z.number().nullable(),
  totalTokenBudget: z.number().nullable(),
  maxSeats: z.number().nullable(),
  maxConnections: z.number().nullable(),
  maxChatIntegrations: z.number().nullable(),
}) satisfies z.ZodType<BillingLimits>;

export const BillingUsageSchema = z.object({
  queryCount: z.number(),
  tokenCount: z.number(),
  weightedTokenCount: z.number().optional(),
  seatCount: z.number(),
  tokenUsagePercent: z.number(),
  tokenOverageStatus: OverageStatusEnum,
  periodStart: z.string(),
  periodEnd: z.string(),
  periodSource: z.enum(["stripe", "utc-month"]).optional(),
}) satisfies z.ZodType<BillingUsage>;

export const BillingSeatCountSchema = z.object({
  count: z.number(),
  max: z.number().nullable(),
}) satisfies z.ZodType<BillingSeatCount>;

export const BillingConnectionCountSchema = z.object({
  count: z.number(),
  max: z.number().nullable(),
}) satisfies z.ZodType<BillingConnectionCount>;

export const BillingSubscriptionSchema = z.object({
  stripeSubscriptionId: z.string(),
  plan: z.string(),
  status: z.string(),
  cancelAtPeriodEnd: z.boolean().optional(),
  periodEnd: z.string().nullable().optional(),
}) satisfies z.ZodType<BillingSubscription>;

export const BillingAvailablePlanSchema = z.object({
  tier: PlanTierEnum,
  displayName: z.string(),
  pricePerSeat: z.number(),
  tokenBudgetPerSeat: z.number().nullable(),
  maxSeats: z.number().nullable(),
  maxConnections: z.number().nullable(),
  configured: z.boolean(),
}) satisfies z.ZodType<BillingAvailablePlan>;

// ---------------------------------------------------------------------------
// Trial status — GET /api/v1/trial (#3434)
// ---------------------------------------------------------------------------

/**
 * Member-visible trial state. Served by `GET /api/v1/trial` under standard
 * (non-admin) auth so every workspace member — not just admins — can see
 * the trial clock instead of discovering it via a hard 403 at expiry.
 * `trial` is null off-trial (paid / free / locked tiers, self-hosted, no
 * active org).
 */
export interface TrialStatus {
  trial: {
    /** Workspace creation time — when the trial started. */
    startedAt: string;
    /** Effective trial end — same fallback semantics as BillingPlan.trialEndsAtEffective. */
    endsAt: string;
    /** Trial length in days (the API's TRIAL_DAYS constant). */
    trialDays: number;
    /** Whether enforcement already considers the trial expired. */
    expired: boolean;
  } | null;
}

export const TrialStatusSchema = z.object({
  trial: z
    .object({
      startedAt: z.string(),
      endsAt: z.string(),
      trialDays: z.number(),
      expired: z.boolean(),
    })
    .nullable(),
}) satisfies z.ZodType<TrialStatus>;

export const BillingStatusSchema = z.object({
  workspaceId: z.string(),
  plan: BillingPlanSchema,
  limits: BillingLimitsSchema,
  usage: BillingUsageSchema,
  seats: BillingSeatCountSchema,
  connections: BillingConnectionCountSchema,
  currentModel: z.string(),
  overagePerMillionTokens: z.number(),
  subscription: BillingSubscriptionSchema.nullable(),
  availablePlans: z.array(BillingAvailablePlanSchema).optional(),
}) satisfies z.ZodType<BillingStatus>;
