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

import { Effect, Layer } from "effect";
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
import { resolveDeployEnv } from "@atlas/api/lib/env-profile";
import {
  ResidencyResolver,
  type ResidencyResolverShape,
} from "@atlas/api/lib/effect/services";
import {
  ResidencyError,
  type ResidencyErrorCode,
} from "@atlas/api/lib/residency/errors";
import { isDeployRegion, type DeployRegion, type RegionStatus, type WorkspaceRegion } from "@useatlas/types";

const log = createLogger("ee:residency");

/**
 * The pre-prod soak deploy region (#2897 / #2908). Staging is a
 * `DeployRegion` keyed `"staging"` (under `*.staging.useatlas.dev`) but is
 * deliberately *excluded* from the residency router: a workspace keyed here
 * resolves to a `null` region route and falls through to the local DB
 * connection rather than any residency-mapped pool — see
 * `resolveRegionDatabaseUrl`. `satisfies DeployRegion` anchors the literal to
 * the union so dropping `"staging"` from `@useatlas/types` fails compilation
 * here rather than silently re-enabling routing.
 */
const STAGING_REGION = "staging" satisfies DeployRegion;

/**
 * Per-deploy-region routing intent (#2983). Maps every closed first-party
 * {@link DeployRegion} to whether `resolveRegionDatabaseUrl` routes it through
 * the residency pool (`"residency"`) or short-circuits to a `null` route that
 * falls through to the local DB connection (`"local"`).
 *
 * The point is to force a *conscious* decision per region. Because the type is
 * keyed `Record<DeployRegion, …>`, adding a member to the `DeployRegion` union
 * fails to type-check this table until its routing intent is recorded here — a
 * new region can never silently inherit a default route through the structural
 * `config.residency.regions[region]` lookup. This COMPLEMENTS, and does not
 * duplicate, `_AssertDeployRegionsExhaustive` in `@useatlas/types`: that guard
 * keeps the runtime `DEPLOY_REGIONS` tuple in sync with the union (tuple
 * membership); this keeps the *routing intent* in sync with it.
 *
 * Today only `staging` routes `"local"` (the pre-prod soak instance — see
 * {@link STAGING_REGION}); `us` / `eu` / `apac` are real residency targets.
 * Mind the OPEN/CLOSED distinction (see `@useatlas/types` `deploy.ts`): only the
 * closed `DeployRegion` union keys this table. A workspace's stored region is an
 * OPEN `Region` string (operator-defined, e.g. `us-east`) and is NOT keyed here,
 * so callers must narrow through `isDeployRegion` before consulting it — open
 * regions route through the residency map directly.
 */
export const DEPLOY_REGION_ROUTING = {
  us: "residency",
  eu: "residency",
  apac: "residency",
  staging: "local",
} as const satisfies Record<DeployRegion, "residency" | "local">;

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
): Effect.Effect<{ databaseUrl?: string; datasourceUrl?: string; region: string } | null> =>
  Effect.gen(function* () {
    const config = getConfig();
    if (!config?.residency) return null;

    const region = yield* Effect.promise(() => getWorkspaceRegion(workspaceId));
    if (!region) return null;

    // Staging arm (#2983 / #2908): the per-deploy-region routing table
    // (DEPLOY_REGION_ROUTING) marks staging `"local"`, so it is never a
    // residency target. `region` is an OPEN `Region` string, so the guard below
    // narrows it through `isDeployRegion` before consulting the (closed-union-
    // keyed) table — open operator-defined regions are not keyed there and fall
    // through to the residency map; closed deploy regions marked `"residency"`
    // (us|eu|apac) likewise fall through, so only `"local"` regions short-
    // circuit here. Return null *before* the regionConfig lookup so a staging-
    // keyed workspace falls through to the local DB connection — without tripping
    // the "region no longer configured / contract may be violated" error path
    // below. Short-circuiting here also wins over any `staging` entry in
    // residency.regions, so staging can never claim to be a residency-mapped
    // region. us|eu|apac are untouched.
    //
    // Observability is deploy-aware, and keyed PURELY on the deploy env (#3097).
    // On the staging deploy a staging-keyed workspace is routine — every
    // residency-configured request lands here — so it's debug-level noise. The
    // `staging` entry that `deploy/api-staging/atlas.config.ts` declares in
    // residency.regions is NOT dead config there: it is REQUIRED by
    // RegionGuardLive (`lib/effect/saas-guards.ts`) to boot the api-staging
    // service. So its presence must NOT promote this fall-through to a warn on
    // the staging deploy — that contradiction (boot demands the entry; this
    // resolver warned because of it) was the #3097 seam. On any OTHER deploy a
    // staging-keyed workspace is an impossible-by-policy state (a workspace
    // believed residency-pinned is being silently served the default pool — a
    // compliance signal that must be loud + alertable), and a `staging` entry
    // in a prod config IS genuinely dead config. Either case warns off-staging.
    // `stagingInResidencyConfig` is retained in the event payload for operator
    // context (it tells prod operators a dead entry sits in their map) but no
    // longer gates the log level.
    if (isDeployRegion(region) && DEPLOY_REGION_ROUTING[region] === "local") {
      const stagingInResidencyConfig = STAGING_REGION in config.residency.regions;
      const onStagingDeploy = resolveDeployEnv() === "staging";
      const event = {
        workspaceId,
        region,
        event: "residency.staging_excluded",
        stagingInResidencyConfig,
      };
      const message =
        "Workspace keyed to staging region — excluded from residency routing, falling through to local DB";
      if (onStagingDeploy) {
        log.debug(event, message);
      } else {
        log.warn(event, message);
      }
      return null;
    }

    const regionConfig = config.residency.regions[region];
    if (!regionConfig) {
      log.error(
        { workspaceId, region, configuredRegions: Object.keys(config.residency.regions) },
        "Workspace assigned to region that is no longer configured — data residency contract may be violated",
      );
      return null;
    }

    // `databaseUrl` is optional on `RegionConfig` (#3176): a non-claimed
    // region's internal-DB URL may be unset on an instance that doesn't serve
    // it. Do NOT bail to null on an empty/absent `databaseUrl` — the only
    // consumer (`getRegionAwareConnection`) routes the analytics datasource off
    // `datasourceUrl`/`region` and never reads `databaseUrl`, so returning null
    // here would silently DROP a region's datasource routing and fall the query
    // through to the default datasource (#3198 Codex P1). Pass the route through
    // unchanged; `databaseUrl` is omitted when unset so no empty connection
    // string reaches a pool. Routing semantics are identical to before the
    // schema relaxation — `datasourceUrl` was always the routing key.
    return {
      ...(regionConfig.databaseUrl ? { databaseUrl: regionConfig.databaseUrl } : {}),
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
  resolveRegionDatabaseUrl,
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
