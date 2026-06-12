/**
 * Billing API routes.
 *
 * Mounted at /api/v1/billing (conditionally, when STRIPE_SECRET_KEY is set).
 * Provides subscription status and the BYOT toggle.
 *
 * Checkout, webhook, AND Customer Portal routes are handled by the Better
 * Auth Stripe plugin at /api/auth/* — this file only adds Atlas-specific
 * billing endpoints. The hand-rolled POST /portal route was deleted in
 * #3417: the plugin's org-aware `/api/auth/subscription/billing-portal`
 * (driven from the web client via `authClient.subscription.billingPortal`)
 * replaced it, reading the plugin-owned organization."stripeCustomerId"
 * and enforcing `authorizeReference`.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import {
  hasInternalDB,
  getWorkspaceDetails,
  updateWorkspaceByot,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { getPlanDefinition, getPlanLimits, getStripePlans, computeTokenBudget, isUnlimited, type PaidPlanTier } from "@atlas/api/lib/billing/plans";
import { buildMetricStatus } from "@atlas/api/lib/billing/enforcement";
import { effectiveTrialEndsAt } from "@atlas/api/lib/billing/trial-expiry";
import { getSettingLive } from "@atlas/api/lib/settings";
import { resolveModelId } from "@atlas/api/lib/providers";
import { BillingStatusSchema } from "@useatlas/schemas";
import { ADMIN_ROLES, type AdminRole } from "@useatlas/types/auth";
import { ErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("billing");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ByotRequestSchema = z.object({
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getBillingStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Billing"],
  summary: "Get billing status",
  description:
    "Returns the billing status for the active workspace, including plan details, usage metrics, and subscription info.",
  responses: {
    200: {
      description: "Billing status for the workspace",
      content: {
        "application/json": {
          schema: BillingStatusSchema,
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Billing not available or workspace not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const toggleByotRoute = createRoute({
  method: "post",
  path: "/byot",
  tags: ["Billing"],
  summary: "Toggle BYOT mode",
  description:
    "Enables or disables Bring Your Own Token (BYOT) mode for the active workspace. Requires admin or owner role.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ByotRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "BYOT mode updated",
      content: {
        "application/json": {
          schema: z.object({
            workspaceId: z.string(),
            byot: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: "Bad request — missing or invalid body, or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — admin or owner role required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Billing not available or workspace not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Available plans (#3418)
// ---------------------------------------------------------------------------

/**
 * Paid tiers the plan picker can move a workspace to. `configured` is
 * derived from {@link getStripePlans} — a tier without its Stripe Price ID
 * env var renders as a disabled card rather than disappearing, so a
 * misconfigured deployment is visible instead of silently smaller.
 */
function buildAvailablePlans(): Array<{
  tier: PaidPlanTier;
  displayName: string;
  pricePerSeat: number;
  tokenBudgetPerSeat: number | null;
  maxSeats: number | null;
  maxConnections: number | null;
  configured: boolean;
}> {
  const configured = new Set(getStripePlans().map((p) => p.name));
  return (["starter", "pro", "business"] as const).map((tier) => {
    const def = getPlanDefinition(tier);
    return {
      tier,
      displayName: def.displayName,
      pricePerSeat: def.pricePerSeat,
      tokenBudgetPerSeat: isUnlimited(def.limits.tokenBudgetPerSeat) ? null : def.limits.tokenBudgetPerSeat,
      maxSeats: isUnlimited(def.limits.maxSeats) ? null : def.limits.maxSeats,
      maxConnections: isUnlimited(def.limits.maxConnections) ? null : def.limits.maxConnections,
      configured: configured.has(tier),
    };
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const billing = new OpenAPIHono<AuthEnv>({
  defaultHook: validationHook,
});

billing.use(adminAuth);
billing.use(requestContext);

// GET / — billing status for the active workspace
billing.openapi(getBillingStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available (no internal database)." }, 404);
    }

    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization. Select a workspace first." }, 400);
    }

    const [workspace, usage] = yield* Effect.promise(() => Promise.all([
      getWorkspaceDetails(orgId),
      getCurrentPeriodUsage(orgId),
    ]));

    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found." }, 404);
    }

    const plan = getPlanDefinition(workspace.plan_tier);
    const limits = getPlanLimits(workspace.plan_tier);

    // Fetch seat count, connection count, subscription, and the saved model +
    // provider settings in parallel
    const [seatCountResult, connectionCountResult, subResult, currentModelSetting, providerSetting] = yield* Effect.promise(() => Promise.all([
      // Actual member count from Better Auth's member table
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM member WHERE "organizationId" = $1`,
        [orgId],
      ).catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to query member table for seat count — defaulting to 1",
        );
        return [{ count: 1 }] as Array<{ count: number }>;
      }),
      // Connection count for this workspace. Exclude per-workspace
      // archive tombstones so a hidden demo install doesn't inflate the
      // billing-page count. Datasource installs live in workspace_plugins
      // post-0096 cutover (#2744 / ADR-0007).
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM workspace_plugins
          WHERE workspace_id = $1 AND pillar = 'datasource' AND status != 'archived'`,
        [orgId],
      ).catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to query workspace_plugins for connection count — defaulting to 0",
        );
        return [{ count: 0 }] as Array<{ count: number }>;
      }),
      // Active subscription from Better Auth's subscription table
      internalQuery<{
        stripeSubscriptionId: string;
        plan: string;
        status: string;
      }>(
        `SELECT "stripeSubscriptionId", plan, status FROM subscription WHERE "referenceId" = $1 AND status IN ('active', 'trialing') LIMIT 1`,
        [orgId],
      ).catch((err) => {
        // Subscription table may not exist if Stripe plugin hasn't run migrations yet.
        log.debug(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to query subscription table — may not exist yet",
        );
        return [] as Array<{ stripeSubscriptionId: string; plan: string; status: string }>;
      }),
      // Current model setting (live read for accuracy)
      getSettingLive("ATLAS_MODEL", orgId).catch((err) => {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to read ATLAS_MODEL setting — using plan default",
        );
        return undefined;
      }),
      // Provider setting — mirrors the agent loop's resolution so the reported
      // default matches what actually runs. Usually unset (env/VERCEL picks the
      // provider), in which case resolveModelId falls back to env + defaults.
      getSettingLive("ATLAS_PROVIDER", orgId).catch((err) => {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "Failed to read ATLAS_PROVIDER setting — resolving provider from env",
        );
        return undefined;
      }),
    ]));

    const seatCount = Math.max(1, seatCountResult[0]?.count ?? 1);
    const connectionCount = connectionCountResult[0]?.count ?? 0;
    const subscription = subResult.length > 0 ? subResult[0] : null;
    // SSOT (#3098): currentModel is exactly what the agent loop resolves for
    // this workspace — the saved ATLAS_MODEL if present, else the provider's
    // default (gateway → Sonnet 4.6). The billing "Default AI model" picker
    // displays this verbatim, so it can never advertise a model the engine
    // won't actually run. Falls back to the plan's recommended model only if
    // resolution throws (e.g. an openai-compatible provider with no model set).
    let currentModel: string;
    try {
      currentModel = resolveModelId(providerSetting, currentModelSetting);
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Model resolution failed for billing currentModel — using plan default",
      );
      currentModel = currentModelSetting || plan.defaultModel || "default";
    }

    // Compute per-seat token budget (scales with actual seat count)
    const totalTokenBudget = computeTokenBudget(workspace.plan_tier, seatCount);
    const tokenLimit = isUnlimited(totalTokenBudget) ? null : totalTokenBudget;

    const tokenOverage = tokenLimit !== null
      ? buildMetricStatus("tokens", usage.tokenCount, tokenLimit)
      : { usagePercent: 0, status: "ok" as const };

    return c.json({
      workspaceId: orgId,
      plan: {
        tier: workspace.plan_tier,
        displayName: plan.displayName,
        pricePerSeat: plan.pricePerSeat,
        defaultModel: plan.defaultModel,
        byot: workspace.byot,
        trialEndsAt: workspace.trial_ends_at,
        // Effective trial end (#3434): trial_ends_at falling back to
        // createdAt + TRIAL_DAYS — the SAME date enforcement cuts the
        // workspace off at, so a NULL trial_ends_at workspace still gets a
        // countdown instead of a silent day-14 cutoff. Server-computed so
        // the web never re-derives the fallback rule.
        trialEndsAtEffective:
          workspace.plan_tier === "trial"
            ? effectiveTrialEndsAt(workspace)?.toISOString() ?? null
            : null,
        trialDays: plan.trialDays ?? null,
      },
      limits: {
        tokenBudgetPerSeat: isUnlimited(limits.tokenBudgetPerSeat) ? null : limits.tokenBudgetPerSeat,
        totalTokenBudget: tokenLimit,
        maxSeats: isUnlimited(limits.maxSeats) ? null : limits.maxSeats,
        maxConnections: isUnlimited(limits.maxConnections) ? null : limits.maxConnections,
      },
      usage: {
        queryCount: usage.queryCount,
        tokenCount: usage.tokenCount,
        seatCount,
        tokenUsagePercent: tokenOverage.usagePercent,
        tokenOverageStatus: tokenOverage.status,
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
      },
      seats: {
        count: seatCount,
        max: isUnlimited(limits.maxSeats) ? null : limits.maxSeats,
      },
      connections: {
        count: connectionCount,
        max: isUnlimited(limits.maxConnections) ? null : limits.maxConnections,
      },
      currentModel,
      overagePerMillionTokens: plan.overagePerMillionTokens,
      subscription: subscription ? {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        plan: subscription.plan,
        status: subscription.status,
      } : null,
      availablePlans: buildAvailablePlans(),
    }, 200);
  }), { label: "fetch billing status" });
});

// GET /status is accessible via the root handler since billing is mounted
// at /api/v1/billing — both /api/v1/billing and /api/v1/billing/status work.

// POST /byot — toggle BYOT (Bring Your Own Token) mode
billing.openapi(toggleByotRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { mode, user, orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available." }, 404);
    }

    // Require admin, owner, or platform_admin role for BYOT toggle. The
    // outer `adminAuth` already accepts the same set, but BYOT historically
    // re-asserted the gate inline and forgot platform_admin (#2240) — keep
    // the source of truth on `ADMIN_ROLES` so future role additions don't
    // need to find every duplicated literal.
    if (mode !== "none" && (!user || !user.role || !ADMIN_ROLES.includes(user.role as AdminRole))) {
      return c.json({ error: "forbidden_role", message: "Admin, owner, or platform admin role required to change BYOT setting.", requestId }, 403);
    }

    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization." }, 400);
    }

    const { enabled } = c.req.valid("json");

    const updated = yield* Effect.promise(() => updateWorkspaceByot(orgId, enabled));
    if (!updated) {
      return c.json({ error: "not_found", message: "Workspace not found." }, 404);
    }

    log.info({ orgId, byot: enabled, userId: user?.id }, "BYOT mode toggled");
    return c.json({ workspaceId: orgId, byot: enabled }, 200);
  }), { label: "update BYOT setting" });
});

// ---------------------------------------------------------------------------
// Error handler — catches malformed JSON on POST routes
// ---------------------------------------------------------------------------

billing.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

export { billing };
