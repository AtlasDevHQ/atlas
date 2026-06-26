/**
 * Enterprise data residency — region-based tenant routing.
 *
 * Assigns workspaces to geographic regions and resolves region-specific
 * database URLs for connection routing. Access-gated via platformAdminAuth
 * middleware (platform_admin role required).
 *
 * Region assignment is one-way via the self-serve/assign path: once a
 * workspace has a region, re-assignment is rejected. Changing a region is a
 * deliberate, operator-driven cross-region migration (`POST /admin/residency/
 * migrate`, rate-limited to one per 30 days) that relocates the workspace's
 * data — not a casual re-pick.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 */

import { Effect, Layer } from "effect";
import { getConfig } from "@atlas/api/lib/config";
import type { ResidencyConfig } from "@atlas/api/lib/config";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  setWorkspaceRegion,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import {
  ResidencyResolver,
  type ResidencyResolverShape,
} from "@atlas/api/lib/effect/services";
import {
  ResidencyError,
  type ResidencyErrorCode,
} from "@atlas/api/lib/residency/errors";
import { isRegionSelectable } from "@atlas/api/lib/residency/picker";
import type { RegionStatus, WorkspaceRegion } from "@useatlas/types";

const log = createLogger("ee:residency");

// ── Typed errors ────────────────────────────────────────────────────

/**
 * `ResidencyError` now lives in core (`@atlas/api/lib/residency/errors`)
 * so the `ResidencyResolver` Tag in `lib/effect/services.ts` can type its
 * failure channel without core importing from `@atlas/ee`. Re-exported
 * here for back-compat — pre-#2564 EE consumers that imported
 * `ResidencyError` / `ResidencyErrorCode` from this path keep working
 * unchanged (same `_tag`, same payload shape, same `instanceof` semantics).
 */
export { ResidencyError, type ResidencyErrorCode };

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

/** Region ids a customer may be assigned — excludes `selectable: false` arms. */
function selectableRegionIds(residency: ResidencyConfig): string[] {
  return Object.entries(residency.regions)
    .filter(([, cfg]) => isRegionSelectable(cfg))
    .map(([id]) => id);
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
 * Assign a region to a workspace. One-way: rejects with `already_assigned`
 * once a region is set — changing it goes through the admin cross-region
 * migration flow (`POST /admin/residency/migrate`), not this path.
 */
export const assignWorkspaceRegion = (
  workspaceId: string,
  region: string,
): Effect.Effect<WorkspaceRegion, ResidencyError | Error> =>
  Effect.gen(function* () {
    const residency = yield* getResidencyConfigEffect();

    yield* requireInternalDBEffect("data residency", () => new ResidencyError({ message: "Internal database is required for data residency.", code: "no_internal_db" }));

    // Gate on selectability, not mere existence (#3948): a `selectable: false`
    // arm (e.g. the shared-config `staging` region the api-staging soak service
    // claims) is load-bearing for the boot guard + routing but must never be an
    // assignable residency choice — otherwise a real prod workspace could
    // `POST /assign-region {"region":"staging"}` and route its metadata to the
    // staging Postgres, the exact leak #3948 closes. The signup/admin pickers
    // already filter these out via the same `isRegionSelectable` predicate; this
    // is the authoritative write-path guard so a direct request can't bypass the
    // UI. The error lists only selectable regions so it can't leak internal ids.
    if (!isRegionSelectable(residency.regions[region])) {
      const available = selectableRegionIds(residency).join(", ");
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

// ── Tag wiring (#2564 — slice 2/11 of #2017) ─────────────────────────
//
// Bridges the module's functions into the `ResidencyResolver` Tag so
// core call sites (`lib/db/connection.ts`, `api/routes/platform-residency.ts`,
// `api/routes/shared-residency.ts`, …) can `yield* ResidencyResolver`
// instead of dynamic-importing this module. Aggregated into
// `ee/src/layers.ts:EELayer`; the no-op default in
// `lib/effect/services.ts:NoopResidencyResolverLayer` covers self-hosted
// installs where this module never loads.

/**
 * Build the `ResidencyResolver` service from this module's exports.
 * Reports `available: true` so route handlers know to surface the real
 * residency surface rather than the "feature disabled" branch. Each
 * method delegates to the corresponding function above; semantics are
 * identical to the pre-#2564 dynamic-import path.
 */
export const makeResidencyResolverLive = (): ResidencyResolverShape => ({
  available: true,
  listRegions,
  getDefaultRegion,
  getConfiguredRegions,
  assignWorkspaceRegion,
  getWorkspaceRegionAssignment,
  listWorkspaceRegions,
  isConfiguredRegion,
});

/** Layer that registers the real residency resolver under the core Tag. */
export const ResidencyResolverLive: Layer.Layer<ResidencyResolver> = Layer.sync(
  ResidencyResolver,
  makeResidencyResolverLive,
);
