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
 * Tuples (`PLAN_TIERS`, `OVERAGE_STATUSES`) come from `@useatlas/types`
 * so adding a new plan tier or overage state propagates without a
 * second edit. `subscription.plan` and `subscription.status` stay as
 * `z.string()` — Stripe controls the vocabulary and we don't want to
 * fail parse on a new Stripe status the TS union doesn't enumerate.
 *
 * Uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field
 * rename in `@useatlas/types` breaks this file at compile time instead
 * of passing through to runtime. Strict `z.enum(TUPLE)` matches the
 * `@hono/zod-openapi` extractor's expectations.
 */
import { z } from "zod";
import {
  PLAN_TIERS,
  OVERAGE_STATUSES,
  type BillingStatus,
  type BillingPlan,
  type BillingLimits,
  type BillingUsage,
  type BillingSeatCount,
  type BillingConnectionCount,
  type BillingSubscription,
} from "@useatlas/types";

const PlanTierEnum = z.enum(PLAN_TIERS);
const OverageStatusEnum = z.enum(OVERAGE_STATUSES);

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
