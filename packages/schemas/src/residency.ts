/**
 * Data residency wire-format schemas.
 *
 * Single source of truth for the workspace / platform residency surface —
 * `/api/v1/admin/residency` (migration status + request) and
 * `/api/v1/platform/residency` (region listing + assignment) — shared by
 * route-layer OpenAPI validation and web-layer response parsing.
 *
 * `RegionMigrationSchema` is `z.discriminatedUnion` over `status` to match
 * the `RegionMigration` type in `@useatlas/types` (#1696). The variants
 * encode the terminal-vs-in-flight timestamp invariants: pending/in_progress
 * rows must have `completedAt === null` and `errorMessage === null`,
 * failed rows require both fields set, completed rows have `completedAt`
 * but no error, and cancelled rows have `completedAt` with `errorMessage`
 * kept as `string | null` for legacy 'Cancelled by admin' rows.
 *
 * Strict `z.enum(TUPLE)` on the discriminator literals matches the
 * `@hono/zod-openapi` extractor's expectations — it cannot serialize
 * `ZodCatch` wrappers (#1653).
 *
 * Every variant uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a
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
import { IsoTimestampSchema } from "./common";

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
  assignedAt: IsoTimestampSchema,
}) satisfies z.ZodType<WorkspaceRegion>;

const RegionMigrationBaseShape = {
  id: z.string(),
  workspaceId: z.string(),
  sourceRegion: z.string(),
  targetRegion: z.string(),
  requestedBy: z.string().nullable(),
  requestedAt: IsoTimestampSchema,
};

const PendingMigrationSchema = z.object({
  ...RegionMigrationBaseShape,
  status: z.literal("pending"),
  completedAt: z.null(),
  errorMessage: z.null(),
});

const InProgressMigrationSchema = z.object({
  ...RegionMigrationBaseShape,
  status: z.literal("in_progress"),
  completedAt: z.null(),
  errorMessage: z.null(),
});

const CompletedMigrationSchema = z.object({
  ...RegionMigrationBaseShape,
  status: z.literal("completed"),
  completedAt: IsoTimestampSchema,
  errorMessage: z.null(),
});

const FailedMigrationSchema = z.object({
  ...RegionMigrationBaseShape,
  status: z.literal("failed"),
  completedAt: IsoTimestampSchema,
  errorMessage: z.string(),
});

const CancelledMigrationSchema = z.object({
  ...RegionMigrationBaseShape,
  status: z.literal("cancelled"),
  completedAt: IsoTimestampSchema,
  errorMessage: z.string().nullable(),
});

export const RegionMigrationSchema = z.discriminatedUnion("status", [
  PendingMigrationSchema,
  InProgressMigrationSchema,
  CompletedMigrationSchema,
  FailedMigrationSchema,
  CancelledMigrationSchema,
]) satisfies z.ZodType<RegionMigration>;

export { MigrationStatusEnum };

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
