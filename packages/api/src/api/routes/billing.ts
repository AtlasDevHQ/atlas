/**
 * Billing API routes.
 *
 * Mounted at /api/v1/billing (conditionally, when STRIPE_SECRET_KEY is set).
 * Provides subscription status, Stripe Customer Portal access, and BYOT toggle.
 *
 * Checkout and webhook routes are handled by the Better Auth Stripe plugin
 * at /api/auth/stripe/* — this file only adds Atlas-specific billing endpoints.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
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
import { getPlanDefinition, getPlanLimits, isUnlimited } from "@atlas/api/lib/billing/plans";
import { buildMetricStatus } from "@atlas/api/lib/billing/enforcement";
import { ErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("billing");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PortalRequestSchema = z.object({
  returnUrl: z.string().optional(),
});

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
          schema: z.record(z.string(), z.unknown()),
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

const createPortalSessionRoute = createRoute({
  method: "post",
  path: "/portal",
  tags: ["Billing"],
  summary: "Create Stripe portal session",
  description:
    "Creates a Stripe Customer Portal session for the active workspace. Returns a URL to redirect the user to.",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: PortalRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Portal session URL",
      content: {
        "application/json": {
          schema: z.object({ url: z.string() }),
        },
      },
    },
    400: {
      description: "No active organization or no Stripe customer",
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
      description: "Billing not available",
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

    // Fetch active subscription from Better Auth's subscription table (if exists)
    let subscription: { stripeSubscriptionId: string; plan: string; status: string } | null = null;
    const subResult = yield* Effect.tryPromise({
      try: () => internalQuery<{
        stripeSubscriptionId: string;
        plan: string;
        status: string;
      }>(
        `SELECT "stripeSubscriptionId", plan, status FROM subscription WHERE "referenceId" = $1 AND status IN ('active', 'trialing') LIMIT 1`,
        [orgId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      // Subscription table may not exist if Stripe plugin hasn't run migrations yet.
      log.debug(
        { err: err.message, orgId },
        "Failed to query subscription table — may not exist yet",
      );
      return Effect.succeed([] as Array<{ stripeSubscriptionId: string; plan: string; status: string }>);
    }));
    if (subResult.length > 0) {
      subscription = subResult[0];
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
    }, 200);
  }), { label: "fetch billing status" });
});

// GET /status is accessible via the root handler since billing is mounted
// at /api/v1/billing — both /api/v1/billing and /api/v1/billing/status work.

// POST /portal — create Stripe Customer Portal session
billing.openapi(createPortalSessionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available." }, 404);
    }

    if (!orgId) {
      return c.json({ error: "org_required", message: "No active organization." }, 400);
    }

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    if (!workspace?.stripe_customer_id) {
      return c.json({ error: "no_customer", message: "No Stripe customer associated with this workspace. Subscribe to a plan first." }, 400);
    }

    let returnUrl: string | undefined;
    try {
      const body = c.req.valid("json");
      returnUrl = body.returnUrl;
    } catch (err) {
      // No body is fine — returnUrl is optional. Log if validation failed on a present body.
      log.debug({ err: err instanceof Error ? err.message : String(err), requestId }, "Portal body parse/validation skipped — using default returnUrl");
    }

    // Non-null: guarded by the !workspace?.stripe_customer_id check above
    const customerId = workspace.stripe_customer_id!;
    const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const session = yield* Effect.promise(() => stripeClient.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || process.env.BETTER_AUTH_URL || "http://localhost:3000",
    }));

    return c.json({ url: session.url }, 200);
  }), { label: "create portal session" });
});

// POST /byot — toggle BYOT (Bring Your Own Token) mode
billing.openapi(toggleByotRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { mode, user, orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Billing is not available." }, 404);
    }

    // Require admin or owner role for BYOT toggle
    if (mode !== "none" && (!user || (user.role !== "admin" && user.role !== "owner"))) {
      return c.json({ error: "forbidden_role", message: "Admin or owner role required to change BYOT setting.", requestId }, 403);
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
