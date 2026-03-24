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
// Region status (admin view)
// ---------------------------------------------------------------------------

export interface RegionStatus {
  region: Region;
  label: string;
  workspaceCount: number;
  /** Always true in current implementation. Reserved for future health checks. */
  healthy: boolean;
}
