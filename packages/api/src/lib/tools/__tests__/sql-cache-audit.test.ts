/**
 * Regression tests for #3616 — cache-hit audit rows must carry the ORIGINAL
 * execution duration, not duration_ms=0.
 *
 * Before the fix, a cache hit short-circuited execution and logged
 * `duration_ms = 0`, indistinguishable from a pre-execution failure. Those
 * zero rows dragged down every hot query's average in `/analytics/slow`.
 * The fix persists the original execution duration on the cache entry
 * (`executionMs`) and replays it onto the cache-hit audit row.
 *
 * Mirrors `sql-audit.test.ts`'s harness: a mock pg.Pool injected via
 * `_resetPool` captures the audit INSERTs from `internalExecute`, so the
 * full audit path runs unmocked. The one difference is the cache mock —
 * here it is ENABLED and returns a populated entry so the hit path runs.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";
import type { CacheEntry } from "@atlas/api/lib/cache/types";

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
  getWhitelistedTables: () => new Set(["companies", "people"]),
  _resetWhitelists: () => {},
}));

let queryFn: Mock<(sql: string, timeout: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;

const mockConn = {
  query: (...args: [string, number]) => queryFn(...args),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockConn,
    connections: {
      get: () => mockConn,
      getDefault: () => mockConn,
      getForOrg: () => mockConn,
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

// Cache mock — ENABLED, returning whatever `cachedEntry` is set to. A null
// entry is a miss (executes); a populated entry is a hit (short-circuits).
// `cacheSets` captures every write so the miss path's `executionMs` stamp is
// assertable (the WRITE side of #3616, not just the replay).
let cachedEntry: CacheEntry | null = null;
let cacheSets: Array<{ key: string; entry: CacheEntry }> = [];

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({
    get: () => cachedEntry,
    set: (key: string, entry: CacheEntry) => {
      cacheSets.push({ key, entry });
    },
    stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => true,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

let auditInserts: Array<{ sql: string; params?: unknown[] }> = [];

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    auditInserts.push({ sql, params });
    return { rows: [] };
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

function extractAuditParams(params: unknown[]) {
  return {
    sql: params[3] as string,
    durationMs: params[4] as number,
    rowCount: params[5] as number | null,
    success: params[6] as boolean,
  };
}

describe("executeSQL cache-hit audit duration (#3616)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    cacheSets = [];
    cachedEntry = null;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() =>
      Promise.resolve({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Acme" }],
      }),
    );
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  const exec = (sql: string) =>
    executeSQL.execute!(
      { sql, explanation: "test" },
      { toolCallId: "test", messages: [], abortSignal: undefined as never },
    ) as Promise<AnyResult>;

  const getAuditInserts = () =>
    auditInserts.filter((q) => q.sql.includes("INSERT INTO audit_log"));

  it("replays the original execution duration on a cache hit (not 0)", async () => {
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
      cachedAt: Date.now(),
      ttl: 300_000,
      executionMs: 1234,
    };

    const result = await exec("SELECT id, name FROM companies");

    expect(result.success).toBe(true);
    expect(result.cached).toBe(true);
    // The underlying datasource is never touched on a hit.
    expect(queryFn).not.toHaveBeenCalled();

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(true);
    // The crux of #3616: the hit carries the original cost, not 0.
    expect(audit.durationMs).toBe(1234);
    expect(audit.durationMs).not.toBe(0);
  });

  it("falls back to 0 for legacy/external entries with no executionMs", async () => {
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
      cachedAt: Date.now(),
      ttl: 300_000,
      // no executionMs (pre-#3616 / Redis-backed entry)
    };

    await exec("SELECT id, name FROM companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    expect(extractAuditParams(inserts[0].params!).durationMs).toBe(0);
  });

  // The WRITE half of #3616: a cache MISS must persist the real execution
  // duration onto the entry it writes, so a later hit has a real cost to
  // replay. The replay tests above hand-fabricate `executionMs`; this one
  // proves the production write path (`getCache().set(..., { executionMs })`)
  // actually stamps it, wired to the measured duration rather than a constant.
  it("stamps the original execution duration onto the cache entry at write time", async () => {
    cachedEntry = null; // miss → executes against the datasource and writes cache
    // A small delay makes the measured duration reliably > 0, so a regression
    // that hardcodes `executionMs: 0` (rather than the real cost) is caught.
    queryFn = mock(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }] };
    });

    const result = await exec("SELECT id, name FROM companies");
    expect(result.success).toBe(true);
    expect(result.cached).toBe(false);

    // Exactly one entry written, carrying a real (non-zero) execution cost.
    // `?? 0` keeps the type a plain number; the `> 0` assertion then fails if
    // the field was actually undefined (i.e. never stamped), so the fallback
    // can't mask a regression.
    expect(cacheSets).toHaveLength(1);
    const stamped = cacheSets[0].entry.executionMs ?? 0;
    expect(stamped).toBeGreaterThan(0);

    // …and it equals the duration logged on the same execution's audit row,
    // proving the stamp is wired to the real measured duration, not a literal.
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    expect(extractAuditParams(inserts[0].params!).durationMs).toBe(stamped);
  });
});
