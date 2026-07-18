/**
 * Tool-seam tests for the Query Cache elevation (#4546, milestone v0.0.56):
 *
 *   - a cache HIT carries a `cacheAgeMs` field derived from the entry's stored
 *     write timestamp (so the result card can render "cached · Xm ago" and the
 *     agent can caveat time-sensitive answers), and
 *   - the `bypassCache: true` input SKIPS the cache read (executes live) but
 *     KEEPS the write, so the fresh result re-freshens the shared entry for
 *     everyone on the same key — governance-safe because the live path re-runs
 *     every gate.
 *
 * Harness mirrors `sql-cache-audit.test.ts`: a mock pg.Pool injected via
 * `_resetPool` captures audit INSERTs, and the cache mock is STATEFUL — `set`
 * overwrites the in-memory entry `get` returns — so a bypass write followed by
 * a normal read proves "overwrites the entry, subsequent identical queries hit
 * the refreshed entry".
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";
import type { CacheEntry, CacheScope } from "@atlas/api/lib/cache/types";
// The REAL registry (sql.ts imports it from this submodule, not the barrel),
// so the per-org accounting recorded by the pipeline is observable here.
import { getOrgCacheStats, resetCacheStatsRegistry } from "@atlas/api/lib/cache/stats-registry";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

void mock.module("@atlas/api/lib/semantic", () => ({
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

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockConn,
    connections: {
      get: () => mockConn,
      getDefault: () => mockConn,
      getForOrg: () => mockConn,
    },
  }),
);

void mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

void mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

// Stateful cache mock. `cachedEntry` is what a read returns; `set` OVERWRITES
// it (and records the write), so a `bypassCache` write becomes visible to a
// later normal read — modeling the shared-entry re-freshen. `get`/`set` are
// async on purpose (mirrors the real CacheBackend contract + the phantom-hit
// guard).
let cachedEntry: CacheEntry | null = null;
let cacheSets: Array<{ key: string; entry: CacheEntry; scope: CacheScope }> = [];
// When set, the cache READ rejects — models a broken backend (fail-open path).
let cacheGetThrows = false;

void mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({
    get: async () => {
      if (cacheGetThrows) throw new Error("backend read refused");
      return cachedEntry;
    },
    set: async (key: string, entry: CacheEntry, scope: CacheScope) => {
      cacheSets.push({ key, entry, scope });
      cachedEntry = entry; // overwrite so a subsequent read sees the fresh rows
    },
    delete: async () => false,
    flush: async () => {},
    flushByOrg: async () => 0,
    stats: async () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => true,
  getDefaultTtl: () => 300000,
  flushCache: async () => {},
  flushCacheByOrg: async () => 0,
  setCacheBackend: async () => {},
  validateCacheBackend: async () => ({ ok: true }),
  _resetCache: () => {},
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

describe("executeSQL cache elevation — age on hit + bypassCache (#4546)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    cacheSets = [];
    cachedEntry = null;
    cacheGetThrows = false;
    resetCacheStatsRegistry();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() =>
      Promise.resolve({
        columns: ["id", "name"],
        rows: [{ id: 2, name: "FRESH" }],
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

  const exec = (sql: string, bypassCache?: boolean) =>
    executeSQL.execute!(
      { sql, explanation: "test", ...(bypassCache !== undefined && { bypassCache }) },
      { toolCallId: "test", messages: [], abortSignal: undefined as never },
    ) as Promise<AnyResult>;

  it("a cache hit carries cacheAgeMs derived from the entry's write timestamp", async () => {
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
      cachedAt: Date.now() - 180_000, // written ~3 minutes ago
      ttl: 300_000,
      executionMs: 42,
    };

    const result = await exec("SELECT id, name FROM companies");

    expect(result.success).toBe(true);
    expect(result.cached).toBe(true);
    // Never touches the datasource on a hit.
    expect(queryFn).not.toHaveBeenCalled();
    // Age reflects the ~3-minute-old write timestamp (generous upper bound
    // absorbs test wall-clock; lower bound proves it isn't 0/undefined).
    expect(typeof result.cacheAgeMs).toBe("number");
    expect(result.cacheAgeMs).toBeGreaterThanOrEqual(179_000);
    expect(result.cacheAgeMs).toBeLessThan(200_000);
    // The 1-element single-env contribution reports the same cache state.
    expect(result.envContributions).toHaveLength(1);
    expect(result.envContributions[0].cached).toBe(true);
  });

  it("a live (miss) execution has no cacheAgeMs and reports cached:false per leg", async () => {
    cachedEntry = null; // miss → executes live
    const result = await exec("SELECT id, name FROM companies");

    expect(result.success).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.cacheAgeMs).toBeUndefined();
    expect(result.envContributions[0].cached).toBe(false);
  });

  it("bypassCache:true skips the read (executes live) but keeps the write", async () => {
    // A stale entry is present — a normal read would serve it. Bypass must not.
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "STALE" }],
      cachedAt: Date.now() - 10_000,
      ttl: 300_000,
      executionMs: 99,
    };

    const result = await exec("SELECT id, name FROM companies", true);

    expect(result.success).toBe(true);
    // Executed live: the datasource WAS hit and the FRESH rows are served,
    // not the stale cached ones.
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.cacheAgeMs).toBeUndefined();
    expect(result.rows).toEqual([{ id: 2, name: "FRESH" }]);

    // The WRITE is kept: exactly one fresh entry written back, carrying the
    // fresh rows + scope tags (#4548) — governance-safe re-freshen for the key.
    expect(cacheSets).toHaveLength(1);
    expect(cacheSets[0].entry.rows).toEqual([{ id: 2, name: "FRESH" }]);
    expect(typeof cacheSets[0].scope.connectionId).toBe("string");
    expect(cacheSets[0].scope.connectionId.length).toBeGreaterThan(0);
  });

  it("stamps a capped sqlPreview on the written entry (#4550)", async () => {
    cachedEntry = null; // miss → executes live → writes back
    const longSql = `SELECT id, name FROM companies WHERE name IN (${Array.from({ length: 60 }, (_, i) => `'company-number-${i}'`).join(", ")})`;
    expect(longSql.length).toBeGreaterThan(200);

    await exec(longSql);

    expect(cacheSets).toHaveLength(1);
    const preview = cacheSets[0].entry.sqlPreview;
    expect(typeof preview).toBe("string");
    // Capped at 200 chars — a preview, never full-SQL retention. Asserted
    // via cap + prefix content (not exact equality) so pipeline SQL
    // normalization can't make this brittle.
    expect(preview!.length).toBeLessThanOrEqual(200);
    expect(preview).toContain("SELECT id, name FROM companies");
    expect(preview!.length).toBeGreaterThanOrEqual(190);
  });

  it("after a bypass write, a subsequent identical query hits the refreshed entry", async () => {
    // Start with a stale entry.
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "STALE" }],
      cachedAt: Date.now() - 10_000,
      ttl: 300_000,
      executionMs: 99,
    };

    // 1) Bypass: executes live, overwrites the entry with FRESH rows.
    const bypassed = await exec("SELECT id, name FROM companies", true);
    expect(bypassed.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // 2) Normal read of the same key: hits the REFRESHED entry (fresh rows),
    // without a second datasource round-trip.
    const rehit = await exec("SELECT id, name FROM companies");
    expect(rehit.success).toBe(true);
    expect(rehit.cached).toBe(true);
    expect(rehit.rows).toEqual([{ id: 2, name: "FRESH" }]);
    // Still only ONE datasource execution total — the second call was a hit.
    expect(queryFn).toHaveBeenCalledTimes(1);
    // A just-written entry is near-zero age.
    expect(result_ageIsFresh(rehit.cacheAgeMs)).toBe(true);
  });

  it("clamps cacheAgeMs to 0 when the entry's timestamp is in the future (clock skew)", async () => {
    // A replica whose clock ran ahead can stamp `cachedAt` in the future
    // relative to the reader. The age must never go negative.
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
      cachedAt: Date.now() + 5_000,
      ttl: 300_000,
      executionMs: 10,
    };

    const result = await exec("SELECT id, name FROM companies");
    expect(result.cached).toBe(true);
    expect(result.cacheAgeMs).toBe(0);
  });

  it("without bypass, a present entry is served (control for the bypass tests)", async () => {
    cachedEntry = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "STALE" }],
      cachedAt: Date.now() - 10_000,
      ttl: 300_000,
      executionMs: 99,
    };

    const result = await exec("SELECT id, name FROM companies");
    expect(result.cached).toBe(true);
    expect(queryFn).not.toHaveBeenCalled();
    expect(result.rows).toEqual([{ id: 1, name: "STALE" }]);
  });

  // ── #4549 — read-site hit/miss accounting into the org stats registry ────
  //
  // This suite runs with no RequestContext, so accesses land in the no-org
  // bucket (`getOrgCacheStats(undefined)`) — the single production producer
  // of the admin cache page's numbers is the call site under test here.
  describe("org stats registry accounting at the read site", () => {
    const bucket = () => getOrgCacheStats(undefined);

    it("a cache hit records exactly one hit", async () => {
      cachedEntry = {
        columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }],
        cachedAt: Date.now(), ttl: 300_000, executionMs: 1,
      };
      await exec("SELECT id, name FROM companies");
      expect(bucket().hits).toBe(1);
      expect(bucket().misses).toBe(0);
    });

    it("a cache miss records exactly one miss", async () => {
      cachedEntry = null;
      await exec("SELECT id, name FROM companies");
      expect(bucket().hits).toBe(0);
      expect(bucket().misses).toBe(1);
    });

    it("a bypass records NOTHING — it consulted no cache, so it is neither hit nor miss", async () => {
      cachedEntry = {
        columns: ["id", "name"], rows: [{ id: 1, name: "STALE" }],
        cachedAt: Date.now(), ttl: 300_000, executionMs: 1,
      };
      await exec("SELECT id, name FROM companies", true);
      expect(bucket().since).toBeNull(); // untouched bucket
    });

    it("a failed cache read records NOTHING — a backend outage is not a miss", async () => {
      cacheGetThrows = true;
      const result = await exec("SELECT id, name FROM companies");
      // Fail-open: the query still executed live...
      expect(result.success).toBe(true);
      expect(queryFn).toHaveBeenCalledTimes(1);
      // ...but the outage did not pollute the hit-rate accounting.
      expect(bucket().since).toBeNull();
    });
  });
});

/** A freshly-written entry's age should be small (seconds), never undefined. */
function result_ageIsFresh(ageMs: unknown): boolean {
  return typeof ageMs === "number" && ageMs >= 0 && ageMs < 5_000;
}
