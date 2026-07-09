/**
 * End-to-end binding proof for dashboard parameters (#2267).
 *
 * Runs the REAL `runUserQueryPipeline` (the dashboard render/refresh path) with
 * a card SQL that references `:date_from` and an injection-shaped parameter
 * value, then asserts that the value reached the driver ONLY through the bind
 * array — the executed SQL carries `$1`, never the raw value or the `:name`.
 *
 * Mirrors the sql-audit harness: a connection mock captures every `db.query`
 * argument (including the new 3rd bind-params arg), and the semantic whitelist
 * is stubbed so validation passes.
 */
import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["signups"]),
  _resetWhitelists: () => {},
}));

let queryFn: Mock<(...args: unknown[]) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;

const mockConn = {
  query: (...args: unknown[]) => queryFn(...args),
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

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

const { runUserQueryPipeline, validateSQL } = await import("@atlas/api/lib/tools/sql");

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

// Regression guard for the create-dashboard + scheduler paths (#2267).
// Those validate the card's RAW `:name` SQL *before* binding, relying on
// node-sql-parser tolerating named placeholders. If a parser bump ever starts
// rejecting `:name`, parameterized dashboards would silently stop validating —
// this test fails loudly instead.
describe("validateSQL accepts :name placeholders (raw, pre-bind)", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
  });
  afterEach(() => {
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("validates a card that references :date_from / :date_to", async () => {
    const r = await validateSQL(
      "SELECT day FROM signups WHERE created_at >= :date_from AND created_at < :date_to",
    );
    expect(r.valid).toBe(true);
  });

  it("validates a placeholder used with a ::cast", async () => {
    const r = await validateSQL("SELECT day FROM signups WHERE created_at >= :date_from::timestamptz");
    expect(r.valid).toBe(true);
  });
});

describe("runUserQueryPipeline — dashboard parameter binding", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() => Promise.resolve({ columns: ["day"], rows: [{ day: "2026-01-01" }] }));
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("binds an injection-shaped parameter value instead of interpolating it", async () => {
    const malicious = "2020-01-01'; DROP TABLE signups; --";
    const outcome = await runUserQueryPipeline({
      sql: "SELECT day FROM signups WHERE created_at >= :date_from",
      explanation: "test render",
      // `text` value would normally be a date, but the pipeline binds whatever
      // resolved value it's given — the resolver/route enforces type, the
      // pipeline enforces "bind, never interpolate".
      parameters: { date_from: malicious },
    });

    expect(outcome.kind).toBe("ok");
    expect(queryFn).toHaveBeenCalledTimes(1);
    const [executedSql, , bindParams] = queryFn.mock.calls[0] as [string, number, unknown[]];

    // Placeholder rewritten to a positional bind; raw value absent from SQL.
    expect(executedSql).toContain("$1");
    expect(executedSql).not.toContain(":date_from");
    expect(executedSql).not.toContain("DROP TABLE");
    expect(executedSql).not.toContain(malicious);
    // The value travelled only through the bind array.
    expect(bindParams).toEqual([malicious]);
  });

  it("runs non-parameterized SQL with no bind array (unchanged path)", async () => {
    const outcome = await runUserQueryPipeline({
      sql: "SELECT day FROM signups",
      explanation: "test",
    });

    expect(outcome.kind).toBe("ok");
    const [, , bindParams] = queryFn.mock.calls[0] as [string, number, unknown[] | undefined];
    expect(bindParams).toBeUndefined();
  });

  it("rejects a placeholder with no resolved value (fail closed, never sent raw)", async () => {
    const outcome = await runUserQueryPipeline({
      sql: "SELECT day FROM signups WHERE created_at >= :date_from",
      explanation: "test",
      parameters: {}, // date_from not provided
    });

    expect(outcome.kind).toBe("validation_failed");
    expect(queryFn).not.toHaveBeenCalled();
  });
});
