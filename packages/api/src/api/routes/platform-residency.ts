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
import { createLogger } from "@atlas/api/lib/logger";
import { runHandler, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { ResidencyError, type ResidencyErrorCode } from "@atlas/ee/platform/residency";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-residency");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RegionStatusSchema = z.object({
  region: z.string(),
  label: z.string(),
  workspaceCount: z.number(),
  healthy: z.boolean(),
});

const WorkspaceRegionSchema = z.object({
  workspaceId: z.string(),
  region: z.string(),
  assignedAt: z.string(),
});

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
        "application/json": {
          schema: z.object({
            regions: z.array(RegionStatusSchema),
            defaultRegion: z.string(),
          }),
        },
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
  path: "/workspaces/:id/region",
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
  path: "/workspaces/:id/region",
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
      content: { "application/json": { schema: z.object({ assignments: z.array(WorkspaceRegionSchema) }) } },
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

const RESIDENCY_ERROR_STATUS: Record<ResidencyErrorCode, ContentfulStatusCode> = {
  not_configured: 404,
  invalid_region: 400,
  already_assigned: 409,
  workspace_not_found: 404,
  no_internal_db: 503,
};

const residencyDomainErrors: DomainErrorMapping[] = [
  [ResidencyError, RESIDENCY_ERROR_STATUS],
];

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

platformResidency.openapi(listRegionsRoute, async (c) => runHandler(c, "list regions", async () => {
  const requestId = c.get("requestId");

  const mod = await loadResidency();
  if (!mod) {
    return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
  }

  const regions = await mod.listRegions();
  const defaultRegion = mod.getDefaultRegion();
  return c.json({ regions, defaultRegion }, 200);
}, { domainErrors: residencyDomainErrors }));

// ── Get workspace region ─────────────────────────────────────────────

platformResidency.openapi(getWorkspaceRegionRoute, async (c) => runHandler(c, "get workspace region", async () => {
  const requestId = c.get("requestId");
  const workspaceId = c.req.param("id");

  const mod = await loadResidency();
  if (!mod) {
    return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
  }

  const assignment = await mod.getWorkspaceRegionAssignment(workspaceId);
  if (!assignment) {
    return c.json({ error: "not_found", message: `Workspace "${workspaceId}" has no region assigned.`, requestId }, 404);
  }
  return c.json(assignment, 200);
}, { domainErrors: residencyDomainErrors }));

// ── Assign region to workspace ───────────────────────────────────────

platformResidency.openapi(assignRegionRoute, async (c) => runHandler(c, "assign region", async () => {
  const requestId = c.get("requestId");
  const workspaceId = c.req.param("id");
  const body = c.req.valid("json");

  const mod = await loadResidency();
  if (!mod) {
    return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
  }

  const assignment = await mod.assignWorkspaceRegion(workspaceId, body.region);
  log.info({ workspaceId, region: body.region, requestId }, "Region assigned to workspace");
  return c.json(assignment, 200);
}, { domainErrors: residencyDomainErrors }));

// ── List all assignments ─────────────────────────────────────────────

platformResidency.openapi(listAssignmentsRoute, async (c) => runHandler(c, "list region assignments", async () => {
  const requestId = c.get("requestId");

  const mod = await loadResidency();
  if (!mod) {
    return c.json({ error: "not_available", message: "Data residency requires enterprise features to be enabled.", requestId }, 404);
  }

  const assignments = await mod.listWorkspaceRegions();
  return c.json({ assignments }, 200);
}, { domainErrors: residencyDomainErrors }));

export { platformResidency };
