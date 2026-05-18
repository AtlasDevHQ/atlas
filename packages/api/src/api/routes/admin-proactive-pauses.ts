/**
 * Admin routes for the proactive-chat kill switch (#2295, PRD #2291).
 *
 * Mounted at /api/v1/admin/proactive/pause. Two routes — both
 * workspace-scoped — manage the `workspace-kill` layer of the
 * pause registry. The other layers are user-driven:
 *
 *   - `channel-24h`: written by the chat plugin when a user posts
 *     `@atlas pause` in a channel.
 *   - `user-optout`: written by the chat plugin when a user DMs
 *     the literal `unsubscribe`.
 *   - `admin-channel`: persisted by the channel-config surface (#2294).
 *
 * Enterprise-gated: every mutation yields `ProactiveGate` from
 * `@atlas/api/lib/effect/services` and calls `.requireEnabled()`.
 * Self-hosted callers without enterprise see 403 with a typed
 * `EnterpriseError` (the no-op `ProactiveGate` default fails closed —
 * EE overlays `Effect.void` when `ATLAS_ENTERPRISE_ENABLED=true`).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  AuthContext,
  ProactiveGate,
  RequestContext,
} from "@atlas/api/lib/effect/services";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  expirePauses,
  isPaused,
  persistPause,
} from "@atlas/api/lib/proactive/pause-registry";
import { AuthErrorSchema, ErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-proactive-pauses");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PauseStatusSchema = z.object({
  /** True iff a workspace-kill row is currently active. */
  workspaceKillActive: z.boolean(),
  /** ISO timestamp when the kill expires; omitted on indefinite kills. */
  expiresAt: z.string().nullable().optional(),
});

const PauseActionResponseSchema = z.object({
  ok: z.literal(true),
  workspaceKillActive: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getPauseStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Proactive Chat"],
  summary: "Get the workspace-wide proactive kill switch status",
  description:
    "Returns whether the workspace currently has a `workspace-kill` pause row active. Other pause layers (per-channel, per-user) are exposed under separate surfaces.",
  responses: {
    200: {
      description: "Pause status",
      content: { "application/json": { schema: PauseStatusSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: {
      description: "Forbidden — admin role required or enterprise not enabled",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const enableKillSwitchRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Proactive Chat"],
  summary: "Enable the workspace-wide proactive kill switch",
  description:
    "Inserts an indefinite `workspace-kill` row. Atlas stops interjecting in every channel of the workspace until the kill switch is lifted. Idempotent — re-enabling while already on is a no-op.",
  responses: {
    200: {
      description: "Kill switch enabled (or already on)",
      content: { "application/json": { schema: PauseActionResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: {
      description: "Forbidden — admin role required or enterprise not enabled",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const liftKillSwitchRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Proactive Chat"],
  summary: "Lift the workspace-wide proactive kill switch",
  description:
    "Expires every active `workspace-kill` row (sets expires_at = NOW()). Atlas resumes interjecting in channels that are not otherwise paused by admin / channel / user layers. Idempotent.",
  responses: {
    200: {
      description: "Kill switch lifted (or already off)",
      content: { "application/json": { schema: PauseActionResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: {
      description: "Forbidden — admin role required or enterprise not enabled",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminProactivePauses = createAdminRouter();
adminProactivePauses.use(requireOrgContext());
// Matches sibling proactive admin routers (admin-proactive.ts,
// admin-proactive-public-dataset.ts) — keeps the permission flag
// consistent across the surface so a future split of `admin:settings`
// from generic admin can't accidentally widen the workspace-kill switch
// past the rest of the proactive admin pages.
adminProactivePauses.use(requirePermission("admin:settings"));

// Internal sentinel — `isPaused` is called with a synthetic channelId so
// the workspace-kill branch fires even when no real channel exists.
// Workspace-kill rows store NULL channel_id, NULL user_id; the lookup
// joins workspace_id only.
const WORKSPACE_PROBE_CHANNEL = "__atlas_workspace_probe__";

/** GET / — status. */
adminProactivePauses.openapi(getPauseStatusRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization.", requestId },
          400,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          { workspaceKillActive: false } satisfies z.infer<typeof PauseStatusSchema>,
          200,
        );
      }

      // Admin inspection — opt into fail-OPEN so a transient DB error
      // surfaces as a 500 instead of silently rendering "kill switch
      // active" to the UI. See `isPaused` doc for the runtime-vs-admin
      // posture split.
      const decision = yield* Effect.promise(() =>
        isPaused({
          workspaceId: orgId,
          channelId: WORKSPACE_PROBE_CHANNEL,
          failOpenOnError: true,
        }),
      );
      const workspaceKillActive = decision.layer === "workspace-kill";
      return c.json(
        {
          workspaceKillActive,
          expiresAt:
            decision.until != null && workspaceKillActive
              ? new Date(decision.until).toISOString()
              : null,
        } satisfies z.infer<typeof PauseStatusSchema>,
        200,
      );
    }),
    { label: "get proactive pause status" },
  ),
);

/** POST / — enable the workspace-wide kill switch. */
adminProactivePauses.openapi(enableKillSwitchRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization.", requestId },
          400,
        );
      }
      if (!hasInternalDB()) {
        return yield* Effect.fail(
          new EnterpriseError(
            "Workspace-wide pause requires an internal database. Configure DATABASE_URL.",
          ),
        );
      }

      // Idempotent: only insert when no active kill row exists. Bypass
      // the registry's probe to keep the SQL contract narrow. Opt into
      // fail-OPEN so a transient DB error rethrows (admin sees a 500
      // and can retry) instead of silently treating "registry unknown"
      // as "kill already on" — that would skip the INSERT, return ok,
      // and leave the admin thinking the kill switch is live when no
      // row exists.
      const status = yield* Effect.promise(() =>
        isPaused({
          workspaceId: orgId,
          channelId: WORKSPACE_PROBE_CHANNEL,
          failOpenOnError: true,
        }),
      );
      if (status.layer !== "workspace-kill") {
        yield* Effect.promise(() =>
          persistPause({
            workspaceId: orgId,
            channelId: null,
            userId: null,
            layer: "workspace-kill",
            durationMs: null,
            requestedAt: Date.now(),
          }),
        );
        log.info(
          { orgId, requestId, actorId: user?.id },
          "Proactive: workspace-wide kill switch ENABLED",
        );
        logAdminAction({
          actionType: ADMIN_ACTIONS.proactive.workspaceKillEnable,
          targetType: "proactive",
          targetId: "workspace-kill",
          metadata: {},
        });
      }
      return c.json(
        { ok: true as const, workspaceKillActive: true },
        200,
      );
    }),
    { label: "enable proactive workspace kill switch" },
  ),
);

/** DELETE / — lift the workspace-wide kill switch. */
adminProactivePauses.openapi(liftKillSwitchRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization.", requestId },
          400,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          { ok: true as const, workspaceKillActive: false },
          200,
        );
      }
      yield* Effect.promise(() =>
        expirePauses({ workspaceId: orgId, layer: "workspace-kill" }),
      );
      log.info(
        { orgId, requestId, actorId: user?.id },
        "Proactive: workspace-wide kill switch LIFTED",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.workspaceKillDisable,
        targetType: "proactive",
        targetId: "workspace-kill",
        metadata: {},
      });
      return c.json(
        { ok: true as const, workspaceKillActive: false },
        200,
      );
    }),
    { label: "lift proactive workspace kill switch" },
  ),
);

export { adminProactivePauses };
