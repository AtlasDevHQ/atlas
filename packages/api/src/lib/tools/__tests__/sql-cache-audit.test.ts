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
import type { CacheEntry, CacheScope } from "@atlas/api/lib/cache/types";

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

// Cache mock — ENABLED, returning whatever `cachedEntry` is set to. A null
// entry is a miss (executes); a populated entry is a hit (short-circuits).
// `cacheSets` captures every write (key + entry + scope) so the miss path's
// `executionMs` stamp AND the scope tags are assertable.
//
// `get`/`set` are async on purpose: they mirror the real async CacheBackend
// contract, and — load-bearing — an async `get` is what turns these tests into
// a phantom-hit guard. If the pipeline ever stops awaiting the read, the
// unawaited Promise is truthy and a MISS reads as a HIT; the miss test below
// then fails (it would serve a phantom hit instead of executing).
let cachedEntry: CacheEntry | null = null;
let cacheSets: Array<{ key: string; entry: CacheEntry; scope: CacheScope }> = [];

void mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({
    get: async () => cachedEntry,
    set: async (key: string, entry: CacheEntry, scope: CacheScope) => {
      cacheSets.push({ key, entry, scope });
    },
    delete: async () => false,
    flush: async () => {},
    flushByOrg: async () => 0,
    stats: async () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => true,
  // Distinctive value so the write test can prove the entry's `ttl` is
  // threaded from getDefaultTtl(authOrgId) (#4545), not a hardcoded literal.
  getDefaultTtl: () => 88888,
  flushCache: async () => {},
  flushCacheByOrg: async () => 0,
  setCacheBackend: async () => {},
  validateCacheBackend: async () => ({ ok: true }),
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

    // The write carries scope tags (#4548): the connection the rows came from,
    // so a later flushByOrg can target exactly these entries. connectionId is
    // always present; orgId rides the request context (unset here → undefined).
    expect(cacheSets[0].scope).toBeDefined();
    expect(typeof cacheSets[0].scope.connectionId).toBe("string");
    expect(cacheSets[0].scope.connectionId.length).toBeGreaterThan(0);

    // #4545 — the per-entry TTL is stamped from getDefaultTtl(authOrgId)
    // (the workspace tier), not a constant. A regression that drops the
    // `cacheTtl` thread or hardcodes a literal fails here.
    expect(cacheSets[0].entry.ttl).toBe(88888);

    // …and it equals the duration logged on the same execution's audit row,
    // proving the stamp is wired to the real measured duration, not a literal.
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    expect(extractAuditParams(inserts[0].params!).durationMs).toBe(stamped);
  });

  // #4548 — the async-read phantom-hit guard, stated explicitly. With an async
  // `get()`, a MISS returns `Promise<null>`. If the pipeline stops awaiting the
  // read, that Promise is truthy and the query reads as a HIT that serves
  // `undefined` rows for EVERY query. Here a miss must execute live: the
  // datasource is queried and the fresh (uncached) rows are served.
  it("awaits the async cache read so a miss executes live (no phantom hit)", async () => {
    cachedEntry = null; // async get resolves to null → a genuine miss
    const result = await exec("SELECT id, name FROM companies");

    expect(result.success).toBe(true);
    expect(result.cached).toBe(false); // NOT a phantom hit
    expect(queryFn).toHaveBeenCalled(); // the datasource was actually hit
    expect(result.rows).toEqual([{ id: 1, name: "Acme" }]); // real rows, not undefined
  });
});
