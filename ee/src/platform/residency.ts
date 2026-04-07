/**
 * Enterprise data residency — region-based tenant routing.
 *
 * Assigns workspaces to geographic regions and resolves region-specific
 * database URLs for connection routing. Access-gated via platformAdminAuth
 * middleware (platform_admin role required).
 *
 * Region assignment is immutable after creation — changing a workspace's
 * region requires data migration (separate future work).
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 */

import { Data, Effect } from "effect";
import { getConfig } from "@atlas/api/lib/config";
import type { ResidencyConfig } from "@atlas/api/lib/config";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getWorkspaceRegion,
  setWorkspaceRegion,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { RegionStatus, WorkspaceRegion } from "@useatlas/types";

const log = createLogger("ee:residency");

// ── Typed errors ────────────────────────────────────────────────────

export type ResidencyErrorCode =
  | "not_configured"
  | "invalid_region"
  | "already_assigned"
  | "workspace_not_found"
  | "no_internal_db";

export class ResidencyError extends Data.TaggedError("ResidencyError")<{
  message: string;
  code: ResidencyErrorCode;
}> {}

// ── Helpers ─────────────────────────────────────────────────────────

function getResidencyConfig(): ResidencyConfig {
  const config = getConfig();
  if (!config?.residency) {
    throw new ResidencyError({ message: "Data residency is not configured. Add a 'residency' section to atlas.config.ts with region definitions.", code: "not_configured" });
  }
  return config.residency;
}

function getResidencyConfigEffect(): Effect.Effect<ResidencyConfig, ResidencyError> {
  const config = getConfig();
  if (!config?.residency) {
    return Effect.fail(new ResidencyError({ message: "Data residency is not configured. Add a 'residency' section to atlas.config.ts with region definitions.", code: "not_configured" }));
  }
  return Effect.succeed(config.residency);
}

function isValidRegion(region: string, residency: ResidencyConfig): boolean {
  return region in residency.regions;
}

/** Coerce a DB value (Date or string) to an ISO 8601 string. Throws on null/undefined/unexpected types. */
function toISOString(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new ResidencyError({ message: `rowToWorkspaceRegion: expected Date or ISO string for "${field}", got ${value === null ? "null" : typeof value}`, code: "not_configured" });
}

/** Map a DB row to a WorkspaceRegion wire type with defensive coercion. */
function rowToWorkspaceRegion(row: Record<string, unknown>): WorkspaceRegion {
  return {
    workspaceId: String(row.id ?? ""),
    region: String(row.region ?? ""),
    assignedAt: toISOString(row.region_assigned_at, "region_assigned_at"),
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List all configured regions with workspace counts and health status.
 */
export const listRegions = (): Effect.Effect<RegionStatus[], ResidencyError> =>
  Effect.gen(function* () {
    const residency = yield* getResidencyConfigEffect();

    const workspaceCounts: Record<string, number> = {};
    if (hasInternalDB()) {
      const rows = yield* Effect.promise(() => internalQuery<{ region: string; cnt: string }>(
        `SELECT region, COUNT(*) AS cnt FROM organization WHERE region IS NOT NULL GROUP BY region`,
        [],
      ));
      for (const row of rows) {
        workspaceCounts[row.region] = parseInt(row.cnt, 10);
      }
    }

    return Object.entries(residency.regions).map(([regionId, regionConfig]) => ({
      region: regionId,
      label: regionConfig.label,
      workspaceCount: workspaceCounts[regionId] ?? 0,
      healthy: true, // health check can be extended later
    }));
  });

/**
 * Get the default region for new workspaces.
 */
export function getDefaultRegion(): string {

  const residency = getResidencyConfig();
  return residency.defaultRegion;
}

/**
 * Get the configured regions map (region ID → config).
 */
export function getConfiguredRegions(): ResidencyConfig["regions"] {

  const residency = getResidencyConfig();
  return residency.regions;
}

/**
 * Assign a region to a workspace. Region is immutable once set.
 */
export const assignWorkspaceRegion = (
  workspaceId: string,
  region: string,
): Effect.Effect<WorkspaceRegion, ResidencyError | Error> =>
  Effect.gen(function* () {
    const residency = yield* getResidencyConfigEffect();

    yield* requireInternalDBEffect("data residency", () => new ResidencyError({ message: "Internal database is required for data residency.", code: "no_internal_db" }));

    if (!isValidRegion(region, residency)) {
      const available = Object.keys(residency.regions).join(", ");
      return yield* Effect.fail(new ResidencyError({ message: `Invalid region "${region}". Available regions: ${available}`, code: "invalid_region" }));
    }

    const result = yield* Effect.promise(() => setWorkspaceRegion(workspaceId, region));
    if (!result.assigned) {
      if (result.existing) {
        return yield* Effect.fail(new ResidencyError({ message: `Workspace is already assigned to region "${result.existing}". Region cannot be changed after assignment.`, code: "already_assigned" }));
      }
      return yield* Effect.fail(new ResidencyError({ message: `Workspace "${workspaceId}" not found.`, code: "workspace_not_found" }));
    }

    log.info({ workspaceId, region }, "Workspace assigned to region");
    return {
      workspaceId,
      region: region,
      assignedAt: new Date().toISOString(),
    };
  });

/**
 * Get the region assignment for a workspace.
 * Returns null if the workspace has no region assigned.
 */
export const getWorkspaceRegionAssignment = (
  workspaceId: string,
): Effect.Effect<WorkspaceRegion | null, ResidencyError | Error> =>
  Effect.gen(function* () {
    yield* requireInternalDBEffect("data residency", () => new ResidencyError({ message: "Internal database is required for data residency.", code: "no_internal_db" }));

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT region, region_assigned_at FROM organization WHERE id = $1`,
      [workspaceId],
    ));

    if (rows.length === 0 || !rows[0].region) return null;

    return {
      workspaceId,
      region: String(rows[0].region),
      assignedAt: toISOString(rows[0].region_assigned_at, "region_assigned_at"),
    };
  });

/**
 * Resolve region-specific database URLs for a workspace.
 * Returns null if no residency is configured or workspace has no region.
 * Currently used by connection routing to override the analytics datasource
 * for region-assigned workspaces. The returned `databaseUrl` is available
 * for future internal DB routing.
 *
 * Returns null when no region config exists or workspace has no assignment.
 */
export const resolveRegionDatabaseUrl = (
  workspaceId: string,
): Effect.Effect<{ databaseUrl: string; datasourceUrl?: string; region: string } | null> =>
  Effect.gen(function* () {
    const config = getConfig();
    if (!config?.residency) return null;

    const region = yield* Effect.promise(() => getWorkspaceRegion(workspaceId));
    if (!region) return null;

    const regionConfig = config.residency.regions[region];
    if (!regionConfig) {
      log.error(
        { workspaceId, region, configuredRegions: Object.keys(config.residency.regions) },
        "Workspace assigned to region that is no longer configured — data residency contract may be violated",
      );
      return null;
    }

    return {
      databaseUrl: regionConfig.databaseUrl,
      datasourceUrl: regionConfig.datasourceUrl,
      region,
    };
  });

/**
 * List all workspace region assignments (for admin views).
 */
export const listWorkspaceRegions = (): Effect.Effect<WorkspaceRegion[], ResidencyError | Error> =>
  Effect.gen(function* () {
    yield* requireInternalDBEffect("data residency", () => new ResidencyError({ message: "Internal database is required for data residency.", code: "no_internal_db" }));

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT id, region, region_assigned_at FROM organization WHERE region IS NOT NULL ORDER BY region_assigned_at DESC`,
      [],
    ));

    return rows.map(rowToWorkspaceRegion);
  });

/**
 * Validate that a region string is in the configured regions.
 * Does NOT require enterprise — used at workspace creation time for validation.
 */
export function isConfiguredRegion(region: string): boolean {
  const config = getConfig();
  if (!config?.residency) return false;
  return region in config.residency.regions;
}
