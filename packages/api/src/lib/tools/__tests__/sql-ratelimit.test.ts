/**
 * Tests: executeSQL blocks queries when rate-limited and
 * concurrency decrement survives query failures.
 *
 * Separate file from sql-audit.test.ts because mock.module() is
 * process-global and irreversible — we need different mock behavior
 * for acquireSourceSlot.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

// --- Mocks ---

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies", "people"]),
  _resetWhitelists: () => {},
}));

let queryFn: Mock<(sql: string, timeout: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;

const mockConn = {
  query: (...args: [string, number]) => queryFn(...args),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockConn,
  connections: {
    get: () => mockConn,
    getDefault: () => mockConn,
    getDBType: () => "postgres",
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
  },
  detectDBType: () => "postgres",
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

// Mutable rate-limit mock — tests override these.
// acquireSourceSlot atomically checks QPM + concurrency and increments both,
// so there is no separate incrementSourceConcurrency call in sql.ts.
let slotResult: { acquired: boolean; reason?: string; retryAfterMs?: number } = { acquired: true };
const decrementCalls: string[] = [];

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  acquireSourceSlot: () => slotResult,
  decrementSourceConcurrency: (id: string) => { decrementCalls.push(id); },
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
    decrementCalls.length = 0;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    queryFn = mock(() =>
      Promise.resolve({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Acme" }],
      }),
    );
    // Default: rate-limited
    slotResult = {
      acquired: false,
      reason: "QPM limit reached (3/min)",
      retryAfterMs: 5000,
    };
  });

  afterEach(() => {
    slotResult = { acquired: true };
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

  it("does not decrement concurrency when rate-limited (slot not acquired)", async () => {
    await exec("SELECT id, name FROM companies");
    expect(decrementCalls).toHaveLength(0);
  });
});

describe("executeSQL concurrency decrement survives query failures", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    decrementCalls.length = 0;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    _resetPool(mockPool);
    // Allow rate limiting (acquireSourceSlot atomically increments concurrency)
    slotResult = { acquired: true };
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    _resetPool(null);
  });

  it("decrements concurrency even when query throws", async () => {
    queryFn = mock(() => Promise.reject(new Error("connection refused")));

    const result = await exec("SELECT id FROM companies");

    expect(result.success).toBe(false);
    // acquireSourceSlot increments atomically; decrementSourceConcurrency
    // is called in the finally block regardless of success/failure.
    expect(decrementCalls).toHaveLength(1);
    expect(decrementCalls[0]).toBe("default");
  });

  it("decrements concurrency on successful query", async () => {
    queryFn = mock(() =>
      Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
    );

    const result = await exec("SELECT id FROM companies");

    expect(result.success).toBe(true);
    expect(decrementCalls).toHaveLength(1);
  });

  it("concurrency decrement called exactly once after failure", async () => {
    queryFn = mock(() => Promise.reject(new Error("timeout")));

    await exec("SELECT id FROM companies");

    // The finally block should decrement exactly once
    expect(decrementCalls).toHaveLength(1);
  });
});
