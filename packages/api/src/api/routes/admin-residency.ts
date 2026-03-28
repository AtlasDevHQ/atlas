/**
 * Admin data residency routes.
 *
 * Mounted under /api/v1/admin/residency. All routes require admin role
 * and org context. Provides workspace-level region viewing and assignment.
 *
 * Enterprise-gated — returns 404 when enterprise features are disabled
 * or residency is not configured.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-residency");

// ---------------------------------------------------------------------------
// Lazy EE loader — fail-graceful when enterprise is disabled
// ---------------------------------------------------------------------------

type ResidencyModule = typeof import("@atlas/ee/platform/residency");

async function loadResidency(): Promise<ResidencyModule | null> {
  try {
    return await import("@atlas/ee/platform/residency");
  } catch (err) {
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RegionSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
});

const ResidencyStatusSchema = z.object({
  /** Whether residency is configured in this deployment */
  configured: z.boolean(),
  /** Current workspace region (null if unassigned) */
  region: z.string().nullable(),
  /** Region display label (null if unassigned) */
  regionLabel: z.string().nullable(),
  /** When the region was assigned (null if unassigned) */
  assignedAt: z.string().nullable(),
  /** Default region for new workspaces */
  defaultRegion: z.string(),
  /** All available regions */
  availableRegions: z.array(RegionSchema),
});

const AssignRegionBodySchema = z.object({
  region: z.string().min(1),
});

const AssignRegionResponseSchema = z.object({
  workspaceId: z.string(),
  region: z.string(),
  assignedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Data Residency"],
  summary: "Get workspace data residency status",
  description:
    "Returns the data residency configuration for the current workspace, " +
    "including the assigned region (if any) and available regions.",
  responses: {
    200: {
      description: "Residency status",
      content: {
        "application/json": { schema: ResidencyStatusSchema },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const assignRegionRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Data Residency"],
  summary: "Assign data residency region to workspace",
  description:
    "Assigns a region to the current workspace. This action is permanent — " +
    "the region cannot be changed after assignment. Enterprise plan required.",
  request: {
    body: {
      content: {
        "application/json": { schema: AssignRegionBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Region assigned",
      content: {
        "application/json": { schema: AssignRegionResponseSchema },
      },
    },
    400: {
      description: "Invalid region or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Enterprise features not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Region already assigned (immutable)",
      content: { "application/json": { schema: ErrorSchema } },
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

const adminResidency = createAdminRouter();

adminResidency.use(requireOrgContext());

// GET / — workspace residency status
adminResidency.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      const mod = yield* Effect.promise(() => loadResidency());
      if (!mod) {
        return c.json(
          {
            configured: false,
            region: null,
            regionLabel: null,
            assignedAt: null,
            defaultRegion: "none",
            availableRegions: [],
          },
          200,
        );
      }

      let configured = true;
      let defaultRegion = "";
      let availableRegions: Array<{ id: string; label: string; isDefault: boolean }> = [];

      try {
        defaultRegion = mod.getDefaultRegion();
        const regions = mod.getConfiguredRegions();
        availableRegions = Object.entries(regions).map(([id, cfg]) => ({
          id,
          label: cfg.label,
          isDefault: id === defaultRegion,
        }));
      } catch (err) {
        if (err instanceof mod.ResidencyError && err.code === "not_configured") {
          configured = false;
        } else {
          throw err;
        }
      }

      let region: string | null = null;
      let regionLabel: string | null = null;
      let assignedAt: string | null = null;

      if (configured) {
        const assignment = yield* Effect.promise(() => mod.getWorkspaceRegionAssignment(orgId!));
        if (assignment) {
          region = assignment.region;
          regionLabel =
            availableRegions.find((r) => r.id === assignment.region)?.label ?? assignment.region;
          assignedAt = assignment.assignedAt;
        }
      }

      return c.json(
        {
          configured,
          region,
          regionLabel,
          assignedAt,
          defaultRegion: defaultRegion || "none",
          availableRegions,
        },
        200,
      );
    }),
    { label: "get residency status" },
  );
});

// PUT / — assign region to workspace
adminResidency.openapi(assignRegionRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;
      const { region } = c.req.valid("json");

      const mod = yield* Effect.promise(() => loadResidency());
      if (!mod) {
        return c.json({ error: "Data residency is not available in this deployment." }, 404);
      }

      try {
        const result = yield* Effect.promise(() => mod.assignWorkspaceRegion(orgId!, region as string));
        log.info({ orgId, region }, "Workspace region assigned via self-serve");
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof mod.ResidencyError) {
          switch (err.code) {
            case "invalid_region":
              return c.json({ error: err.message }, 400);
            case "already_assigned":
              return c.json({ error: err.message }, 409);
            case "workspace_not_found":
              return c.json({ error: err.message }, 404);
            case "no_internal_db":
              return c.json({ error: err.message }, 503);
            case "not_configured":
              return c.json({ error: err.message }, 404);
          }
        }
        throw err;
      }
    }),
    { label: "assign workspace region" },
  );
});

export { adminResidency };
