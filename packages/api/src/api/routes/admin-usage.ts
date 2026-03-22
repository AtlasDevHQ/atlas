/**
 * Admin usage metering routes.
 *
 * Mounted under /api/v1/admin/usage. All routes require admin role.
 * Provides current period summary, combined dashboard payload (usage + plan
 * limits + history + per-user breakdown), historical summaries, and per-user breakdown.
 */

import { Hono } from "hono";
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

const adminUsage = new Hono();

/** Returns true if the string is a valid date (parseable by Date). */
function isValidDateParam(value: string): boolean {
  return !isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// GET / — current period usage summary for the active workspace
// ---------------------------------------------------------------------------

adminUsage.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      return c.json({ workspaceId: orgId, ...usage });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch current usage");
      return c.json({ error: "internal_error", message: "Failed to fetch usage data.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /summary — combined usage dashboard payload
// Returns current period usage + plan limits + up to 31 daily history points (today + past 30 days) + per-user breakdown
// ---------------------------------------------------------------------------

adminUsage.get("/summary", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage summary");
      return c.json({ error: "internal_error", message: "Failed to fetch usage summary.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /history — historical usage summaries
// ---------------------------------------------------------------------------

adminUsage.get("/history", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      return c.json({ workspaceId: orgId, period, summaries });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage history");
      return c.json({ error: "internal_error", message: "Failed to fetch usage history.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /breakdown — per-user usage breakdown
// ---------------------------------------------------------------------------

adminUsage.get("/breakdown", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      return c.json({ workspaceId: orgId, users });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch usage breakdown");
      return c.json({ error: "internal_error", message: "Failed to fetch usage breakdown.", requestId }, 500);
    }
  });
});

export { adminUsage };
