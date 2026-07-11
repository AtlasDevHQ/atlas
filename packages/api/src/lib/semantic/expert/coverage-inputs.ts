/**
 * Coverage-overview loader (#4521) — the IMPURE gather behind the pure
 * `computeCoverage` seam (`coverage.ts`).
 *
 * Assembles the column-anchored coverage view's data from data the workspace
 * already tracks:
 *
 *   - Connections — the workspace's *profilable* SQL datasource installs (REST
 *     datasources excluded; they have no physical schema and no baseline profile,
 *     #4509). Ground truth from `workspace_plugins`, mirroring the enumeration in
 *     `me-connection-groups.ts`.
 *   - Physical schema — each connection's stored baseline `TableProfile[]`
 *     (`connection_profile_state`, #4509). A connection WITHOUT a baseline
 *     triggers the lazy backfill (`ensureConnectionBaseline`) in the background
 *     and reports `status: "profiling"`, so the view shows a loading state and
 *     the client re-fetches until the baseline lands (or a `baseline_error` does).
 *   - Semantic store — the org's published entities, scoped per connection to its
 *     Connection group, matched by `computeCoverage`.
 *
 * Every dependency is injectable so the assembly is unit-testable without a live
 * DB or a real connection — mirroring `briefing-inputs.ts` + `connection-baseline.ts`.
 */

import type { TableProfile } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type { ParsedEntity } from "./types";
import { entityGroupOf } from "./anchor";
import { computeCoverage, type CoverageMatrix } from "./coverage";
import type { BaselineProfileTarget } from "@atlas/api/lib/datasources/connection-baseline";
import type { ConnectionProfileState } from "@atlas/api/lib/semantic/connection-profile";

const log = createLogger("semantic-expert-coverage");

/** A profilable SQL datasource connection — the enumeration the view iterates. */
export interface ProfilableConnection {
  readonly installId: string;
  /** The connection's group id (`COALESCE(config->>'group_id', install_id)`). */
  readonly groupId: string;
  readonly dbType: string | null;
}

/**
 * A connection's coverage status:
 *   - `ready`     — a baseline profile exists; `coverage` is populated.
 *   - `profiling` — no baseline yet; the lazy backfill was kicked off (loading).
 *   - `error`     — the last baseline attempt failed; `error` carries the reason.
 */
export type ConnectionCoverageStatus = "ready" | "profiling" | "error";

/** One connection's physical-schema coverage against the semantic store. */
export interface ConnectionCoverage {
  readonly installId: string;
  readonly group: string;
  readonly dbType: string | null;
  readonly status: ConnectionCoverageStatus;
  /** DSN-scrubbed baseline error when `status === "error"`, else `null`. */
  readonly error: string | null;
  /** Freshness label ("profiled 3 days ago") when a baseline exists, else `null`. */
  readonly freshness: string | null;
  /** The coverage matrix when `status === "ready"`, else `null`. */
  readonly coverage: CoverageMatrix | null;
}

/** The whole workspace's coverage overview. */
export interface CoverageOverview {
  readonly connections: readonly ConnectionCoverage[];
  /** True while any connection is still profiling — drives the client's poll. */
  readonly profiling: boolean;
}

/** Injectable seams — defaults hit the real DB / connection resolvers. */
export interface CoverageOverviewDeps {
  /** Whether the internal DB (baseline store) is reachable; default reads the real gate. */
  hasInternalDB?: () => boolean;
  listConnections?: (orgId: string) => Promise<ProfilableConnection[]>;
  loadEntities?: (orgId: string) => Promise<ParsedEntity[]>;
  getState?: (orgId: string, installId: string) => Promise<ConnectionProfileState | null>;
  getBaseline?: (orgId: string, installId: string) => Promise<TableProfile[] | null>;
  /** Kick off a lazy baseline backfill (fire-and-forget). */
  ensureBaseline?: (target: BaselineProfileTarget) => Promise<unknown>;
}

/**
 * Enumerate the workspace's profilable SQL datasource connections — the same
 * `workspace_plugins` ground truth `me-connection-groups.ts` reads, minus REST
 * datasources (no physical schema to profile). `group_id` collapses to the
 * install id for a group-of-one (matching `resolveGroupIdForConnection`).
 */
async function defaultListProfilableConnections(orgId: string): Promise<ProfilableConnection[]> {
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  const { REST_DATASOURCE_CATALOG_IDS } = await import("@atlas/api/lib/openapi/data-candidates");
  const restCatalogIds = [...REST_DATASOURCE_CATALOG_IDS];
  const rows = await internalQuery<{ install_id: string; group_id: string; db_type: string | null }>(
    `SELECT install_id,
            COALESCE(config->>'group_id', install_id) AS group_id,
            config->>'db_type'                        AS db_type
       FROM workspace_plugins
      WHERE workspace_id = $1
        AND pillar = 'datasource'
        AND catalog_id <> ALL($2)
        AND status != 'archived'
      ORDER BY COALESCE(config->>'group_id', install_id) ASC, install_id ASC`,
    [orgId, restCatalogIds],
  );
  return rows.map((r) => ({ installId: r.install_id, groupId: r.group_id, dbType: r.db_type }));
}

async function defaultLoadEntities(orgId: string): Promise<ParsedEntity[]> {
  const { loadEntitiesForOrg } = await import("./context-loader");
  const { entities } = await loadEntitiesForOrg(orgId, "published");
  return entities;
}

async function defaultGetState(orgId: string, installId: string): Promise<ConnectionProfileState | null> {
  const { getConnectionProfileState } = await import("@atlas/api/lib/semantic/connection-profile");
  return getConnectionProfileState(orgId, installId);
}

async function defaultGetBaseline(orgId: string, installId: string): Promise<TableProfile[] | null> {
  const { getBaselineProfiles } = await import("@atlas/api/lib/semantic/connection-profile");
  return getBaselineProfiles(orgId, installId);
}

async function defaultEnsureBaseline(target: BaselineProfileTarget): Promise<unknown> {
  const { ensureConnectionBaseline } = await import("@atlas/api/lib/datasources/connection-baseline");
  return ensureConnectionBaseline(target);
}

/**
 * Resolve one connection's coverage. A connection with a stored baseline computes
 * its coverage matrix against the group-scoped entities; one without a baseline
 * kicks off the lazy backfill in the BACKGROUND (never awaited — the render must
 * not block on a live profile) and reports `profiling`. A recorded failure
 * surfaces honestly as `error` rather than re-storming the backfill on every poll.
 */
async function resolveConnectionCoverage(
  orgId: string,
  connection: ProfilableConnection,
  entities: readonly ParsedEntity[],
  now: Date,
  deps: Required<Pick<CoverageOverviewDeps, "getState" | "getBaseline" | "ensureBaseline">>,
): Promise<ConnectionCoverage> {
  const { describeProfileFreshness } = await import("@atlas/api/lib/semantic/connection-profile");
  const base = {
    installId: connection.installId,
    group: connection.groupId,
    dbType: connection.dbType,
  };

  const state = await deps.getState(orgId, connection.installId);

  if (state?.baseline) {
    const profiles = await deps.getBaseline(orgId, connection.installId);
    if (profiles) {
      // Scope entities to this connection's group (same rule the anchor uses).
      const scoped = entities.filter((e) => entityGroupOf(e) === connection.groupId);
      const coverage = computeCoverage(profiles, scoped);
      return {
        ...base,
        status: "ready",
        error: null,
        freshness: describeProfileFreshness(state.baseline.profiledAt, now)?.label ?? null,
        coverage,
      };
    }
    // A baseline is recorded but its payload is unreadable (corrupt/non-array) —
    // a genuine data-integrity anomaly. Log it (the state row and the payload
    // column disagree; a re-profile won't self-heal because a truthy
    // `state.baseline` memoizes `ensureConnectionBaseline` — recovery needs an
    // operator), and report honestly rather than pretending 100% coverage.
    log.warn(
      { installId: connection.installId, group: connection.groupId },
      "Coverage view: baseline is recorded but its stored payload is unreadable",
    );
    return { ...base, status: "error", error: "The stored baseline profile is unreadable.", freshness: null, coverage: null };
  }

  if (state?.baselineError) {
    return { ...base, status: "error", error: state.baselineError, freshness: null, coverage: null };
  }

  // No baseline and no recorded failure ⇒ never profiled. A profilable connection
  // needs its `dbType` to resolve the live connection — a null one is
  // unprofilable-by-construction (a malformed `config->>'db_type'`), NOT a loading
  // state: reporting `profiling` there would spin the client's poll forever with
  // no root-cause signal. Surface it as an honest, actionable error + log instead.
  if (!connection.dbType) {
    log.warn(
      { installId: connection.installId, group: connection.groupId },
      "Coverage view: connection has no db_type — cannot resolve a live connection to profile",
    );
    return {
      ...base,
      status: "error",
      error: "This connection is missing a database type, so its schema can't be profiled. Reconnect it to set the type.",
      freshness: null,
      coverage: null,
    };
  }

  // Trigger the lazy backfill in the background and report a loading state; the
  // client re-fetches until the baseline (or a baseline_error) lands.
  void deps
    .ensureBaseline({
      orgId,
      installId: connection.installId,
      connectionGroupId: connection.groupId,
      dbType: connection.dbType,
    })
    .catch((err) =>
      log.warn(
        { err: err instanceof Error ? err.message : String(err), installId: connection.installId },
        "Coverage view: lazy baseline backfill failed to start",
      ),
    );
  return { ...base, status: "profiling", error: null, freshness: null, coverage: null };
}

/**
 * Assemble the workspace's coverage overview. Returns an empty overview when
 * there's no org context or no internal DB (bare CLI / self-hosted stdio — the
 * baseline store lives in the internal DB). `now` is injected so freshness is
 * deterministic under test.
 */
export async function loadCoverageOverview(
  orgId: string | null,
  now: Date = new Date(),
  deps: CoverageOverviewDeps = {},
): Promise<CoverageOverview> {
  const hasInternalDB = deps.hasInternalDB ?? (await import("@atlas/api/lib/db/internal")).hasInternalDB;
  if (!orgId || !hasInternalDB()) return { connections: [], profiling: false };

  const listConnections = deps.listConnections ?? defaultListProfilableConnections;
  const loadEntities = deps.loadEntities ?? defaultLoadEntities;
  const resolved = {
    getState: deps.getState ?? defaultGetState,
    getBaseline: deps.getBaseline ?? defaultGetBaseline,
    ensureBaseline: deps.ensureBaseline ?? defaultEnsureBaseline,
  };

  // Connections + entities are independent reads — no waterfall.
  const [connections, entities] = await Promise.all([listConnections(orgId), loadEntities(orgId)]);

  const coverage = await Promise.all(
    connections.map((connection) => resolveConnectionCoverage(orgId, connection, entities, now, resolved)),
  );

  return { connections: coverage, profiling: coverage.some((c) => c.status === "profiling") };
}
