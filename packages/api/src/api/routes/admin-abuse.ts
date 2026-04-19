/**
 * Admin abuse prevention routes.
 *
 * Mounted under /api/v1/admin/abuse. All routes require admin role.
 * Provides listing of flagged workspaces, reinstatement, and threshold config.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import {
  listFlaggedWorkspaces,
  reinstateWorkspace,
  getAbuseEvents,
  getAbuseConfig,
  getAbuseDetail,
} from "@atlas/api/lib/security/abuse";
import { getWorkspaceNamesByIds } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("admin-abuse");
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import {
  AbuseStatusSchema,
  AbuseDetailSchema,
  AbuseThresholdConfigSchema,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema, createListResponseSchema } from "./shared-schemas";
import { createAdminRouter } from "./admin-router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// Wire-format schemas (AbuseStatus / AbuseDetail / AbuseThresholdConfig /
// nested Event/Instance/Counters) live in `@useatlas/schemas` — one source
// shared with the web client so renames can't silently drift. Route-local
// schemas below are the ones that wrap the shared shapes (list envelope)
// or describe route-only responses (reinstate).

const ListResponseSchema = createListResponseSchema("workspaces", AbuseStatusSchema);

const ReinstateResponseSchema = z.object({
  success: z.boolean(),
  workspaceId: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listFlaggedRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Abuse Prevention"],
  summary: "List flagged workspaces",
  description: "SaaS only. Returns all workspaces with active abuse flags (warning, throttled, or suspended).",
  responses: {
    200: {
      description: "Flagged workspaces",
      content: { "application/json": { schema: ListResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const reinstateRoute = createRoute({
  method: "post",
  path: "/{workspaceId}/reinstate",
  tags: ["Admin — Abuse Prevention"],
  summary: "Reinstate a suspended workspace",
  description: "SaaS only. Manually re-enable a workspace that was suspended or throttled due to abuse detection.",
  request: {
    params: z.object({
      workspaceId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Workspace reinstated",
      content: { "application/json": { schema: ReinstateResponseSchema } },
    },
    400: {
      description: "Workspace not flagged",
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

const getDetailRoute = createRoute({
  method: "get",
  path: "/{workspaceId}/detail",
  tags: ["Admin — Abuse Prevention"],
  summary: "Investigation detail for a flagged workspace",
  description:
    "SaaS only. Returns live counters, thresholds, the current flag instance, and up to 5 prior flag instances so operators can investigate without leaving the page.",
  request: {
    params: z.object({
      workspaceId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Investigation detail",
      content: { "application/json": { schema: AbuseDetailSchema } },
    },
    404: {
      description: "Workspace not flagged",
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

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Abuse Prevention"],
  summary: "Current abuse threshold configuration",
  description: "SaaS only. Returns the current abuse detection thresholds (from env vars or defaults).",
  responses: {
    200: {
      description: "Threshold configuration",
      content: { "application/json": { schema: AbuseThresholdConfigSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const adminAbuse = createAdminRouter();

// GET / — list flagged workspaces
adminAbuse.openapi(listFlaggedRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const workspaces = listFlaggedWorkspaces();

    // Enrich with recent events from DB + resolve workspace names so the
    // admin table shows "Acme Corp" instead of "org_01K...". Names are a
    // batch fetch to avoid N+1; missing/deleted orgs fall back to null.
    const enriched = yield* Effect.promise(async () => {
      const orgIds = workspaces.map((ws) => ws.workspaceId);
      const [events, names] = await Promise.all([
        Promise.all(workspaces.map((ws) => getAbuseEvents(ws.workspaceId, 10))),
        getWorkspaceNamesByIds(orgIds).catch((err) => {
          // Name resolution is advisory — if the DB hiccups, fall back to
          // null so the page still renders with opaque ids rather than 500.
          log.warn(
            {
              err: err instanceof Error
                ? { message: err.message, stack: err.stack }
                : String(err),
              orgIdCount: orgIds.length,
              // First 5 ids for on-call correlation without flooding logs.
              sampleOrgIds: orgIds.slice(0, 5),
            },
            "abuse list: workspace name resolution failed",
          );
          return new Map<string, string | null>();
        }),
      ]);
      return workspaces.map((ws, i) => ({
        ...ws,
        workspaceName: names.get(ws.workspaceId) ?? null,
        events: events[i],
      }));
    });

    return c.json({ workspaces: enriched, total: enriched.length }, 200);
  }), { label: "list flagged workspaces" });
});

// POST /:workspaceId/reinstate — reinstate a workspace
adminAbuse.openapi(reinstateRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { workspaceId } = c.req.valid("param");
    const actorId = user?.id ?? "unknown";

    const success = reinstateWorkspace(workspaceId, actorId);
    if (!success) {
      return c.json(
        { error: "not_flagged", message: "Workspace is not currently flagged for abuse.", requestId },
        400,
      );
    }

    return c.json({
      success: true,
      workspaceId,
      message: "Workspace reinstated successfully.",
    }, 200);
  }), { label: "reinstate workspace" });
});

// GET /:workspaceId/detail — investigation detail for a flagged workspace
adminAbuse.openapi(getDetailRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { workspaceId } = c.req.valid("param");

    const detail = yield* Effect.promise(() => getAbuseDetail(workspaceId));
    if (!detail) {
      return c.json(
        {
          error: "not_flagged",
          message: "Workspace is not currently flagged for abuse.",
          requestId,
        },
        404,
      );
    }

    // Resolve the workspace display name. Advisory — see list route above.
    const nameMap = yield* Effect.promise(() =>
      getWorkspaceNamesByIds([workspaceId]).catch((err) => {
        log.warn(
          {
            err: err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
            workspaceId,
          },
          "abuse detail: workspace name resolution failed",
        );
        return new Map<string, string | null>();
      }),
    );
    const enriched = { ...detail, workspaceName: nameMap.get(workspaceId) ?? null };

    return c.json(enriched, 200);
  }), { label: "read abuse detail" });
});

// GET /config — current threshold configuration
adminAbuse.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.sync(() => {
    return c.json(getAbuseConfig(), 200);
  }), { label: "read abuse config" });
});

export { adminAbuse };
