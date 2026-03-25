/**
 * Integration tests: executeSQL → logQueryAudit → internal DB.
 *
 * Tests the full audit path without mocking @/lib/auth/audit or @/lib/logger.
 * Instead, uses _resetPool() to inject a mock pg.Pool that captures INSERT
 * queries from internalExecute. This avoids bun mock.module leaking across
 * test files.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { createConnectionMock } from "@atlas/api/testing/connection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

// --- Mocks for sql.ts dependencies (NOT audit or logger) ---

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

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Audit INSERT parameters are positional ($1-$8).
 * This helper extracts named fields from the params array so tests
 * are not coupled to column ordering.
 */
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
    tablesAccessed: params[11] as string | null,
    columnsAccessed: params[12] as string | null,
  };
}

describe("executeSQL audit logging", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    auditInserts = [];
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    // Enable internal DB so audit inserts are captured
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
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    if (origDatasource) {
      process.env.ATLAS_DATASOURCE_URL = origDatasource;
    } else {
      delete process.env.ATLAS_DATASOURCE_URL;
    }
    _resetPool(null);
  });

  const exec = (sql: string) =>
    executeSQL.execute!(
      { sql, explanation: "test" },
      { toolCallId: "test", messages: [], abortSignal: undefined as never },
    ) as Promise<AnyResult>;

  /** Find audit INSERT queries from the mock pool */
  const getAuditInserts = () =>
    auditInserts.filter((q) => q.sql.includes("INSERT INTO audit_log"));

  it("logs audit with success: true on successful query", async () => {
    const result = await exec("SELECT id, name FROM companies");

    expect(result.success).toBe(true);
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(true);
    expect(audit.sql).toContain("SELECT id, name FROM companies");
    expect(audit.rowCount).toBe(1);
  });

  it("logs audit with success: false on query execution failure", async () => {
    queryFn = mock(() => Promise.reject(new Error("column \"nope\" does not exist")));

    const result = await exec("SELECT nope FROM companies");

    expect(result.success).toBe(false);
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(false);
    expect(audit.error).toContain("column \"nope\" does not exist");
    expect(audit.rowCount).toBeNull();
  });

  it("logs audit with 'Validation rejected:' prefix on validation failure", async () => {
    const result = await exec("DROP TABLE companies");

    expect(result.success).toBe(false);
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(false);
    expect((audit.error as string).startsWith("Validation rejected:")).toBe(true);
    expect(audit.durationMs).toBe(0);
    expect(audit.rowCount).toBeNull();
  });

  it("logs audit for non-whitelisted table access attempt", async () => {
    const result = await exec("SELECT * FROM unknown_table");

    expect(result.success).toBe(false);
    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(false);
    expect(audit.error).toContain("Validation rejected:");
    expect(audit.error).toContain("not in the allowed list");
  });

  it("truncates SQL to 2000 chars in validation-rejected audit entries", async () => {
    const longSql = "DROP TABLE " + "x".repeat(3000);
    await exec(longSql);

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.sql.length).toBeLessThanOrEqual(2000);
  });

  it("auto-appends LIMIT to the SQL logged on success", async () => {
    await exec("SELECT id FROM companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.sql).toContain("LIMIT");
  });

  it("includes sourceId and targetHost in audit entries on success", async () => {
    await exec("SELECT id FROM companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.sourceId).toBe("default");
    expect(audit.sourceType).toBe("postgres");
    expect(audit.targetHost).toBe("localhost");
  });

  it("includes sourceId in validation-rejected audit entries", async () => {
    await exec("DROP TABLE companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.sourceId).toBe("default");
    expect(audit.sourceType).toBe("postgres");
  });

  it("includes tables_accessed and columns_accessed in successful audit entries", async () => {
    await exec("SELECT id, name FROM companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    expect(audit.success).toBe(true);
    // Classification data is stored as JSON strings
    expect(audit.tablesAccessed).not.toBeNull();
    const tables: string[] = JSON.parse(audit.tablesAccessed!);
    expect(tables).toContain("companies");
    expect(audit.columnsAccessed).not.toBeNull();
    const columns: string[] = JSON.parse(audit.columnsAccessed!);
    expect(columns).toContain("id");
    expect(columns).toContain("name");
  });

  it("includes tables_accessed for JOIN queries", async () => {
    await exec("SELECT c.name, p.email FROM companies c JOIN people p ON c.id = p.company_id");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    const tables: string[] = JSON.parse(audit.tablesAccessed!);
    expect(tables).toContain("companies");
    expect(tables).toContain("people");
  });

  it("stores null classification for validation-rejected queries", async () => {
    await exec("DROP TABLE companies");

    const inserts = getAuditInserts();
    expect(inserts).toHaveLength(1);
    const audit = extractAuditParams(inserts[0].params!);
    // Validation failures don't have classification data
    expect(audit.tablesAccessed).toBeNull();
    expect(audit.columnsAccessed).toBeNull();
  });
});
