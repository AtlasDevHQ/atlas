/**
 * Enterprise data residency — region-based tenant routing.
 *
 * Assigns workspaces to geographic regions and resolves region-specific
 * database URLs for connection routing. Every public function calls
 * `requireEnterprise("data-residency")` — unlicensed deployments get
 * a clear error.
 *
 * Region assignment is immutable after creation — changing a workspace's
 * region requires data migration (separate future work).
 */

import { requireEnterprise } from "../index";
import { getConfig } from "@atlas/api/lib/config";
import type { ResidencyConfig } from "@atlas/api/lib/config";
import {
  hasInternalDB,
  internalQuery,
  getWorkspaceRegion,
  setWorkspaceRegion,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { Region, RegionStatus, WorkspaceRegion } from "@useatlas/types";

const log = createLogger("ee:residency");

// ── Typed errors ────────────────────────────────────────────────────

export type ResidencyErrorCode =
  | "not_configured"
  | "invalid_region"
  | "already_assigned"
  | "workspace_not_found"
  | "no_internal_db";

export class ResidencyError extends Error {
  constructor(message: string, public readonly code: ResidencyErrorCode) {
    super(message);
    this.name = "ResidencyError";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function getResidencyConfig(): ResidencyConfig {
  const config = getConfig();
  if (!config?.residency) {
    throw new ResidencyError(
      "Data residency is not configured. Add a 'residency' section to atlas.config.ts with region definitions.",
      "not_configured",
    );
  }
  return config.residency;
}

function isValidRegion(region: string, residency: ResidencyConfig): boolean {
  return region in residency.regions;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List all configured regions with workspace counts and health status.
 */
export async function listRegions(): Promise<RegionStatus[]> {
  requireEnterprise("data-residency");
  const residency = getResidencyConfig();

  const workspaceCounts: Record<string, number> = {};
  if (hasInternalDB()) {
    const rows = await internalQuery<{ region: string; cnt: string }>(
      `SELECT region, COUNT(*) AS cnt FROM organization WHERE region IS NOT NULL GROUP BY region`,
      [],
    );
    for (const row of rows) {
      workspaceCounts[row.region] = parseInt(row.cnt, 10);
    }
  }

  return Object.entries(residency.regions).map(([regionId, regionConfig]) => ({
    region: regionId as Region,
    label: regionConfig.label,
    workspaceCount: workspaceCounts[regionId] ?? 0,
    healthy: true, // health check can be extended later
  }));
}

/**
 * Get the default region for new workspaces.
 */
export function getDefaultRegion(): string {
  requireEnterprise("data-residency");
  const residency = getResidencyConfig();
  return residency.defaultRegion;
}

/**
 * Get the configured regions map (region ID → config).
 */
export function getConfiguredRegions(): ResidencyConfig["regions"] {
  requireEnterprise("data-residency");
  const residency = getResidencyConfig();
  return residency.regions;
}

/**
 * Assign a region to a workspace. Region is immutable once set.
 *
 * @throws {ResidencyError} If region is invalid, already assigned, or workspace not found.
 */
export async function assignWorkspaceRegion(
  workspaceId: string,
  region: string,
): Promise<WorkspaceRegion> {
  requireEnterprise("data-residency");
  const residency = getResidencyConfig();

  if (!hasInternalDB()) {
    throw new ResidencyError(
      "Internal database is required for data residency.",
      "no_internal_db",
    );
  }

  if (!isValidRegion(region, residency)) {
    const available = Object.keys(residency.regions).join(", ");
    throw new ResidencyError(
      `Invalid region "${region}". Available regions: ${available}`,
      "invalid_region",
    );
  }

  const result = await setWorkspaceRegion(workspaceId, region);
  if (!result.assigned) {
    if (result.existing) {
      throw new ResidencyError(
        `Workspace is already assigned to region "${result.existing}". Region cannot be changed after assignment.`,
        "already_assigned",
      );
    }
    throw new ResidencyError(
      `Workspace "${workspaceId}" not found.`,
      "workspace_not_found",
    );
  }

  log.info({ workspaceId, region }, "Workspace assigned to region");
  return {
    workspaceId,
    region: region as Region,
    assignedAt: new Date().toISOString(),
  };
}

/**
 * Get the region assignment for a workspace.
 * Returns null if the workspace has no region assigned.
 */
export async function getWorkspaceRegionAssignment(
  workspaceId: string,
): Promise<WorkspaceRegion | null> {
  requireEnterprise("data-residency");

  if (!hasInternalDB()) {
    throw new ResidencyError(
      "Internal database is required for data residency.",
      "no_internal_db",
    );
  }

  const rows = await internalQuery<{ region: string | null; region_assigned_at: string | null }>(
    `SELECT region, region_assigned_at FROM organization WHERE id = $1`,
    [workspaceId],
  );

  if (rows.length === 0 || !rows[0].region) return null;

  return {
    workspaceId,
    region: rows[0].region as Region,
    assignedAt: rows[0].region_assigned_at ?? new Date().toISOString(),
  };
}

/**
 * Resolve the internal database URL for a workspace's region.
 * Returns null if no residency is configured or workspace has no region.
 * Used by connection routing to direct writes to the correct region.
 */
export async function resolveRegionDatabaseUrl(
  workspaceId: string,
): Promise<{ databaseUrl: string; datasourceUrl?: string; region: string } | null> {
  const config = getConfig();
  if (!config?.residency) return null;

  const region = await getWorkspaceRegion(workspaceId);
  if (!region) return null;

  const regionConfig = config.residency.regions[region];
  if (!regionConfig) {
    log.warn({ workspaceId, region }, "Workspace assigned to unknown region — falling back to default");
    return null;
  }

  return {
    databaseUrl: regionConfig.databaseUrl,
    datasourceUrl: regionConfig.datasourceUrl,
    region,
  };
}

/**
 * List all workspace region assignments (for admin views).
 */
export async function listWorkspaceRegions(): Promise<WorkspaceRegion[]> {
  requireEnterprise("data-residency");

  if (!hasInternalDB()) return [];

  const rows = await internalQuery<{ id: string; region: string; region_assigned_at: string }>(
    `SELECT id, region, region_assigned_at FROM organization WHERE region IS NOT NULL ORDER BY region_assigned_at DESC`,
    [],
  );

  return rows.map((row) => ({
    workspaceId: row.id,
    region: row.region as Region,
    assignedAt: row.region_assigned_at,
  }));
}

/**
 * Validate that a region string is in the configured regions.
 * Does NOT require enterprise — used at workspace creation time for validation.
 */
export function isConfiguredRegion(region: string): boolean {
  const config = getConfig();
  if (!config?.residency) return false;
  return region in config.residency.regions;
}
