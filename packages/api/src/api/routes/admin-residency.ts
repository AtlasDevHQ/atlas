/**
 * Admin data residency routes.
 *
 * Mounted under /api/v1/admin/residency. All routes require admin role
 * and org context. Provides workspace-level region viewing and assignment.
 *
 * Enterprise-gated — returns 404 when enterprise features are disabled
 * or residency is not configured.
 */

import { Cause, Effect, Option } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  triggerMigrationExecution,
  failStaleMigrations,
  resetMigrationForRetry,
  cancelMigration,
} from "@atlas/api/lib/residency/migrate";
import { MIGRATION_STATUSES, type RegionMigration } from "@useatlas/types";
import { RegionMigrationSchema, MigrationStatusResponseSchema } from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

function clientIP(c: Context): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

// Local `errorMessage` — mirrors the helper in `admin-roles.ts` (F-25) so
// residency failure audits never leak connection-string credentials. Inlined
// rather than imported from `@atlas/api/lib/audit` so existing admin tests
// that partial-mock the audit module don't break on a new load-bearing
// export (per CLAUDE.md: "mock.module() must cover every named export").
const ERROR_MESSAGE_MAX = 512;
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s@/]*@/gi, "$1://***@");
  return scrubbed.length > ERROR_MESSAGE_MAX
    ? `${scrubbed.slice(0, ERROR_MESSAGE_MAX - 3)}...`
    : scrubbed;
}

// Extract the primary error from an Effect `Cause` — covers typed failures
// AND defects (rejected `Effect.promise`, `Effect.die`). `Effect.tapError`
// misses defects entirely, so `assignWorkspaceRegion` (which wraps a DB
// write in `Effect.promise`) would silently drop the failure-audit row on
// pool-exhaustion or network drops. `tapErrorCause` + `causeToError`
// closes that gap — the same pattern `admin-roles.ts` uses.
// Returns undefined on pure interrupts (fiber cancellation).
function causeToError(cause: Cause.Cause<unknown>): unknown | undefined {
  if (Cause.isInterruptedOnly(cause)) return undefined;
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return failure.value;
  for (const defect of Cause.defects(cause)) return defect;
  return undefined;
}

const log = createLogger("admin-residency");

// Narrow a DB-sourced migration status string to the canonical tuple.
// Unknown values (schema drift, manual SQL update, legacy rows) are coerced
// to "failed" + a one-time-per-warn log breadcrumb so operators can spot
// drift instead of being silently handed a mislabeled migration.
function narrowMigrationStatus(
  raw: string,
  ctx: { migrationId: string; requestId: string },
): (typeof MIGRATION_STATUSES)[number] {
  if ((MIGRATION_STATUSES as readonly string[]).includes(raw)) {
    return raw as (typeof MIGRATION_STATUSES)[number];
  }
  log.warn(
    { migrationId: ctx.migrationId, dbStatus: raw, requestId: ctx.requestId },
    "coerced unknown migration status to failed",
  );
  return "failed";
}

interface MigrationRow {
  id: string;
  workspace_id: string;
  source_region: string;
  target_region: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  completed_at: string | null;
  error_message: string | null;
  // Satisfy `queryEffect<T extends Record<string, unknown>>` — the query
  // returns this exact column set but the generic constraint needs a
  // catch-all signature.
  [key: string]: unknown;
}

/**
 * Build the discriminated `RegionMigration` variant (#1696) that matches
 * the row's status.
 *
 * Behavior per status when the row's timestamp/error fields contradict
 * the declared status:
 *
 * - **pending / in_progress** — the variant requires `completedAt: null`
 *   and `errorMessage: null`. The fields on the row are ignored; if they
 *   were populated, a warn breadcrumb fires so ops can notice drift.
 * - **completed** — requires `completedAt: string`. If `completed_at` is
 *   null, we fall back to `requestedAt` and warn. `errorMessage` is
 *   always coerced to null.
 * - **failed** — requires `completedAt: string` and `errorMessage: string`.
 *   Missing `completed_at` falls back to `requestedAt`; missing
 *   `error_message` falls back to a stock string. Both paths warn.
 * - **cancelled** — keeps `errorMessage: string | null` for legacy
 *   'Cancelled by admin' rows. Missing `completed_at` falls back to
 *   `requestedAt` with a warn.
 *
 * Unknown status strings are coerced to `"failed"` by
 * `narrowMigrationStatus`, which emits its own warn.
 *
 * The alternative to sanitizing here would be returning null and
 * 404-ing the caller — strictly worse for migrated production data
 * where the row is legit but the columns drifted.
 */
function rowToMigration(
  row: MigrationRow,
  ctx: { requestId: string },
): RegionMigration {
  const status = narrowMigrationStatus(row.status, { migrationId: row.id, requestId: ctx.requestId });
  const base = {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceRegion: row.source_region,
    targetRegion: row.target_region,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
  };
  switch (status) {
    case "pending":
    case "in_progress":
      if (row.completed_at !== null || row.error_message !== null) {
        log.warn(
          {
            migrationId: row.id,
            status,
            dbCompletedAt: row.completed_at,
            dbErrorMessage: row.error_message,
            requestId: ctx.requestId,
          },
          "In-flight migration has populated completed_at/error_message — coercing to null",
        );
      }
      return { ...base, status, completedAt: null, errorMessage: null };
    case "completed":
      if (!row.completed_at) {
        log.warn({ migrationId: row.id, status, requestId: ctx.requestId }, "Completed migration missing completed_at — falling back to requestedAt");
        return { ...base, status: "completed", completedAt: row.requested_at, errorMessage: null };
      }
      if (row.error_message !== null) {
        log.warn({ migrationId: row.id, status, requestId: ctx.requestId }, "Completed migration has populated error_message — coercing to null");
      }
      return { ...base, status: "completed", completedAt: row.completed_at, errorMessage: null };
    case "failed": {
      if (!row.completed_at) {
        log.warn({ migrationId: row.id, status, requestId: ctx.requestId }, "Failed migration missing completed_at — falling back to requestedAt");
      }
      if (!row.error_message) {
        log.warn({ migrationId: row.id, status, requestId: ctx.requestId }, "Failed migration missing error_message — using stock string");
      }
      return {
        ...base,
        status: "failed",
        completedAt: row.completed_at ?? row.requested_at,
        errorMessage: row.error_message ?? "Migration failed (no error message recorded)",
      };
    }
    case "cancelled":
      if (!row.completed_at) {
        log.warn({ migrationId: row.id, status, requestId: ctx.requestId }, "Cancelled migration missing completed_at — falling back to requestedAt");
      }
      return {
        ...base,
        status: "cancelled",
        completedAt: row.completed_at ?? row.requested_at,
        errorMessage: row.error_message,
      };
  }
}

// Schedule the background migration executor. `triggerMigrationExecution` is
// synchronous (schedules via setTimeout internally) but a synchronous throw
// here would otherwise return 201 to the client with no execution and no
// log trail. Wrap the call so a schedule-time failure surfaces in logs.
function scheduleMigrationExecution(
  migrationId: string,
  requestId: string,
): void {
  try {
    triggerMigrationExecution(migrationId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), migrationId, requestId },
      "Failed to schedule background migration execution",
    );
  }
}

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
  const ipAddress = clientIP(c);
  const { region } = c.req.valid("json");

  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      if (!mod) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment." }, 404);
      }

      // Inline failure audit via `.pipe(tapErrorCause)` keeps the emission
      // close to the yield that can fail. Failure audits on
      // residency.workspaceAssign are not optional: the attempt itself is
      // compliance-relevant (a 409 reveals the current region; repeated
      // 400s fingerprint a probe for configured regions). `tapErrorCause`
      // covers both typed `ResidencyError` failures AND defects from
      // `Effect.promise` (rejected DB promises — pool exhaustion, network
      // drops). `tapError` alone would miss defects, dropping the audit
      // row on exactly the infrastructure-failure mode an attacker would
      // probe for.
      const result = yield* mod.assignWorkspaceRegion(orgId!, region as string).pipe(
        Effect.tapErrorCause((cause) => {
          const err = causeToError(cause);
          if (err === undefined) return Effect.void;
          return Effect.sync(() =>
            logAdminAction({
              actionType: ADMIN_ACTIONS.residency.workspaceAssign,
              targetType: "residency",
              targetId: orgId!,
              status: "failure",
              ipAddress,
              metadata: { region, permanent: true, error: errorMessage(err) },
            }),
          );
        }),
      );
      log.info({ orgId, region }, "Workspace region assigned via self-serve");
      // Permanent decision — `permanent: true` surfaces the irreversibility
      // on the audit row so triage flags it at read time rather than
      // requiring reviewers to remember that residency is immutable.
      logAdminAction({
        actionType: ADMIN_ACTIONS.residency.workspaceAssign,
        targetType: "residency",
        targetId: orgId!,
        ipAddress,
        metadata: { region, permanent: true },
      });
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

      const rows = yield* queryEffect<MigrationRow>(
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

      return c.json({ migration: rowToMigration(row, { requestId }) }, 200);
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

      logAdminAction({
        actionType: ADMIN_ACTIONS.residency.migrationRequest,
        targetType: "residency",
        targetId: migrationId,
        ipAddress: clientIP(c),
        metadata: {
          workspaceId: orgId,
          sourceRegion: assignment.region,
          targetRegion,
        },
      });

      // Trigger background execution (Phase 2)
      scheduleMigrationExecution(migrationId, requestId);

      // Also check for stale migrations while we're here
      failStaleMigrations().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "Stale migration check failed");
      });

      const migration: RegionMigration = {
        id: migrationId,
        workspaceId: orgId,
        sourceRegion: assignment.region,
        targetRegion,
        status: "pending",
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
      scheduleMigrationExecution(id, requestId);

      // Fetch updated migration to return
      const rows = yield* queryEffect<MigrationRow>(
        `SELECT id, workspace_id, source_region, target_region, status, requested_by, requested_at, completed_at, error_message
         FROM region_migrations WHERE id = $1 AND workspace_id = $2`,
        [id, orgId],
      );

      const row = rows[0];
      if (!row) {
        return c.json({ error: "retry_failed", message: "Migration record not found after reset.", requestId }, 404);
      }

      log.info({ requestId, migrationId: id }, "Migration retry triggered");

      logAdminAction({
        actionType: ADMIN_ACTIONS.residency.migrationRetry,
        targetType: "residency",
        targetId: id,
        ipAddress: clientIP(c),
        metadata: {
          workspaceId: orgId,
          sourceRegion: row.source_region,
          targetRegion: row.target_region,
        },
      });

      return c.json(rowToMigration(row, { requestId }), 200);
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
      logAdminAction({
        actionType: ADMIN_ACTIONS.residency.migrationCancel,
        targetType: "residency",
        targetId: id,
        ipAddress: clientIP(c),
        metadata: { workspaceId: orgId },
      });
      return c.json({ cancelled: true }, 200);
    }),
    { label: "cancel region migration" },
  );
});

export { adminResidency };
