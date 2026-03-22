/**
 * Admin usage metering routes.
 *
 * Mounted under /api/v1/admin/usage. All routes require admin role.
 * Provides current period summary, combined dashboard payload (usage + plan
 * limits + history + per-user breakdown), historical summaries, and per-user breakdown.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, getWorkspaceDetails } from "@atlas/api/lib/db/internal";
import {
  getCurrentPeriodUsage,
  getUsageHistory,
  getUsageBreakdown,
  aggregateUsageSummary,
} from "@atlas/api/lib/metering";
import { getPlanDefinition, getPlanLimits, isUnlimited } from "@atlas/api/lib/billing/plans";
import { adminAuthPreamble } from "./admin-auth";

const log = createLogger("admin-usage");

/** Returns true if the string is a valid date (parseable by Date). */
function isValidDateParam(value: string): boolean {
  return !isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

const AuthErrorSchema = z.record(z.string(), z.unknown());

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
    200: {
      description: "Current period usage summary",
      content: { "application/json": { schema: CurrentPeriodUsageResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    200: {
      description: "Combined usage dashboard payload",
      content: { "application/json": { schema: SummaryResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    200: {
      description: "Historical usage summaries",
      content: { "application/json": { schema: HistoryResponseSchema } },
    },
    400: {
      description: "Invalid parameters or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    200: {
      description: "Per-user usage breakdown",
      content: { "application/json": { schema: BreakdownResponseSchema } },
    },
    400: {
      description: "Invalid parameters or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminUsage = new OpenAPIHono();

// GET / — current period usage summary for the active workspace
adminUsage.openapi(getCurrentUsageRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    try {
      const usage = await getCurrentPeriodUsage(orgId);
      return c.json({ workspaceId: orgId, ...usage }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch current usage");
      return c.json({ error: "internal_error", message: "Failed to fetch usage data.", requestId }, 500);
    }
  });
});

// GET /summary — combined usage dashboard payload
adminUsage.openapi(getUsageSummaryRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    try {
      // Aggregate today's daily summary before fetching history.
      // Non-critical — stale data is acceptable if this fails.
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      try {
        await aggregateUsageSummary(orgId, "daily", todayStart);
      } catch (aggErr) {
        log.warn(
          { err: aggErr instanceof Error ? aggErr : new Error(String(aggErr)), requestId },
          "Non-critical: failed to aggregate today's usage summary; proceeding with stale data",
        );
      }

      // 30 days ago
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);

      const [usage, workspace, history, users] = await Promise.all([
        getCurrentPeriodUsage(orgId),
        getWorkspaceDetails(orgId),
        getUsageHistory(orgId, "daily", thirtyDaysAgo.toISOString(), undefined, 31), // today + past 30 days
        getUsageBreakdown(orgId, undefined, undefined, 50), // top 50 users (dashboard summary, not full breakdown)
      ]);

      if (!workspace) {
        log.warn({ orgId, requestId }, "Workspace row not found for org; defaulting to free tier");
      }
      const planTier = workspace?.plan_tier ?? "free";
      const plan = getPlanDefinition(planTier);
      const limits = getPlanLimits(planTier);

      return c.json({
        workspaceId: orgId,
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
        history: history.toReversed(), // DB returns newest-first; reverse to chronological for chart
        users,
        hasStripe: !!workspace?.stripe_customer_id,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage summary");
      return c.json({ error: "internal_error", message: "Failed to fetch usage summary.", requestId }, 500);
    }
  });
});

// GET /history — historical usage summaries
adminUsage.openapi(getUsageHistoryRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    const period = c.req.query("period") === "daily" ? "daily" as const : "monthly" as const;
    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "90", 10) || 90, 1), 365);

    if (startDate && !isValidDateParam(startDate)) {
      return c.json({ error: "invalid_param", message: "startDate must be a valid ISO date string." }, 400);
    }
    if (endDate && !isValidDateParam(endDate)) {
      return c.json({ error: "invalid_param", message: "endDate must be a valid ISO date string." }, 400);
    }

    try {
      // Trigger aggregation for the current period before returning history
      const now = new Date();
      const periodStart = period === "daily"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : new Date(now.getFullYear(), now.getMonth(), 1);
      await aggregateUsageSummary(orgId, period, periodStart);

      const summaries = await getUsageHistory(orgId, period, startDate ?? undefined, endDate ?? undefined, limit);
      return c.json({ workspaceId: orgId, period, summaries }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage history");
      return c.json({ error: "internal_error", message: "Failed to fetch usage history.", requestId }, 500);
    }
  });
});

// GET /breakdown — per-user usage breakdown
adminUsage.openapi(getUsageBreakdownRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

    if (startDate && !isValidDateParam(startDate)) {
      return c.json({ error: "invalid_param", message: "startDate must be a valid ISO date string." }, 400);
    }
    if (endDate && !isValidDateParam(endDate)) {
      return c.json({ error: "invalid_param", message: "endDate must be a valid ISO date string." }, 400);
    }

    try {
      const users = await getUsageBreakdown(orgId, startDate ?? undefined, endDate ?? undefined, limit);
      return c.json({ workspaceId: orgId, users }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage breakdown");
      return c.json({ error: "internal_error", message: "Failed to fetch usage breakdown.", requestId }, 500);
    }
  });
});

export { adminUsage };
