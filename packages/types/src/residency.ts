/**
 * Data residency types for tenant-to-region routing.
 *
 * Used by the platform admin console and enterprise residency module
 * to assign workspaces to geographic regions and route connections
 * to region-specific databases.
 */

// ---------------------------------------------------------------------------
// Region identifiers
// ---------------------------------------------------------------------------

export const REGIONS = [
  "us-east",
  "us-west",
  "eu-west",
  "eu-central",
  "ap-southeast",
  "ap-northeast",
] as const;

export type Region = (typeof REGIONS)[number];

// ---------------------------------------------------------------------------
// Region configuration (per region)
// ---------------------------------------------------------------------------

export interface RegionConfig {
  /** Display label shown in the admin console. */
  label: string;
  /** Database URL for the region's internal database. */
  databaseUrl: string;
  /** Optional datasource URL override for the region's analytics datasource. */
  datasourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Workspace region assignment
// ---------------------------------------------------------------------------

export interface WorkspaceRegion {
  workspaceId: string;
  region: Region;
  assignedAt: string;
}

// ---------------------------------------------------------------------------
// Region status (admin view)
// ---------------------------------------------------------------------------

export interface RegionStatus {
  region: Region;
  label: string;
  workspaceCount: number;
  healthy: boolean;
}
