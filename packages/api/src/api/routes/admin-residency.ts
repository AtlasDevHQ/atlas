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
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { MIGRATION_STATUSES } from "@useatlas/types";
import type { RegionMigration } from "@useatlas/types";
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
    503: {
      description: "Service unavailable (no internal database)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Migration schemas
// ---------------------------------------------------------------------------

const MigrationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceRegion: z.string(),
  targetRegion: z.string(),
  status: z.enum(MIGRATION_STATUSES),
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
}) as z.ZodType<RegionMigration>;

const MigrationStatusResponseSchema = z.object({
  migration: MigrationSchema.nullable(),
});

const RequestMigrationBodySchema = z.object({
  targetRegion: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Migration route definitions
// ---------------------------------------------------------------------------

const getMigrationStatusRoute = createRoute({
  method: "get",
  path: "/migration",
  tags: ["Admin — Data Residency"],
  summary: "Get current region migration status",
  description:
    "Returns the most recent region migration request for this workspace, or null if none exists.",
  responses: {
    200: {
      description: "Migration status",
      content: { "application/json": { schema: MigrationStatusResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const requestMigrationRoute = createRoute({
  method: "post",
  path: "/migrate",
  tags: ["Admin — Data Residency"],
  summary: "Request region migration",
  description:
    "Creates a region migration request for the workspace. Phase 1: the request is " +
    "recorded with status 'pending' and fulfilled manually. Rate limited to one request " +
    "per 30 days per workspace.",
  request: {
    body: {
      content: { "application/json": { schema: RequestMigrationBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Migration request created",
      content: { "application/json": { schema: MigrationSchema } },
    },
    400: {
      description: "Invalid target region, same as current, or no region assigned",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Residency or internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "A pending or in-progress migration already exists",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limited — one migration per 30 days",
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
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment." }, 404);
      }

      try {
        const result = yield* Effect.promise(() => mod.assignWorkspaceRegion(orgId!, region as string));
        log.info({ orgId, region }, "Workspace region assigned via self-serve");
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof mod.ResidencyError) {
          switch (err.code) {
            case "invalid_region":
              return c.json({ error: "invalid_region", message: err.message }, 400);
            case "already_assigned":
              return c.json({ error: "already_assigned", message: err.message }, 409);
            case "workspace_not_found":
              return c.json({ error: "workspace_not_found", message: err.message }, 404);
            case "no_internal_db":
              return c.json({ error: "no_internal_db", message: err.message }, 503);
            case "not_configured":
              return c.json({ error: "not_configured", message: err.message }, 404);
          }
        }
        throw err;
      }
    }),
    { label: "assign workspace region" },
  );
});

// ---------------------------------------------------------------------------
// GET /migration — current migration status
// ---------------------------------------------------------------------------

adminResidency.openapi(getMigrationStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Migration tracking requires an internal database.", requestId }, 404);
      }

      const rows = yield* Effect.promise(() =>
        internalQuery<{
          id: string;
          workspace_id: string;
          source_region: string;
          target_region: string;
          status: string;
          requested_by: string | null;
          requested_at: string;
          completed_at: string | null;
          error_message: string | null;
        }>(
          `SELECT id, workspace_id, source_region, target_region, status, requested_by, requested_at, completed_at, error_message
           FROM region_migrations
           WHERE workspace_id = $1
           ORDER BY requested_at DESC
           LIMIT 1`,
          [orgId],
        ),
      );

      const row = rows[0];
      if (!row) {
        return c.json({ migration: null }, 200);
      }

      const status = (MIGRATION_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as typeof MIGRATION_STATUSES[number])
        : "failed";

      return c.json({
        migration: {
          id: row.id,
          workspaceId: row.workspace_id,
          sourceRegion: row.source_region,
          targetRegion: row.target_region,
          status,
          requestedBy: row.requested_by,
          requestedAt: row.requested_at,
          completedAt: row.completed_at,
          errorMessage: row.error_message,
        },
      }, 200);
    }),
    { label: "get migration status" },
  );
});

// ---------------------------------------------------------------------------
// POST /migrate — request region migration
// ---------------------------------------------------------------------------

adminResidency.openapi(requestMigrationRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;
      const { targetRegion } = c.req.valid("json");

      if (!orgId) {
        return c.json({ error: "no_organization", message: "No active organization.", requestId }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Migration tracking requires an internal database.", requestId }, 404);
      }

      // Load residency module — needed to validate regions
      const mod = yield* Effect.promise(() => loadResidency());
      if (!mod) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment.", requestId }, 404);
      }

      // Validate workspace has a region assigned
      const assignment = yield* Effect.promise(() => mod.getWorkspaceRegionAssignment(orgId));
      if (!assignment) {
        return c.json({ error: "no_region", message: "No region is assigned to this workspace. Assign a region first.", requestId }, 400);
      }

      // Validate target region differs from current
      if (assignment.region === targetRegion) {
        return c.json({ error: "same_region", message: "Target region is the same as the current region.", requestId }, 400);
      }

      // Validate target region exists in configured regions
      try {
        if (!mod.isConfiguredRegion(targetRegion)) {
          return c.json({ error: "invalid_region", message: `Region "${targetRegion}" is not configured.`, requestId }, 400);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), targetRegion, requestId }, "isConfiguredRegion check failed");
        return c.json({ error: "invalid_region", message: `Region "${targetRegion}" is not configured.`, requestId }, 400);
      }

      // Check for existing pending/in_progress migration
      const existing = yield* Effect.promise(() =>
        internalQuery<{ id: string; status: string }>(
          `SELECT id, status FROM region_migrations
           WHERE workspace_id = $1 AND status IN ('pending', 'in_progress')
           LIMIT 1`,
          [orgId],
        ),
      );
      if (existing.length > 0) {
        return c.json({
          error: "migration_active",
          message: "A migration is already pending or in progress for this workspace.",
          requestId,
        }, 409);
      }

      // Rate limit: one migration per 30 days
      const recent = yield* Effect.promise(() =>
        internalQuery<{ id: string }>(
          `SELECT id FROM region_migrations
           WHERE workspace_id = $1 AND requested_at > NOW() - INTERVAL '30 days'
           LIMIT 1`,
          [orgId],
        ),
      );
      if (recent.length > 0) {
        return c.json({
          error: "rate_limited",
          message: "Region migration requests are limited to one per 30 days.",
          requestId,
        }, 429);
      }

      // Create migration request
      const migrationId = `mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const requestedBy = user?.id ?? null;

      yield* Effect.promise(() =>
        internalQuery(
          `INSERT INTO region_migrations (id, workspace_id, source_region, target_region, status, requested_by, requested_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
          [migrationId, orgId, assignment.region, targetRegion, requestedBy, now],
        ),
      );

      log.info(
        { requestId, orgId, migrationId, sourceRegion: assignment.region, targetRegion, userId: requestedBy },
        "Region migration requested",
      );

      const migration = {
        id: migrationId,
        workspaceId: orgId,
        sourceRegion: assignment.region,
        targetRegion,
        status: "pending" as const,
        requestedBy,
        requestedAt: now,
        completedAt: null,
        errorMessage: null,
      };

      return c.json(migration, 201);
    }),
    { label: "request region migration" },
  );
});

export { adminResidency };
