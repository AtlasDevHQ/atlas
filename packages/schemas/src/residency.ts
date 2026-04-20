/**
 * Data residency wire-format schemas.
 *
 * Single source of truth for the workspace / platform residency surface —
 * `/api/v1/admin/residency` (migration status + request) and
 * `/api/v1/platform/residency` (region listing + assignment) — shared by
 * route-layer OpenAPI validation and web-layer response parsing.
 *
 * Before this migration, the admin-residency route pinned `status` to
 * `z.enum(MIGRATION_STATUSES)` while the web copy pinned the same field to
 * a hand-typed `z.enum(["pending", "in_progress", "completed", "failed",
 * "cancelled"])` literal tuple. Two drift traps — adding a new migration
 * status in `@useatlas/types` would silently pass the route but fail the
 * web parse. Pinning both sides to the same canonical tuple closes that
 * gap. Strict `z.enum(TUPLE)` also matches the `@hono/zod-openapi`
 * extractor's expectations — it cannot serialize `ZodCatch` wrappers
 * (#1653).
 *
 * Every schema uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a
 * field rename in `@useatlas/types` — or in the local composite-response
 * interfaces below — breaks this file at compile time instead of passing
 * through to runtime.
 */
import { z } from "zod";
import {
  MIGRATION_STATUSES,
  type RegionMigration,
  type RegionPickerItem,
  type RegionStatus,
  type WorkspaceRegion,
} from "@useatlas/types";

const MigrationStatusEnum = z.enum(MIGRATION_STATUSES);

// ---------------------------------------------------------------------------
// Primary entity schemas
// ---------------------------------------------------------------------------

export const RegionPickerItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
}) satisfies z.ZodType<RegionPickerItem>;

export const RegionStatusSchema = z.object({
  region: z.string(),
  label: z.string(),
  workspaceCount: z.number().int().nonnegative(),
  healthy: z.boolean(),
}) satisfies z.ZodType<RegionStatus>;

export const WorkspaceRegionSchema = z.object({
  workspaceId: z.string(),
  region: z.string(),
  assignedAt: z.string(),
}) satisfies z.ZodType<WorkspaceRegion>;

export const RegionMigrationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceRegion: z.string(),
  targetRegion: z.string(),
  status: MigrationStatusEnum,
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
}) satisfies z.ZodType<RegionMigration>;

// ---------------------------------------------------------------------------
// Composite response shapes
//
// Local interfaces (not published via `@useatlas/types`) because these
// wrappers only exist at the wire boundary — nothing outside the HTTP
// surface consumes them. `satisfies z.ZodType<T>` still catches a shape
// drift: renaming `regions` → `regionStatuses` below would fail compile.
// ---------------------------------------------------------------------------

interface RegionsResponse {
  regions: RegionStatus[];
  defaultRegion: string;
}

interface AssignmentsResponse {
  assignments: WorkspaceRegion[];
}

interface MigrationStatusResponse {
  migration: RegionMigration | null;
}

export const RegionsResponseSchema = z.object({
  regions: z.array(RegionStatusSchema),
  defaultRegion: z.string(),
}) satisfies z.ZodType<RegionsResponse>;

export const AssignmentsResponseSchema = z.object({
  assignments: z.array(WorkspaceRegionSchema),
}) satisfies z.ZodType<AssignmentsResponse>;

export const MigrationStatusResponseSchema = z.object({
  migration: RegionMigrationSchema.nullable(),
}) satisfies z.ZodType<MigrationStatusResponse>;
