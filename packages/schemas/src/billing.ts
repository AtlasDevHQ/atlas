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
  trialEndsAt: string | null;
}

/** Plan limits (null = unlimited). */
export interface BillingLimits {
  tokenBudgetPerSeat: number | null;
  totalTokenBudget: number | null;
  maxSeats: number | null;
  maxConnections: number | null;
}

/** Current-period usage counters. */
export interface BillingUsage {
  queryCount: number;
  tokenCount: number;
  seatCount: number;
  tokenUsagePercent: number;
  tokenOverageStatus: OverageStatus;
  periodStart: string;
  periodEnd: string;
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
 * Active Stripe subscription summary, or `null` when the workspace has no
 * active or trialing subscription. `plan` and `status` come directly from
 * Stripe / Better Auth and are intentionally free-form strings.
 */
export interface BillingSubscription {
  stripeSubscriptionId: string;
  plan: string;
  status: string;
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
}) satisfies z.ZodType<BillingPlan>;

export const BillingLimitsSchema = z.object({
  tokenBudgetPerSeat: z.number().nullable(),
  totalTokenBudget: z.number().nullable(),
  maxSeats: z.number().nullable(),
  maxConnections: z.number().nullable(),
}) satisfies z.ZodType<BillingLimits>;

export const BillingUsageSchema = z.object({
  queryCount: z.number(),
  tokenCount: z.number(),
  seatCount: z.number(),
  tokenUsagePercent: z.number(),
  tokenOverageStatus: OverageStatusEnum,
  periodStart: z.string(),
  periodEnd: z.string(),
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
}) satisfies z.ZodType<BillingSubscription>;

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
}) satisfies z.ZodType<BillingStatus>;
