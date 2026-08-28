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
import type { WithLooseOptionals } from "./exact-optional";
import {
  MIGRATION_STATUSES,
  type RegionMigration,
  type RegionPickerItem,
  type RegionRoutingMap,
  type RegionRoutingMapEntry,
  type RegionStatus,
  type VocabularyRefusalDetail,
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
  // Region's public API base — lets the signup picker repoint the browser at
  // the chosen region before the first identity write (ADR-0024 §4). Optional:
  // single-region / local-dev configs omit it. `.url()` rejects a malformed
  // base before it ever reaches `applyRegionSignal`'s own credential-safe check.
  apiUrl: z.string().url().optional(),
}) satisfies z.ZodType<WithLooseOptionals<RegionPickerItem>>;

export const RegionStatusSchema = z.object({
  region: z.string(),
  label: z.string(),
  workspaceCount: z.number().int().nonnegative(),
  healthy: z.boolean(),
}) satisfies z.ZodType<RegionStatus>;

export const RegionRoutingMapEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  apiUrl: z.string(),
  isDefault: z.boolean(),
}) satisfies z.ZodType<RegionRoutingMapEntry>;

/** Wire shape of `GET /api/v1/auth/region-map` (login front-door, ADR-0024 §3). */
export const RegionRoutingMapSchema = z.object({
  configured: z.boolean(),
  defaultRegion: z.string(),
  regions: z.array(RegionRoutingMapEntrySchema),
}) satisfies z.ZodType<RegionRoutingMap>;

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
// Vocabulary refusal payloads (#5112, #5303)
// ---------------------------------------------------------------------------

/**
 * One refused vocabulary edge, as the destination region reports it.
 *
 * ⚠️ THE ONE SPELLING OF THESE EIGHT FIELDS. Before #5303 there were three, and
 * nothing tied them together:
 *
 *   1. the TypeScript type — `VocabularyRefusalDetail` in `@useatlas/types`;
 *   2. a Zod object literal restated inline in `ImportResultSchema`
 *      (`api/routes/admin-migrate.ts`);
 *   3. a hand-written runtime screen — `screenRefusalDetails` in
 *      `lib/residency/migrate.ts`, eight fields checked by two predicate lists.
 *
 * (1) and (2) were held together by `_SchemaMatchesWireType`, whose reach #5112
 * MEASURED: a required item field or a dropped `.nullable()` on either side is
 * red, but an OPTIONAL item field on one side only is silent. (3) was held
 * together by nothing at all — it was coupled to the type by hand, and its own
 * docstring said so.
 *
 * ⚠️ THE `satisfies` ALONE IS NOT ENOUGH, and the first version of this docstring
 * said it was — in precisely the way this whole consolidation exists to prevent.
 * Measured with `tsgo`, not reasoned about:
 *
 *   - ninth field REQUIRED on the type, schema untouched  → RED (TS1360)
 *   - ninth field OPTIONAL on the type, schema untouched  → **GREEN**
 *   - ninth field on the SCHEMA only, either way          → **GREEN**
 *
 * `refusalKind?: string` is the normal, backward-compatible way to add a field
 * here — older regions will not send it — and under the `satisfies` alone it
 * compiles everywhere, after which the screen STRIPS it from every inbound
 * payload. Once the source region's grace period closes, that stripped field is
 * gone from the last surviving copy of a human review decision. A silent drop,
 * with three docstrings telling the next maintainer the compiler had it covered.
 *
 * So the key-set pin below carries the property the acceptance criterion actually
 * asks for. Re-measured with both pins in place — all four RED:
 *
 *   - ninth REQUIRED on the type    → 5 errors (satisfies, screen, route, key pin)
 *   - ninth OPTIONAL on the type    → 1 error  — THE KEY PIN ALONE
 *   - ninth REQUIRED on the schema  → 3 errors
 *   - ninth OPTIONAL on the schema  → 1 error  — THE KEY PIN ALONE
 *
 * The `satisfies` stays, and is not redundant: key equality cannot see a field's
 * TYPE changing or a dropped `.nullable()`, which is exactly what it does see.
 * Two pins, two reaches, neither one sufficient.
 *
 * ⚠️ THIS PACKAGE IS THE ONLY LEGAL SHARED HOME for it. `lib/**` must not import
 * from `api/routes/**` (CLAUDE.md), so the screen cannot reach the route's
 * literal; and `@useatlas/types` cannot hold it either — a Zod schema is a
 * RUNTIME value, and `packages/api/src` is copied into the `create-atlas`
 * scaffold template, which installs the PUBLISHED `@useatlas/types` and so cannot
 * see a symbol added in the same commit (`VOCABULARY_REFUSAL_DETAIL_CAP`'s
 * docstring carries the CI failure that proved it).
 *
 * `@useatlas/schemas` escapes that trap by never publishing at all: the scaffold
 * gets it from `prepare-templates.sh` step 5e, which copies this package's SOURCE
 * into every template behind a `tsconfig` path alias. Same commit, same schema.
 *
 * The array-level cap is deliberately NOT here. It is a property of a particular
 * transfer, applied by the two `.slice()` calls and documented on the route's
 * `.max()`; baking it into the item schema would put a bound on a single edge.
 */
export const VocabularyRefusalDetailSchema = z.object({
  /** The slot position the edge was approved at, verbatim from the source row. */
  slotPosition: z.string(),
  fromNorm: z.string(),
  toNorm: z.string(),
  /**
   * `null` is an auto-approved edge, not an unknown one — so `.nullable()` and
   * NOT `.optional()`. A missing key and a key whose value says "auto-approved"
   * read identically in a log aggregator, and only one of them is true. The
   * screen depends on this exact distinction: `null` passes, absent is malformed.
   */
  approvedBy: z.string().nullable(),
  /** The SOURCE region's approval timestamp, carried verbatim (never re-stamped). */
  approvedAt: z.string(),
  /** Which of the four rules refused it — `already-aliased`, `would-cycle`, … */
  refusal: z.string(),
  /** What the DESTINATION holds for `fromNorm` instead, or `null` for the arms
   * that have no conflicting edge. `.nullable()` for `approvedBy`'s reason. */
  existingTarget: z.string().nullable(),
  /** The refusal's human-readable reason, as the destination phrased it. */
  reason: z.string(),
}) satisfies z.ZodType<VocabularyRefusalDetail>;

/**
 * Compile-time pin: the schema and the wire type declare the SAME KEYS.
 *
 * This is the half `satisfies` cannot do (see the measurements above). `keyof`
 * enumerates optional members too, so `refusalKind?: string` added to either
 * spelling alone lands in one of the two `Exclude`s and fails this line.
 *
 * ⚠️ The two directions are SEPARATE nested conditions, not a union. While the
 * spellings agree both `Exclude`s are `never`, and a union of nevers trips
 * `no-duplicate-type-constituents` + `no-redundant-type-constituents` in
 * `lint:type-aware` — a CI-blocking gate. Nesting keeps the pin lint-clean and
 * keeps each direction separately falsifiable. Same idiom, and same reason, as
 * `_SchemaMatchesWireType` in `admin-migrate.ts`.
 */
type _RefusalDetailKeysMatch = [
  Exclude<keyof z.infer<typeof VocabularyRefusalDetailSchema>, keyof VocabularyRefusalDetail>,
] extends [never]
  ? [
      Exclude<keyof VocabularyRefusalDetail, keyof z.infer<typeof VocabularyRefusalDetailSchema>>,
    ] extends [never]
    ? true
    : never
  : never;
const _refusalDetailKeysMatch: _RefusalDetailKeysMatch = true;
void _refusalDetailKeysMatch;

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
