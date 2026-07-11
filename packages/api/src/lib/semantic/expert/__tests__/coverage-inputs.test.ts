/**
 * Unit tests for the coverage-overview loader (#4521) — the impure gather that
 * turns tracked baseline profiles + entities into the per-connection coverage
 * view, with the lazy backfill for an unprofiled connection.
 *
 * The DB / connection-resolver seams are injected, so these tests never touch a
 * live DB. They pin the load-bearing behaviors: a ready connection computes its
 * matrix scoped to its group (AC1), a never-profiled connection triggers the
 * lazy backfill and reports a loading state (AC4), a recorded failure surfaces
 * honestly (no re-storm), and entities are scoped per connection group.
 *
 * `hasInternalDB` is injected (not module-mocked) so the loader proceeds to the
 * injected seams without leaking a partial db/internal mock into sibling files.
 */

import { describe, it, expect, mock } from "bun:test";
import type { ColumnProfile, TableProfile } from "@useatlas/types";
import type { ParsedEntity } from "../types";
import type { ConnectionProfileState } from "@atlas/api/lib/semantic/connection-profile";
import type { BaselineProfileTarget } from "@atlas/api/lib/datasources/connection-baseline";
import { loadCoverageOverview, type CoverageOverviewDeps } from "../coverage-inputs";

/** Force the internal-DB gate on for every case; each test injects the rest. */
const WITH_DB: Pick<CoverageOverviewDeps, "hasInternalDB"> = { hasInternalDB: () => true };

function col(name: string, overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    name,
    type: "text",
    nullable: true,
    unique_count: null,
    null_count: null,
    sample_values: [],
    is_primary_key: false,
    is_foreign_key: false,
    fk_target_table: null,
    fk_target_column: null,
    is_enum_like: false,
    profiler_notes: [],
    ...overrides,
  };
}

function profile(table: string, columns: ColumnProfile[]): TableProfile {
  return {
    table_name: table,
    object_type: "table",
    row_count: 10,
    columns,
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  };
}

function readyState(profiledAt: string): ConnectionProfileState {
  return {
    installId: "i1",
    orgId: "org1",
    connectionGroupId: "grp_prod",
    dbType: "postgres",
    baseline: { profiledAt, tableCount: 1 },
    baselineError: null,
    llm: null,
  };
}

const NOW = new Date("2026-07-11T00:00:00Z");

describe("loadCoverageOverview", () => {
  it("computes a ready connection's coverage scoped to its group (AC1)", async () => {
    const entities: ParsedEntity[] = [
      // In-group entity models `orders` (status covered, amount not).
      {
        name: "orders",
        table: "orders",
        connection: "grp_prod",
        description: "Orders",
        dimensions: [{ name: "status", sql: "status", type: "string", description: "Lifecycle" }],
        measures: [],
        joins: [],
        query_patterns: [],
      },
      // An out-of-group entity for the SAME table must NOT be matched.
      {
        name: "orders",
        table: "orders",
        connection: "grp_other",
        dimensions: [{ name: "amount", sql: "amount", type: "number" }],
        measures: [],
        joins: [],
        query_patterns: [],
      },
    ];

    const overview = await loadCoverageOverview("org1", NOW, {
      ...WITH_DB,
      listConnections: async () => [{ installId: "i1", groupId: "grp_prod", dbType: "postgres" }],
      loadEntities: async () => entities,
      getState: async () => readyState("2026-07-08T00:00:00Z"),
      getBaseline: async () => [profile("orders", [col("status"), col("amount")])],
      ensureBaseline: async () => undefined,
    });

    expect(overview.profiling).toBe(false);
    expect(overview.connections).toHaveLength(1);
    const conn = overview.connections[0];
    expect(conn.status).toBe("ready");
    expect(conn.group).toBe("grp_prod");
    expect(conn.freshness).toBe("profiled 3 days ago");
    // Scoped to grp_prod: status covered by the in-group entity, amount not
    // (the out-of-group entity's `amount` dimension is excluded) → partial.
    expect(conn.coverage?.tables[0].state).toBe("partial");
    const cols = conn.coverage?.tables[0].columns ?? [];
    expect(cols.find((c) => c.column === "status")?.covered).toBe(true);
    expect(cols.find((c) => c.column === "amount")?.covered).toBe(false);
  });

  it("triggers the lazy backfill and reports profiling for a never-profiled connection (AC4)", async () => {
    const ensureBaseline = mock(async (_t: BaselineProfileTarget) => undefined);
    const overview = await loadCoverageOverview("org1", NOW, {
      ...WITH_DB,
      listConnections: async () => [{ installId: "i2", groupId: "grp_new", dbType: "mysql" }],
      loadEntities: async () => [],
      getState: async () => null, // never profiled
      getBaseline: async () => null,
      ensureBaseline,
    });

    expect(overview.profiling).toBe(true);
    expect(overview.connections[0].status).toBe("profiling");
    expect(overview.connections[0].coverage).toBeNull();
    // The backfill was kicked off with the connection's identity + dbType.
    expect(ensureBaseline).toHaveBeenCalledTimes(1);
    expect(ensureBaseline.mock.calls[0][0]).toMatchObject({
      orgId: "org1",
      installId: "i2",
      connectionGroupId: "grp_new",
      dbType: "mysql",
    });
  });

  it("surfaces a recorded baseline failure honestly without re-triggering the backfill", async () => {
    const ensureBaseline = mock(async () => undefined);
    const overview = await loadCoverageOverview("org1", NOW, {
      ...WITH_DB,
      listConnections: async () => [{ installId: "i3", groupId: "grp_err", dbType: "postgres" }],
      loadEntities: async () => [],
      getState: async () => ({
        installId: "i3",
        orgId: "org1",
        connectionGroupId: "grp_err",
        dbType: "postgres",
        baseline: null,
        baselineError: "Baseline profile could not resolve a live connection.",
        llm: null,
      }),
      getBaseline: async () => null,
      ensureBaseline,
    });

    expect(overview.profiling).toBe(false);
    expect(overview.connections[0].status).toBe("error");
    expect(overview.connections[0].error).toContain("could not resolve");
    // A recorded failure is shown, never re-stormed on the render.
    expect(ensureBaseline).not.toHaveBeenCalled();
  });

  it("reports an unreadable stored baseline as an error, not fake coverage", async () => {
    const overview = await loadCoverageOverview("org1", NOW, {
      ...WITH_DB,
      listConnections: async () => [{ installId: "i4", groupId: "g", dbType: "postgres" }],
      loadEntities: async () => [],
      getState: async () => readyState("2026-07-10T00:00:00Z"),
      getBaseline: async () => null, // baseline flagged present but payload unreadable
      ensureBaseline: async () => undefined,
    });
    expect(overview.connections[0].status).toBe("error");
    expect(overview.connections[0].coverage).toBeNull();
  });

  it("reports a never-profiled connection with no db_type as an error, not perpetual profiling", async () => {
    const ensureBaseline = mock(async () => undefined);
    const overview = await loadCoverageOverview("org1", NOW, {
      ...WITH_DB,
      listConnections: async () => [{ installId: "i5", groupId: "grp_x", dbType: null }],
      loadEntities: async () => [],
      getState: async () => null, // never profiled
      getBaseline: async () => null,
      ensureBaseline,
    });
    // A null dbType can't resolve a live connection — surface it, don't spin the
    // client's poll forever on a `profiling` that can never resolve.
    expect(overview.profiling).toBe(false);
    expect(overview.connections[0].status).toBe("error");
    expect(overview.connections[0].error).toContain("missing a database type");
    expect(ensureBaseline).not.toHaveBeenCalled();
  });

  it("returns an empty overview with no org context", async () => {
    const overview = await loadCoverageOverview(null, NOW, {
      listConnections: async () => {
        throw new Error("should not enumerate without an org");
      },
    });
    expect(overview).toEqual({ connections: [], profiling: false });
  });
});
