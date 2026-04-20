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
import { hasInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import {
  triggerMigrationExecution,
  failStaleMigrations,
  resetMigrationForRetry,
  cancelMigration,
} from "@atlas/api/lib/residency/migrate";
import { MIGRATION_STATUSES } from "@useatlas/types";
import { RegionMigrationSchema, MigrationStatusResponseSchema } from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-residency");

// ---------------------------------------------------------------------------
// Lazy EE loader — fail-graceful when enterprise is disabled
// ---------------------------------------------------------------------------

import { loadResidency, getResidencyDomainError } from "./shared-residency";

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
    "the region cannot be changed after assignment. Business plan required.",
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
// Migration schemas — `RegionMigrationSchema` + `MigrationStatusResponseSchema`
// live in `@useatlas/schemas` so the route OpenAPI contract and the web
// parse stay in lockstep. `RequestMigrationBodySchema` is request-only and
// stays local.
// ---------------------------------------------------------------------------

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
      content: { "application/json": { schema: RegionMigrationSchema } },
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

const retryMigrationRoute = createRoute({
  method: "post",
  path: "/migrate/{id}/retry",
  tags: ["Admin — Data Residency"],
  summary: "Retry a failed migration",
  description:
    "Resets a failed migration to pending status and re-triggers execution. " +
    "Only works for migrations in 'failed' status.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Migration retried",
      content: { "application/json": { schema: RegionMigrationSchema } },
    },
    400: {
      description: "Migration cannot be retried",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Migration or internal database not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const cancelMigrationRoute = createRoute({
  method: "post",
  path: "/migrate/{id}/cancel",
  tags: ["Admin — Data Residency"],
  summary: "Cancel a pending migration",
  description:
    "Cancels a migration that is still in 'pending' status. " +
    "In-progress migrations cannot be cancelled.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Migration cancelled",
      content: {
        "application/json": {
          schema: z.object({ cancelled: z.boolean() }),
        },
      },
    },
    400: {
      description: "Migration cannot be cancelled",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Migration or internal database not found",
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
  const mod = await loadResidency();
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

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
        const assignment = yield* mod.getWorkspaceRegionAssignment(orgId!);
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
    { label: "get residency status", domainErrors: mod ? [getResidencyDomainError(mod)] : undefined },
  );
});

// PUT / — assign region to workspace
adminResidency.openapi(assignRegionRoute, async (c) => {
  const mod = await loadResidency();
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;
      const { region } = c.req.valid("json");

      if (!mod) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment." }, 404);
      }

      const result = yield* mod.assignWorkspaceRegion(orgId!, region as string);
      log.info({ orgId, region }, "Workspace region assigned via self-serve");
      return c.json(result, 200);
    }),
    { label: "assign workspace region", domainErrors: mod ? [getResidencyDomainError(mod)] : undefined },
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

      const rows = yield* queryEffect<{
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
  const mod = await loadResidency();
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

      if (!mod) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment.", requestId }, 404);
      }

      // Validate workspace has a region assigned
      const assignment = yield* mod.getWorkspaceRegionAssignment(orgId);
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
      const existing = yield* queryEffect<{ id: string; status: string }>(
        `SELECT id, status FROM region_migrations
         WHERE workspace_id = $1 AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [orgId],
      );
      if (existing.length > 0) {
        return c.json({
          error: "migration_active",
          message: "A migration is already pending or in progress for this workspace.",
          requestId,
        }, 409);
      }

      // Rate limit: one migration per 30 days
      const recent = yield* queryEffect<{ id: string }>(
        `SELECT id FROM region_migrations
         WHERE workspace_id = $1 AND requested_at > NOW() - INTERVAL '30 days'
         LIMIT 1`,
        [orgId],
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

      yield* queryEffect(
        `INSERT INTO region_migrations (id, workspace_id, source_region, target_region, status, requested_by, requested_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
        [migrationId, orgId, assignment.region, targetRegion, requestedBy, now],
      );

      log.info(
        { requestId, orgId, migrationId, sourceRegion: assignment.region, targetRegion, userId: requestedBy },
        "Region migration requested",
      );

      // Trigger background execution (Phase 2)
      triggerMigrationExecution(migrationId);

      // Also check for stale migrations while we're here
      failStaleMigrations().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "Stale migration check failed");
      });

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
    { label: "request region migration", domainErrors: mod ? [getResidencyDomainError(mod)] : undefined },
  );
});

// ---------------------------------------------------------------------------
// POST /migrate/:id/retry — retry a failed migration
// ---------------------------------------------------------------------------

adminResidency.openapi(retryMigrationRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id } = c.req.valid("param");

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Migration tracking requires an internal database.", requestId }, 404);
      }

      const result = yield* Effect.promise(() => resetMigrationForRetry(id, orgId!));
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 400;
        return c.json({ error: "retry_failed", message: result.error, requestId }, status as 400 | 404);
      }

      // Re-trigger execution
      triggerMigrationExecution(id);

      // Fetch updated migration to return
      const rows = yield* queryEffect<{
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
         FROM region_migrations WHERE id = $1 AND workspace_id = $2`,
        [id, orgId],
      );

      const row = rows[0];
      if (!row) {
        return c.json({ error: "retry_failed", message: "Migration record not found after reset.", requestId }, 404);
      }

      log.info({ requestId, migrationId: id }, "Migration retry triggered");

      return c.json({
        id: row.id,
        workspaceId: row.workspace_id,
        sourceRegion: row.source_region,
        targetRegion: row.target_region,
        status: row.status as typeof MIGRATION_STATUSES[number],
        requestedBy: row.requested_by,
        requestedAt: row.requested_at,
        completedAt: row.completed_at,
        errorMessage: row.error_message,
      }, 200);
    }),
    { label: "retry region migration" },
  );
});

// ---------------------------------------------------------------------------
// POST /migrate/:id/cancel — cancel a pending migration
// ---------------------------------------------------------------------------

adminResidency.openapi(cancelMigrationRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id } = c.req.valid("param");

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Migration tracking requires an internal database.", requestId }, 404);
      }

      const result = yield* Effect.promise(() => cancelMigration(id, orgId!));
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 400;
        return c.json({ error: "cancel_failed", message: result.error, requestId }, status as 400 | 404);
      }

      log.info({ requestId, migrationId: id }, "Migration cancelled");
      return c.json({ cancelled: true }, 200);
    }),
    { label: "cancel region migration" },
  );
});

export { adminResidency };
