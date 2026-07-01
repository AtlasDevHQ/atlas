/**
 * Member-visible trial status endpoint (#3434).
 *
 * GET /api/v1/trial — standardAuth, NOT adminAuth. The full billing surface
 * (`/api/v1/billing`) is admin-gated, which meant non-admin members first
 * learned their workspace was on a trial when enforcement 403'd their chat
 * on day 14. This endpoint exposes just the trial clock — start, effective
 * end, length, expired flag — so every member (and the signup success page)
 * can see it.
 *
 * `endsAt` is the *effective* trial end from `lib/billing/trial-state.ts`:
 * `trial_ends_at`, falling back to `createdAt + TRIAL_DAYS` — the same date
 * enforcement uses, so a NULL-trial_ends_at workspace still gets an honest
 * countdown. Reads go through enforcement's workspace cache
 * (`getCachedWorkspace`) so this adds no per-request DB load beyond what
 * the chat gate already incurs.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getCachedWorkspace } from "@atlas/api/lib/billing/enforcement";
import { TRIAL_DAYS } from "@atlas/api/lib/billing/plans";
import { effectiveTrialEndsAt, isTrialExpiredAt } from "@atlas/api/lib/billing/trial-state";
import { TrialStatusSchema } from "@useatlas/schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("trial");

const getTrialStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Billing"],
  summary: "Get trial status",
  description:
    "Returns the active workspace's trial clock (start, effective end, length, expired flag), visible to every member. `trial` is null when the workspace is not on a trial.",
  responses: {
    200: {
      description: "Trial status for the active workspace",
      content: {
        "application/json": {
          schema: TrialStatusSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
  },
});

const trial = new OpenAPIHono<AuthEnv>({
  defaultHook: validationHook,
});

trial.use(standardAuth);
trial.use(requestContext);

trial.openapi(getTrialStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    // Self-hosted (no internal DB) or no active org — nothing to report.
    if (!hasInternalDB() || !orgId) {
      return c.json({ trial: null }, 200);
    }

    const workspace = yield* Effect.promise(() => getCachedWorkspace(orgId));
    if (!workspace || workspace.plan_tier !== "trial") {
      return c.json({ trial: null }, 200);
    }

    const effectiveEnd = effectiveTrialEndsAt(workspace);
    if (!effectiveEnd) {
      // Both trial_ends_at and createdAt unparseable — enforcement treats
      // this as "not expired"; report no clock rather than a bogus date.
      log.warn(
        { orgId, trialEndsAt: workspace.trial_ends_at, createdAt: workspace.createdAt },
        "Trial workspace has no parseable effective trial end",
      );
      return c.json({ trial: null }, 200);
    }

    // createdAt can be unparseable while trial_ends_at is fine — fall back
    // to the raw value rather than letting toISOString() throw on NaN.
    const startedMs = new Date(workspace.createdAt).getTime();
    return c.json({
      trial: {
        startedAt: Number.isFinite(startedMs)
          ? new Date(startedMs).toISOString()
          : String(workspace.createdAt),
        endsAt: effectiveEnd.toISOString(),
        trialDays: TRIAL_DAYS,
        expired: isTrialExpiredAt(effectiveEnd),
      },
    }, 200);
  }), { label: "fetch trial status" });
});

export { trial };
