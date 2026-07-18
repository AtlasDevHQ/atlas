/**
 * Tool-seam test for per-leg cache honesty in a cross-environment fanout
 * (#4546). Before this slice, `executeSqlFanout` hardcoded `cached: false` on
 * the merged result, so an ALL-HIT fanout masqueraded as a fresh zero-second
 * query. Now each leg's own `cached` rides through the merger onto its
 * `ConnectionContribution`, and the merged top-level `cached` is true only when
 * EVERY successful leg was a hit.
 *
 * Harness mirrors `sql-fanout-audit.test.ts` (two-member group routing so
 * `scope: "all"` fans out), with a per-connection cache mock: `buildCacheKey`
 * folds the connection id into the key, so each leg can independently hit or
 * miss.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";
import type { CacheEntry } from "@atlas/api/lib/cache/types";

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
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

type QueryResult = { columns: string[]; rows: Record<string, unknown>[] };
let queryFn: Mock<(sql: string, timeout?: number) => Promise<QueryResult>>;
// Connection ids that should reject their query (simulate a down member) — used
// by the partial-failure test to prove a fanout with one errored leg does NOT
// wear a "cached" chip.
let failingConns: Set<string>;

function mockDBFor(connId: string) {
  return {
    query: (...args: [string, number]) =>
      failingConns.has(connId)
        ? Promise.reject(new Error(`connection ${connId} is down`))
        : queryFn(...args),
    close: async () => {},
  };
}

void mock.module("@atlas/api/lib/db/connection", () =>
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

// Per-connection cache: the key folds in the connection id so each leg hits or
// misses independently. `entriesByConn` is the fixture each test populates.
let entriesByConn: Map<string, CacheEntry>;

void mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({
    get: async (key: string) => entriesByConn.get(key) ?? null,
    set: async () => {},
    delete: async () => false,
    flush: async () => {},
    flushByOrg: async () => 0,
    stats: async () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: (_sql: string, connId: string) => `k:${connId}`,
  cacheEnabled: () => true,
  getDefaultTtl: () => 300000,
  flushCache: async () => {},
  flushCacheByOrg: async () => 0,
  setCacheBackend: async () => {},
  validateCacheBackend: async () => ({ ok: true }),
  _resetCache: () => {},
}));

// Two members so `scope: "all"` produces a real fanout.
void mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: ["us-int", "eu"] as const,
    primaryMember: "us-int",
    currentMember,
    degraded: false,
  }),
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

function hitEntry(rows: Record<string, unknown>[], ageMs: number): CacheEntry {
  return { columns: ["id"], rows, cachedAt: Date.now() - ageMs, ttl: 300_000, executionMs: 50 };
}

const fanoutAll = () =>
  executeSQL.execute!(
    { sql: "SELECT id FROM orders", explanation: "test", connectionId: "us-int", scope: "all" },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

function contribByConn(result: AnyResult, connId: string) {
  return (result.envContributions as Array<{ connectionId: string; cached?: boolean; maskingApplied?: boolean; error: string | null }>).find(
    (c) => c.connectionId === connId,
  )!;
}

describe("executeSQL fanout — per-leg cache honesty (#4546)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    entriesByConn = new Map();
    failingConns = new Set();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() => Promise.resolve({ columns: ["id"], rows: [{ id: 99 }] }));
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("an all-hit fanout reports cached:true, an age, and per-leg cached:true — not a fresh 0s query", async () => {
    entriesByConn.set("k:us-int", hitEntry([{ id: 1 }], 120_000)); // 2 min old
    entriesByConn.set("k:eu", hitEntry([{ id: 2 }], 240_000)); // 4 min old (oldest)

    const result = await fanoutAll();

    expect(result.success).toBe(true);
    // Never touched a datasource — both legs were hits.
    expect(queryFn).not.toHaveBeenCalled();
    // Top-level honesty: the merged table IS cached (was hardcoded false before).
    expect(result.cached).toBe(true);
    // Age is the OLDEST cached leg (4 min), so the caveat reflects the stalest data.
    expect(typeof result.cacheAgeMs).toBe("number");
    expect(result.cacheAgeMs).toBeGreaterThanOrEqual(239_000);
    expect(result.cacheAgeMs).toBeLessThan(260_000);
    // Per-leg honesty.
    expect(contribByConn(result, "us-int").cached).toBe(true);
    expect(contribByConn(result, "eu").cached).toBe(true);
    // Masking untouched (no classified tables) but present + honest per leg.
    expect(contribByConn(result, "us-int").maskingApplied).toBe(false);
    expect(contribByConn(result, "eu").maskingApplied).toBe(false);
  });

  it("a mixed fanout (one hit, one live) reports cached:false top-level and per-leg honestly", async () => {
    entriesByConn.set("k:us-int", hitEntry([{ id: 1 }], 60_000)); // hit
    // eu has no entry → executes live

    const result = await fanoutAll();

    expect(result.success).toBe(true);
    // The live leg ran exactly once.
    expect(queryFn).toHaveBeenCalledTimes(1);
    // Not every leg hit → the merged result is NOT cached, and no aggregate age.
    expect(result.cached).toBe(false);
    expect(result.cacheAgeMs).toBeUndefined();
    // Per-leg truth: us-int cached, eu live.
    expect(contribByConn(result, "us-int").cached).toBe(true);
    expect(contribByConn(result, "eu").cached).toBe(false);
  });

  it("a partial-failure fanout (one leg errored) is NOT reported as cached, even if the surviving legs all hit", async () => {
    entriesByConn.set("k:us-int", hitEntry([{ id: 1 }], 60_000)); // surviving leg is a hit
    failingConns.add("eu"); // eu errors (no cache entry, its query rejects)

    const result = await fanoutAll();

    // One leg succeeded → still a success:true partial result (agent sees the
    // per-leg failure), NOT the all-errored branch.
    expect(result.success).toBe(true);
    // The crux: the merged table is partial, so it must NOT claim a clean
    // "cached · Xm ago" chip even though the only successful leg was a hit.
    expect(result.cached).toBe(false);
    expect(result.cacheAgeMs).toBeUndefined();
    // Per-leg honesty is preserved: the survivor reports its hit; the failed
    // leg carries an error and omits cache/masking (never reached those layers).
    expect(contribByConn(result, "us-int").cached).toBe(true);
    expect(contribByConn(result, "us-int").error).toBeNull();
    const eu = contribByConn(result, "eu");
    expect(eu.error).not.toBeNull();
    expect(eu.cached).toBeUndefined();
  });
});
