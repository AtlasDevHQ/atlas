/**
 * Admin usage metering routes.
 *
 * Mounted under /api/v1/admin/usage. All routes require admin role.
 * Provides current period summary, combined dashboard payload (usage + plan
 * limits + history + per-user breakdown), historical summaries, and per-user breakdown.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { getWorkspaceDetails } from "@atlas/api/lib/db/internal";
import {
  getCurrentPeriodUsage,
  getUsageHistory,
  getUsageBreakdown,
  aggregateUsageSummary,
} from "@atlas/api/lib/metering";
import { getPlanDefinition, getPlanLimits, isUnlimited } from "@atlas/api/lib/billing/plans";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-usage");

/** Returns true if the string is a valid date (parseable by Date). */
function isValidDateParam(value: string): boolean {
  return !isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


const CurrentPeriodUsageResponseSchema = z.object({
  workspaceId: z.string(),
  queryCount: z.number(),
  tokenCount: z.number(),
  activeUsers: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

const UsageSummaryRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  period: z.string(),
  period_start: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  active_users: z.number(),
  storage_bytes: z.number(),
  updated_at: z.string(),
}).passthrough();

const UserBreakdownSchema = z.object({
  user_id: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  login_count: z.number(),
});

const SummaryResponseSchema = z.object({
  workspaceId: z.string(),
  current: z.object({
    queryCount: z.number(),
    tokenCount: z.number(),
    activeUsers: z.number(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  plan: z.object({
    tier: z.string(),
    displayName: z.string(),
    trialEndsAt: z.string().nullable(),
  }),
  limits: z.object({
    queriesPerMonth: z.number().nullable(),
    tokensPerMonth: z.number().nullable(),
    maxMembers: z.number().nullable(),
    maxConnections: z.number().nullable(),
  }),
  history: z.array(UsageSummaryRowSchema),
  users: z.array(UserBreakdownSchema),
  hasStripe: z.boolean(),
});

const HistoryResponseSchema = z.object({
  workspaceId: z.string(),
  period: z.enum(["daily", "monthly"]),
  summaries: z.array(UsageSummaryRowSchema),
});

const BreakdownResponseSchema = z.object({
  workspaceId: z.string(),
  users: z.array(UserBreakdownSchema),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCurrentUsageRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Usage"],
  summary: "Current period usage",
  description:
    "Returns the current billing period usage summary (query count, token count, active users) for the admin's active workspace.",
  responses: {
    200: { description: "Current period usage summary", content: { "application/json": { schema: CurrentPeriodUsageResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getUsageSummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Admin — Usage"],
  summary: "Combined usage dashboard",
  description:
    "Returns a combined dashboard payload: current period usage, plan limits, up to 31 daily history points (today + past 30 days), and per-user breakdown (top 50).",
  responses: {
    200: { description: "Combined usage dashboard payload", content: { "application/json": { schema: SummaryResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getUsageHistoryRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Admin — Usage"],
  summary: "Historical usage aggregates",
  description:
    "Returns historical usage summaries aggregated by period (daily or monthly). Supports date range filtering and limit.",
  responses: {
    200: { description: "Historical usage summaries", content: { "application/json": { schema: HistoryResponseSchema } } },
    400: { description: "Invalid parameters or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getUsageBreakdownRoute = createRoute({
  method: "get",
  path: "/breakdown",
  tags: ["Admin — Usage"],
  summary: "Per-user usage breakdown",
  description:
    "Returns per-user usage breakdown (query count, token count, login count) for the active workspace. Supports date range filtering and limit.",
  responses: {
    200: { description: "Per-user usage breakdown", content: { "application/json": { schema: BreakdownResponseSchema } } },
    400: { description: "Invalid parameters or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminUsage = createAdminRouter();

adminUsage.use(requireOrgContext());

// GET / — current period usage summary for the active workspace
adminUsage.openapi(getCurrentUsageRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const usage = yield* Effect.promise(() => getCurrentPeriodUsage(orgId!));
    return c.json({ workspaceId: orgId!, ...usage }, 200);
  }), { label: "fetch current usage" });
});

// GET /summary — combined usage dashboard payload
adminUsage.openapi(getUsageSummaryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    // Aggregate today's daily summary before fetching history.
    // Non-critical — stale data is acceptable if this fails.
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const aggResult = yield* Effect.tryPromise({
      try: () => aggregateUsageSummary(orgId!, "daily", todayStart),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (aggResult._tag === "Left") {
      log.warn(
        { err: aggResult.left, requestId },
        "Non-critical: failed to aggregate today's usage summary; proceeding with stale data",
      );
    }

    // 30 days ago
    const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);

    const [usage, workspace, history, users] = yield* Effect.promise(() => Promise.all([
      getCurrentPeriodUsage(orgId!),
      getWorkspaceDetails(orgId!),
      getUsageHistory(orgId!, "daily", thirtyDaysAgo.toISOString(), undefined, 31),
      getUsageBreakdown(orgId!, undefined, undefined, 50),
    ]));

    if (!workspace) {
      log.warn({ orgId, requestId }, "Workspace row not found for org; defaulting to free tier");
    }
    const planTier = workspace?.plan_tier ?? "free";
    const plan = getPlanDefinition(planTier);
    const limits = getPlanLimits(planTier);

    return c.json({
      workspaceId: orgId!,
      current: {
        queryCount: usage.queryCount,
        tokenCount: usage.tokenCount,
        activeUsers: usage.activeUsers,
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
      },
      plan: {
        tier: planTier,
        displayName: plan.displayName,
        trialEndsAt: workspace?.trial_ends_at ?? null,
      },
      limits: {
        queriesPerMonth: isUnlimited(limits.queriesPerMonth) ? null : limits.queriesPerMonth,
        tokensPerMonth: isUnlimited(limits.tokensPerMonth) ? null : limits.tokensPerMonth,
        maxMembers: isUnlimited(limits.maxMembers) ? null : limits.maxMembers,
        maxConnections: isUnlimited(limits.maxConnections) ? null : limits.maxConnections,
      },
      history: history.toReversed(),
      users,
      hasStripe: !!workspace?.stripe_customer_id,
    }, 200);
  }), { label: "fetch usage summary" });
});

// GET /history — historical usage summaries
adminUsage.openapi(getUsageHistoryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const period = c.req.query("period") === "daily" ? "daily" as const : "monthly" as const;
    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");
    const { limit } = parsePagination(c, { limit: 90, maxLimit: 365 });

    if (startDate && !isValidDateParam(startDate)) {
      return c.json({ error: "invalid_param", message: "startDate must be a valid ISO date string." }, 400);
    }
    if (endDate && !isValidDateParam(endDate)) {
      return c.json({ error: "invalid_param", message: "endDate must be a valid ISO date string." }, 400);
    }

    // Trigger aggregation for the current period before returning history
    const now = new Date();
    const periodStart = period === "daily"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), now.getMonth(), 1);
    yield* Effect.promise(() => aggregateUsageSummary(orgId!, period, periodStart));

    const summaries = yield* Effect.promise(() => getUsageHistory(orgId!, period, startDate ?? undefined, endDate ?? undefined, limit));
    return c.json({ workspaceId: orgId!, period, summaries }, 200);
  }), { label: "fetch usage history" });
});

// GET /breakdown — per-user usage breakdown
adminUsage.openapi(getUsageBreakdownRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");
    const { limit } = parsePagination(c, { limit: 100, maxLimit: 500 });

    if (startDate && !isValidDateParam(startDate)) {
      return c.json({ error: "invalid_param", message: "startDate must be a valid ISO date string." }, 400);
    }
    if (endDate && !isValidDateParam(endDate)) {
      return c.json({ error: "invalid_param", message: "endDate must be a valid ISO date string." }, 400);
    }

    const users = yield* Effect.promise(() => getUsageBreakdown(orgId!, startDate ?? undefined, endDate ?? undefined, limit));
    return c.json({ workspaceId: orgId!, users }, 200);
  }), { label: "fetch usage breakdown" });
});

export { adminUsage };
