/**
 * Tests: executeSQL blocks queries when rate-limited and
 * handles query execution within rate-limit slots.
 *
 * Separate file from sql-audit.test.ts because mock.module() is
 * process-global and irreversible — we need different mock behavior
 * for withSourceSlot.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { RateLimitExceededError, ConcurrencyLimitError } from "@atlas/api/lib/effect/errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

// --- Mocks ---

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
}));

// Mutable rate-limit mock — tests override slotAcquired/slotReason.
// withSourceSlot either passes through the inner Effect or fails with a tagged error.
// Note: this mock does not replicate acquireUseRelease release semantics — that is
// tested in source-rate-limit.test.ts. This mock only verifies the pipeline's response
// to slot acquisition success/failure.
let slotAcquired = true;
let slotErrorType: "rate-limit" | "concurrency" = "rate-limit";
let slotReason = "QPM limit reached (3/min)";
let slotRetryAfterMs: number | undefined = 5000;

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: Effect.Effect<any, any>) => {
    if (!slotAcquired) {
      if (slotErrorType === "concurrency") {
        return Effect.fail(new ConcurrencyLimitError({
          message: slotReason,
          sourceId: _sourceId,
          limit: 0,
        }));
      }
      return Effect.fail(new RateLimitExceededError({
        message: slotReason,
        sourceId: _sourceId,
        limit: 0,
        retryAfterMs: slotRetryAfterMs,
      }));
    }
    return effect;
  },
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

// Import after mocks
const { executeSQL } = await import("@atlas/api/lib/tools/sql");

// --- Internal DB mock pool to capture audit inserts ---

let auditInserts: Array<{ sql: string; params?: unknown[] }> = [];

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    auditInserts.push({ sql, params });
    return { rows: [] };
  },
  end: async () => {},
  on: () => {},
};

function extractAuditParams(params: unknown[]) {
  return {
    userId: params[0],
    userLabel: params[1],
    authMode: params[2],
    sql: params[3] as string,
    durationMs: params[4] as number,
    rowCount: params[5] as number | null,
    success: params[6] as boolean,
    error: params[7] as string | null,
    sourceId: params[8] as string | null,
    sourceType: params[9] as string | null,
    targetHost: params[10] as string | null,
  };
}

// --- Test helpers ---

const exec = (sql: string) =>
  executeSQL.execute!(
    { sql, explanation: "test" },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

const getAuditInserts = () =>
  auditInserts.filter((q) => q.sql.includes("INSERT INTO audit_log"));

// --- Tests ---

describe("executeSQL rate-limit rejection", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() =>
      Promise.resolve({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Acme" }],
      }),
    );
    // Default: rate-limited (QPM)
    slotAcquired = false;
    slotErrorType = "rate-limit";
    slotReason = "QPM limit reached (3/min)";
    slotRetryAfterMs = 5000;
  });

  afterEach(() => {
    slotAcquired = true;
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("returns success: false with the rate limit reason", async () => {
    const result = await exec("SELECT id, name FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("QPM limit reached");
  });

  it("does not execute the query against the database", async () => {
    await exec("SELECT id, name FROM companies");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("passes retryAfterMs through in the response", async () => {
    const result = await exec("SELECT id, name FROM companies");
    expect(result.retryAfterMs).toBe(5000);
  });

  it("creates an audit log entry with 'Rate limited' in the error field", async () => {
    await exec("SELECT id, name FROM companies");
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(false);
    expect(audit.error).toContain("Rate limited");
    expect(audit.error).toContain("QPM limit reached");
  });

  it("handles ConcurrencyLimitError the same as RateLimitExceededError", async () => {
    slotErrorType = "concurrency";
    slotReason = 'Source "default" concurrency limit reached (5)';

    const result = await exec("SELECT id, name FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("concurrency limit reached");
    expect(queryFn).not.toHaveBeenCalled();

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.error).toContain("Rate limited");
    expect(audit.error).toContain("concurrency limit reached");
  });
});

describe("executeSQL query execution within slot", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    // Allow rate limiting (withSourceSlot passes through to inner Effect)
    slotAcquired = true;
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("returns error response when query throws", async () => {
    queryFn = mock(() => Promise.reject(new Error("connection refused")));

    const result = await exec("SELECT id FROM companies");

    expect(result.success).toBe(false);
    expect(result.error).toContain("connection refused");
  });

  it("returns success on successful query", async () => {
    queryFn = mock(() =>
      Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
    );

    const result = await exec("SELECT id FROM companies");

    expect(result.success).toBe(true);
  });

  it("creates audit log on query failure", async () => {
    queryFn = mock(() => Promise.reject(new Error("timeout")));

    await exec("SELECT id FROM companies");

    const inserts = getAuditInserts();
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const failedAudit = inserts.find((i) => {
      const p = extractAuditParams(i.params!);
      return !p.success;
    });
    expect(failedAudit).toBeDefined();
  });
});
