/**
 * Data residency types for tenant-to-region routing.
 *
 * Used by the platform admin console and enterprise residency module
 * to assign workspaces to geographic regions and route connections
 * to region-specific databases.
 *
 * Region identifiers are operator-defined via `atlas.config.ts` — the
 * `WELL_KNOWN_REGIONS` array provides suggestions for the admin UI but
 * does not constrain which regions can be configured.
 */

// ---------------------------------------------------------------------------
// Region identifiers
// ---------------------------------------------------------------------------

/**
 * Well-known region identifiers used as suggestions in the admin UI.
 * Operators may configure arbitrary region keys in atlas.config.ts.
 */
export const WELL_KNOWN_REGIONS = [
  "us-east",
  "us-west",
  "eu-west",
  "eu-central",
  "ap-southeast",
  "ap-northeast",
] as const;

/**
 * Region identifier — an operator-defined string from the residency config.
 * Not constrained to WELL_KNOWN_REGIONS; any string key in the regions map is valid.
 */
export type Region = string;

// ---------------------------------------------------------------------------
// Region configuration (per region)
// ---------------------------------------------------------------------------

export interface RegionConfig {
  /** Display label shown in the admin console. */
  label: string;
  /** PostgreSQL URL for the region's internal database. Region-specific internal routing is planned for a future release. */
  databaseUrl: string;
  /** Optional analytics datasource URL override for this region. */
  datasourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Workspace region assignment
// ---------------------------------------------------------------------------

export interface WorkspaceRegion {
  workspaceId: string;
  region: Region;
  /** ISO 8601 timestamp of when the region was assigned. */
  assignedAt: string;
}

// ---------------------------------------------------------------------------
// Region picker item (user-facing selection UI)
// ---------------------------------------------------------------------------

/** A region projected for selection UI — safe for the frontend. */
export interface RegionPickerItem {
  /** Region identifier (e.g. "us-east", "eu-west"). */
  id: string;
  /** Human-readable display label (e.g. "US East", "EU West"). */
  label: string;
  /** Whether this region is the deployment's default. */
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Region migration
// ---------------------------------------------------------------------------

/** Valid migration status values — single source of truth for Zod schemas and type. */
export const MIGRATION_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;

/** Status of a region migration request. */
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/**
 * Fields common to every region migration. The `status`-keyed variants in
 * `RegionMigration` intersect with this base to encode terminal-vs-in-flight
 * timestamp and error-message invariants (#1696).
 */
interface RegionMigrationBase {
  id: string;
  workspaceId: string;
  sourceRegion: Region;
  targetRegion: Region;
  /** User ID of who requested the migration. */
  requestedBy: string | null;
  /** ISO 8601 timestamp of when the migration was requested. */
  requestedAt: string;
}

/**
 * A workspace region migration request.
 *
 * The discriminated union encodes two cross-field invariants the writer
 * enforces atomically but the structural shape alone cannot express:
 *
 * - `pending` / `in_progress` rows have `completedAt === null` and
 *   `errorMessage === null` — no terminal timestamp has been stamped.
 * - `completed` rows have `completedAt: string` and `errorMessage === null`
 *   — success path leaves errorMessage empty.
 * - `failed` rows have `completedAt: string` and a populated
 *   `errorMessage: string` — the failure reason is required.
 * - `cancelled` rows have `completedAt: string`; `errorMessage` is
 *   `string | null` because legacy cancellations stamped 'Cancelled by admin'
 *   while newer code is free to leave it null.
 */
export type RegionMigration = RegionMigrationBase & (
  | { status: "pending"; completedAt: null; errorMessage: null }
  | { status: "in_progress"; completedAt: null; errorMessage: null }
  | { status: "completed"; completedAt: string; errorMessage: null }
  | { status: "failed"; completedAt: string; errorMessage: string }
  | { status: "cancelled"; completedAt: string; errorMessage: string | null }
);

// ---------------------------------------------------------------------------
// Region status (admin view)
// ---------------------------------------------------------------------------

export interface RegionStatus {
  region: Region;
  label: string;
  workspaceCount: number;
  /** Always true in current implementation. Reserved for future health checks. */
  healthy: boolean;
}
