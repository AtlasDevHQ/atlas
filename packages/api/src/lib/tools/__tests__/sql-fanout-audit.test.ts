/**
 * Regression test for #3616 — a cross-environment fanout writes its PARENT
 * audit row with `duration_ms = 0` (deliberate housekeeping sentinel), while
 * the child legs carry their real per-shard durations and back-reference the
 * parent. `/analytics/slow` relies on that zero to exclude the parent from its
 * average (verified end-to-end in `audit-slow-pg.test.ts`); this pins the
 * contract at the write site so a future change to the parent's duration is
 * caught here rather than silently re-skewing the analytics.
 *
 * Harness mirrors `sql-cache-audit.test.ts` (a mock pg.Pool injected via
 * `_resetPool` captures the audit INSERTs) plus the group-routing lookup mock
 * from `agent-cross-env-routing.test.ts` so `scope: "all"` fans out without a
 * real internal DB.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

type QueryResult = { columns: string[]; rows: Record<string, unknown>[] };
let queryFn: Mock<(sql: string, timeout?: number) => Promise<QueryResult>>;

function mockDBFor(_connId: string) {
  return {
    query: (...args: [string, number]) => queryFn(...args),
    close: async () => {},
  };
}

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBFor("default"),
    connections: {
      get: (id: string) => mockDBFor(id ?? "default"),
      getDefault: () => mockDBFor("default"),
      getForOrg: (_orgId: string, id?: string) => mockDBFor(id ?? "default"),
      getTargetHost: () => "localhost:5432",
      describe: () => [
        { id: "us-int", dbType: "postgres" as const },
        { id: "eu", dbType: "postgres" as const },
      ],
    },
  }),
);

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

// Cache disabled — this test is about fanout audit rows, not caching.
mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

// Group routing — two members so `scope: "all"` produces a real fanout.
mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: ["us-int", "eu"] as const,
    primaryMember: "us-int",
    currentMember,
    degraded: false,
  }),
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

let auditInserts: Array<{ sql: string; params: unknown[] }> = [];

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    auditInserts.push({ sql, params: params ?? [] });
    return { rows: [] };
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

// Positional layout of the audit_log INSERT params (see auth/audit.ts): the
// `id` column (index 18) is appended ONLY for a fanout parent, so its presence
// distinguishes parent rows from child rows.
function parseAudit(params: unknown[]) {
  return {
    sql: params[3] as string,
    durationMs: params[4] as number,
    sourceId: params[8] as string | null,
    parentAuditId: params[17] as string | null,
    id: params.length > 18 ? (params[18] as string) : undefined,
  };
}

describe("executeSQL fanout parent audit duration (#3616)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() =>
      Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
    );
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("writes the fanout parent row at duration_ms=0 with children referencing it", async () => {
    const result = (await executeSQL.execute!(
      { sql: "SELECT * FROM orders", explanation: "test", connectionId: "us-int", scope: "all" },
      { toolCallId: "test", messages: [], abortSignal: undefined as never },
    )) as AnyResult;

    expect(result.success).toBe(true);

    const audits = auditInserts
      .filter((q) => q.sql.includes("INSERT INTO audit_log"))
      .map((q) => parseAudit(q.params));

    // Exactly one parent (carries an explicit `id`) + one child per member.
    const parents = audits.filter((a) => a.id !== undefined);
    const children = audits.filter((a) => a.id === undefined);
    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(2);

    // The crux of #3616: the parent is pure linkage housekeeping written
    // before any shard runs, so it carries no execution cost — duration_ms=0,
    // no source_id, no parent of its own.
    expect(parents[0].durationMs).toBe(0);
    expect(parents[0].parentAuditId).toBeNull();
    expect(parents[0].sourceId).toBeNull();

    // Every child back-references the parent and carries a real source id;
    // their durations (not the parent's) are what the analytics average sees.
    for (const child of children) {
      expect(child.parentAuditId).toBe(parents[0].id!);
      expect(typeof child.durationMs).toBe("number");
    }
    expect(children.map((c) => c.sourceId).sort()).toEqual(["eu", "us-int"]);
  });
});
