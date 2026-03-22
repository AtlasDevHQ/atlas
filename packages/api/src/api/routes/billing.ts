/**
 * Billing API routes.
 *
 * Mounted at /api/v1/billing (conditionally, when STRIPE_SECRET_KEY is set).
 * Provides subscription status, Stripe Customer Portal access, and BYOT toggle.
 *
 * Checkout and webhook routes are handled by the Better Auth Stripe plugin
 * at /api/auth/stripe/* — this file only adds Atlas-specific billing endpoints.
 */

import { Hono } from "hono";
import Stripe from "stripe";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import {
  hasInternalDB,
  getWorkspaceDetails,
  updateWorkspaceByot,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { getPlanDefinition, getPlanLimits, isUnlimited } from "@atlas/api/lib/billing/plans";
import { buildMetricStatus } from "@atlas/api/lib/billing/enforcement";

const log = createLogger("billing");

const billing = new Hono();

// ---------------------------------------------------------------------------
// Auth preamble (authenticated user, not admin-only)
// ---------------------------------------------------------------------------

async function billingAuthPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error", requestId }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    return { error: { error: "auth_error", message: authResult.error, requestId }, status: authResult.status as 401 | 403 | 500 };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

// ---------------------------------------------------------------------------
// GET / — billing status for the active workspace
// ---------------------------------------------------------------------------

billing.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await billingAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available (no internal database)." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    try {
      const [workspace, usage] = await Promise.all([
        getWorkspaceDetails(orgId),
        getCurrentPeriodUsage(orgId),
      ]);

      if (!workspace) {
        return c.json({ error: "not_found", message: "Workspace not found." }, 404);
      }

      const plan = getPlanDefinition(workspace.plan_tier);
      const limits = getPlanLimits(workspace.plan_tier);

      // Fetch active subscription from Better Auth's subscription table (if exists)
      let subscription: { stripeSubscriptionId: string; plan: string; status: string } | null = null;
      try {
        const subRows = await internalQuery<{
          stripeSubscriptionId: string;
          plan: string;
          status: string;
        }>(
          `SELECT "stripeSubscriptionId", plan, status FROM subscription WHERE "referenceId" = $1 AND status IN ('active', 'trialing') LIMIT 1`,
          [orgId],
        );
        if (subRows.length > 0) {
          subscription = subRows[0];
        }
      } catch (err) {
        // Subscription table may not exist if Stripe plugin hasn't run migrations yet.
        log.debug(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to query subscription table — may not exist yet",
        );
      }

      // Compute overage status for each metered dimension (reuses shared thresholds from enforcement)
      const queryLimit = isUnlimited(limits.queriesPerMonth) ? null : limits.queriesPerMonth;
      const tokenLimit = isUnlimited(limits.tokensPerMonth) ? null : limits.tokensPerMonth;

      const queryOverage = queryLimit !== null
        ? buildMetricStatus("queries", usage.queryCount, queryLimit)
        : { usagePercent: 0, status: "ok" as const };
      const tokenOverage = tokenLimit !== null
        ? buildMetricStatus("tokens", usage.tokenCount, tokenLimit)
        : { usagePercent: 0, status: "ok" as const };

      return c.json({
        workspaceId: orgId,
        plan: {
          tier: workspace.plan_tier,
          displayName: plan.displayName,
          byot: workspace.byot,
          trialEndsAt: workspace.trial_ends_at,
        },
        limits: {
          queriesPerMonth: queryLimit,
          tokensPerMonth: tokenLimit,
          maxMembers: isUnlimited(limits.maxMembers) ? null : limits.maxMembers,
          maxConnections: isUnlimited(limits.maxConnections) ? null : limits.maxConnections,
        },
        usage: {
          queryCount: usage.queryCount,
          tokenCount: usage.tokenCount,
          queryUsagePercent: queryOverage.usagePercent,
          tokenUsagePercent: tokenOverage.usagePercent,
          queryOverageStatus: queryOverage.status,
          tokenOverageStatus: tokenOverage.status,
          periodStart: usage.periodStart,
          periodEnd: usage.periodEnd,
        },
        subscription: subscription ? {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          plan: subscription.plan,
          status: subscription.status,
        } : null,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch billing status");
      return c.json({ error: "internal_error", message: "Failed to fetch billing status.", requestId }, 500);
    }
  });
});

// GET /status is accessible via the root handler since billing is mounted
// at /api/v1/billing — both /api/v1/billing and /api/v1/billing/status work.

// ---------------------------------------------------------------------------
// POST /portal — create Stripe Customer Portal session
// ---------------------------------------------------------------------------

billing.post("/portal", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await billingAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization." }, 400);
    }

    try {
      const workspace = await getWorkspaceDetails(orgId);
      if (!workspace?.stripe_customer_id) {
        return c.json({ error: "no_customer", message: "No Stripe customer associated with this workspace. Subscribe to a plan first." }, 400);
      }

      let returnUrl: string | undefined;
      try {
        const raw = await req.json() as Record<string, unknown>;
        if (typeof raw?.returnUrl === "string") returnUrl = raw.returnUrl;
      } catch {
        // No body is fine — returnUrl is optional
      }

      const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const session = await stripeClient.billingPortal.sessions.create({
        customer: workspace.stripe_customer_id,
        return_url: returnUrl || process.env.BETTER_AUTH_URL || "http://localhost:3000",
      });

      return c.json({ url: session.url });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to create portal session");
      return c.json({ error: "internal_error", message: "Failed to create billing portal session.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /byot — toggle BYOT (Bring Your Own Token) mode
// ---------------------------------------------------------------------------

billing.post("/byot", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await billingAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available." }, 404);
    }

    // Require admin or owner role for BYOT toggle
    if (authResult.mode !== "none" && (!authResult.user || (authResult.user.role !== "admin" && authResult.user.role !== "owner"))) {
      return c.json({ error: "forbidden_role", message: "Admin or owner role required to change BYOT setting." }, 403);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization." }, 400);
    }

    let enabled: boolean;
    try {
      const raw = await req.json() as Record<string, unknown>;
      if (typeof raw?.enabled !== "boolean") {
        return c.json({ error: "bad_request", message: "Missing or invalid 'enabled' field. Must be a boolean." }, 400);
      }
      enabled = raw.enabled;
    } catch {
      return c.json({ error: "bad_request", message: "Request body must be JSON with { enabled: boolean }." }, 400);
    }

    try {
      const updated = await updateWorkspaceByot(orgId, enabled);
      if (!updated) {
        return c.json({ error: "not_found", message: "Workspace not found." }, 404);
      }

      log.info({ orgId, byot: enabled, userId: authResult.user?.id }, "BYOT mode toggled");
      return c.json({ workspaceId: orgId, byot: enabled });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update BYOT setting");
      return c.json({ error: "internal_error", message: "Failed to update BYOT setting.", requestId }, 500);
    }
  });
});

export { billing };
