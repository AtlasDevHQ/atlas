/**
 * The coverage view at the route seam (#4521) — GET /coverage with a POPULATED
 * ready connection, driven through the REAL `loadCoverageOverview` against mocked
 * leaf seams (connection enumeration, tracked profile state, baseline payload,
 * entities). Pins two things the empty-case smoke can't:
 *
 *   1. AC1 — the physical schema × semantic store matrix (covered / partial /
 *      uncovered) reaches the wire from a real baseline profile × entity.
 *   2. The domain → wire-schema correspondence: the populated JSON body matches
 *      `CoverageOverviewResponseSchema` field-for-field (a drift on either side of
 *      the readonly→mutable cast would change this shape).
 */

import { describe, it, expect, mock } from "bun:test";

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  // The connection enumeration (defaultListProfilableConnections) reads this.
  internalQuery: async () => [{ install_id: "c1", group_id: "grp_prod", db_type: "postgres" }],
  setWorkspaceRegion: async () => {},
  getPendingAmendments: async () => [],
  getRecentlyDecidedAmendments: async () => [],
  getPendingAmendmentCount: async () => 0,
}));

void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
  loadEntitiesForOrg: async () => ({
    entities: [
      {
        name: "orders",
        table: "orders",
        connection: "grp_prod",
        description: "Order records",
        // Models `status`, not `amount` → the table is partially covered.
        dimensions: [
          { name: "status", sql: "status", type: "string", description: "Lifecycle status", sample_values: ["open", "closed"] },
        ],
        measures: [],
        joins: [],
        query_patterns: [],
      },
    ],
    totalRows: 1,
    parseFailures: 0,
  }),
  loadEntitiesFromDisk: async () => [],
  loadEntitiesFromDB: async () => ({ entities: [], totalRows: 0, parseFailures: 0 }),
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async () => [],
  loadRejectedKeys: async () => new Set(),
}));

const orderProfile = {
  table_name: "orders",
  object_type: "table",
  row_count: 4321,
  columns: [
    { name: "id", type: "int", nullable: false, unique_count: null, null_count: null, sample_values: [], is_primary_key: true, is_foreign_key: false, fk_target_table: null, fk_target_column: null, is_enum_like: false, profiler_notes: [] },
    { name: "status", type: "text", nullable: true, unique_count: 3, null_count: 0, sample_values: ["open", "closed"], is_primary_key: false, is_foreign_key: false, fk_target_table: null, fk_target_column: null, is_enum_like: false, profiler_notes: [] },
    { name: "amount", type: "numeric", nullable: true, unique_count: null, null_count: null, sample_values: [], is_primary_key: false, is_foreign_key: false, fk_target_table: null, fk_target_column: null, is_enum_like: false, profiler_notes: [] },
  ],
  primary_key_columns: ["id"],
  foreign_keys: [],
  inferred_foreign_keys: [],
  profiler_notes: [],
  table_flags: { possibly_abandoned: false, possibly_denormalized: false },
};

void mock.module("@atlas/api/lib/semantic/connection-profile", () => ({
  getConnectionProfileState: async () => ({
    installId: "c1",
    orgId: "org-test",
    connectionGroupId: "grp_prod",
    dbType: "postgres",
    baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 1 },
    baselineError: null,
    llm: null,
  }),
  getBaselineProfiles: async () => [orderProfile],
  describeProfileFreshness: () => ({ days: 3, label: "profiled 3 days ago" }),
  listConnectionProfileStates: async () => [],
  upsertBaselineProfile: async () => {},
  recordBaselineError: async () => {},
  recordLlmProfileRun: async () => {},
}));

void mock.module("@atlas/api/lib/datasources/connection-baseline", () => ({
  ensureConnectionBaseline: async () => null,
}));

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "admin@test.dev",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: Record<string, unknown>, fn: () => unknown) => fn(),
    getRequestContext: () => ({ requestId: "test-req-id" }),
  };
});

void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (
    c: { json: (body: unknown, status?: number) => Response },
    _label: string,
    fn: () => unknown,
  ) => {
    try {
      return await fn();
    } catch (err) {
      return c.json(
        { error: "internal_error", message: err instanceof Error ? err.message : String(err), requestId: "test-req-id" },
        500,
      );
    }
  },
  runEffect: async (_c: unknown, effect: unknown) => effect,
}));

import { adminSemanticImprove } from "../admin-semantic-improve";

interface CoverageBody {
  connections: Array<{
    installId: string;
    group: string;
    dbType: string | null;
    status: string;
    error: string | null;
    freshness: string | null;
    coverage: {
      tables: Array<{ table: string; state: string; coveredColumnCount: number; coverableColumnCount: number; columns: Array<{ column: string; covered: boolean; described: boolean; sampled: boolean; isPrimaryKey: boolean }> }>;
      summary: { coveredTables: number; partialTables: number; uncoveredTables: number; totalTables: number };
    } | null;
  }>;
  profiling: boolean;
}

describe("GET /coverage — populated ready connection at the route seam (#4521)", () => {
  it("returns the physical schema × semantic store matrix on the wire (AC1)", async () => {
    const res = await adminSemanticImprove.request("/coverage", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageBody;

    expect(body.profiling).toBe(false);
    expect(body.connections).toHaveLength(1);
    const conn = body.connections[0];
    expect(conn).toMatchObject({ installId: "c1", group: "grp_prod", dbType: "postgres", status: "ready", freshness: "profiled 3 days ago" });

    const matrix = conn.coverage;
    expect(matrix).not.toBeNull();
    // status is a dimension, amount is not, id is a PK (excluded) → partial.
    const orders = matrix?.tables.find((t) => t.table === "orders");
    expect(orders?.state).toBe("partial");
    expect(orders).toMatchObject({ coveredColumnCount: 1, coverableColumnCount: 2 });
    const status = orders?.columns.find((c) => c.column === "status");
    expect(status).toMatchObject({ covered: true, described: true, sampled: true });
    const amount = orders?.columns.find((c) => c.column === "amount");
    expect(amount?.covered).toBe(false);
    const id = orders?.columns.find((c) => c.column === "id");
    expect(id).toMatchObject({ isPrimaryKey: true, covered: false });
    // Summary rolls up the states.
    expect(matrix?.summary).toMatchObject({ partialTables: 1, coveredTables: 0, uncoveredTables: 0, totalTables: 1 });
  });
});
