/**
 * Platform data residency routes — region-based tenant routing.
 *
 * Mounted at /api/v1/platform/residency. All routes require `platform_admin` role.
 *
 * Provides:
 * - GET    /regions                         — list configured regions with workspace counts
 * - GET    /workspaces/:id/region           — get workspace region assignment
 * - POST   /workspaces/:id/region           — assign region to workspace (immutable)
 * - GET    /assignments                     — list all workspace region assignments
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
} from "@atlas/api/lib/effect/services";
import { ResidencyError } from "@atlas/ee/platform/residency";
import {
  WorkspaceRegionSchema,
  RegionsResponseSchema,
  AssignmentsResponseSchema,
} from "@useatlas/schemas";

import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-residency");

// ---------------------------------------------------------------------------
// Schemas — `WorkspaceRegionSchema` and the composite response wrappers
// live in `@useatlas/schemas` so the route OpenAPI contract and the web
// parse share one source of truth. `AssignRegionBodySchema` is
// request-only and stays local. `RegionsResponseSchema` composes
// `RegionStatusSchema` internally, so a direct import isn't needed here.
// ---------------------------------------------------------------------------

const AssignRegionBodySchema = z.object({
  region: z.string().min(1).openapi({
    description: "Region identifier to assign (e.g. 'eu-west', 'us-east')",
    example: "eu-west",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRegionsRoute = createRoute({
  method: "get",
  path: "/regions",
  tags: ["Platform Admin — Residency"],
  summary: "List configured regions",
  description: "SaaS only. Returns all configured regions with workspace counts and health status.",
  responses: {
    200: {
      description: "Regions list",
      content: {
        "application/json": { schema: RegionsResponseSchema },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getWorkspaceRegionRoute = createRoute({
  method: "get",
  path: "/workspaces/{id}/region",
  tags: ["Platform Admin — Residency"],
  summary: "Get workspace region",
  description: "SaaS only. Returns the region assignment for a workspace.",
  responses: {
    200: {
      description: "Workspace region assignment",
      content: { "application/json": { schema: WorkspaceRegionSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found or no region assigned", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const assignRegionRoute = createRoute({
  method: "post",
  path: "/workspaces/{id}/region",
  tags: ["Platform Admin — Residency"],
  summary: "Assign region to workspace",
  description: "SaaS only. Assign a workspace to a geographic region. Region is immutable after assignment.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AssignRegionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Region assigned",
      content: { "application/json": { schema: WorkspaceRegionSchema } },
    },
    400: { description: "Invalid region", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Region already assigned", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listAssignmentsRoute = createRoute({
  method: "get",
  path: "/assignments",
  tags: ["Platform Admin — Residency"],
  summary: "List all workspace region assignments",
  description: "SaaS only. Returns all workspaces that have been assigned to a region.",
  responses: {
    200: {
      description: "Workspace region assignments",
      content: { "application/json": { schema: AssignmentsResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Module loader (lazy import — fail gracefully when ee is unavailable)
// ---------------------------------------------------------------------------

type ResidencyModule = typeof import("@atlas/ee/platform/residency");

const residencyDomainError = domainError(ResidencyError, {
  not_configured: 404,
  invalid_region: 400,
  already_assigned: 409,
  workspace_not_found: 404,
  no_internal_db: 503,
});

async function loadResidency(): Promise<ResidencyModule | null> {
  try {
    return await import("@atlas/ee/platform/residency");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return null;
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load residency module — unexpected error",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformResidency = createPlatformRouter();

// ── List regions ─────────────────────────────────────────────────────

platformResidency.openapi(listRegionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadResidency());
    if (!mod) {
      return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
    }

    const regions = yield* mod.listRegions();
    const defaultRegion = mod.getDefaultRegion();
    return c.json({ regions, defaultRegion }, 200);
  }), { label: "list regions", domainErrors: [residencyDomainError] });
});

// ── Get workspace region ─────────────────────────────────────────────

platformResidency.openapi(getWorkspaceRegionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const workspaceId = c.req.param("id");

    const mod = yield* Effect.promise(() => loadResidency());
    if (!mod) {
      return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
    }

    const assignment = yield* mod.getWorkspaceRegionAssignment(workspaceId);
    if (!assignment) {
      return c.json({ error: "not_found", message: `Workspace "${workspaceId}" has no region assigned.`, requestId }, 404);
    }
    return c.json(assignment, 200);
  }), { label: "get workspace region", domainErrors: [residencyDomainError] });
});

// ── Assign region to workspace ───────────────────────────────────────

platformResidency.openapi(assignRegionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const workspaceId = c.req.param("id");
    const body = c.req.valid("json");

    const mod = yield* Effect.promise(() => loadResidency());
    if (!mod) {
      return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
    }

    const assignment = yield* mod.assignWorkspaceRegion(workspaceId, body.region);
    log.info({ workspaceId, region: body.region, requestId }, "Region assigned to workspace");

    logAdminAction({
      actionType: ADMIN_ACTIONS.residency.assign,
      targetType: "residency",
      targetId: workspaceId,
      scope: "platform",
      metadata: { region: body.region },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json(assignment, 200);
  }), { label: "assign region", domainErrors: [residencyDomainError] });
});

// ── List all assignments ─────────────────────────────────────────────

platformResidency.openapi(listAssignmentsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadResidency());
    if (!mod) {
      return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
    }

    const assignments = yield* mod.listWorkspaceRegions();
    return c.json({ assignments }, 200);
  }), { label: "list region assignments", domainErrors: [residencyDomainError] });
});

export { platformResidency };
