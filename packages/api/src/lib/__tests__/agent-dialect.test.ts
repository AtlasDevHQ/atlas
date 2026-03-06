import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata } from "../db/connection";
import type { DialectHint } from "../plugins/wiring";

// --- Mutable state for tests ---
let mockDialectHints: readonly DialectHint[] = [];

const mockDBConnection = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};

const mockEntries: ConnectionMetadata[] = [];

function resetMockEntries() {
  mockEntries.length = 0;
  mockEntries.push({ id: "default", dbType: "postgres" });
}

resetMockEntries();

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => "postgres" as const,
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => mockEntries.map((e) => e.id),
    describe: () =>
      mockEntries.map((e) => ({
        id: e.id,
        dbType: e.dbType,
        description: e.description,
      })),
    _reset: () => { mockEntries.length = 0; },
  },
  detectDBType: () => "postgres" as const,
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => mockDialectHints,
}));

const { buildSystemParam } = await import("@atlas/api/lib/agent");

describe("appendDialectHints", () => {
  beforeEach(() => {
    resetMockEntries();
    mockDialectHints = [];
  });

  test("no hints: prompt has no 'Additional SQL Dialect Notes' section", () => {
    mockDialectHints = [];
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).not.toContain("Additional SQL Dialect Notes");
  });

  test("single hint: prompt includes dialect text", () => {
    mockDialectHints = [{ pluginId: "bq", dialect: "Use SAFE_DIVIDE for BigQuery division." }];
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("## Additional SQL Dialect Notes");
    expect(content).toContain("Use SAFE_DIVIDE for BigQuery division.");
  });

  test("multiple hints: joined with double newline", () => {
    mockDialectHints = [
      { pluginId: "bq", dialect: "BigQuery: use SAFE_DIVIDE." },
      { pluginId: "redshift", dialect: "Redshift: use GETDATE()." },
    ];
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("## Additional SQL Dialect Notes");
    expect(content).toContain("BigQuery: use SAFE_DIVIDE.");
    expect(content).toContain("Redshift: use GETDATE().");
    // The two hints should be separated by double newline
    const section = content.split("## Additional SQL Dialect Notes")[1];
    expect(section).toContain("BigQuery: use SAFE_DIVIDE.\n\nRedshift: use GETDATE().");
  });

  test("hints are appended after dialect guide for MySQL", () => {
    mockEntries.length = 0;
    mockEntries.push({ id: "default", dbType: "mysql" });
    mockDialectHints = [{ pluginId: "custom", dialect: "Custom MySQL note." }];

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("SQL Dialect: MySQL");
    expect(content).toContain("## Additional SQL Dialect Notes");
    expect(content).toContain("Custom MySQL note.");
    // Dialect notes should come after the MySQL guide
    const mysqlIdx = content.indexOf("SQL Dialect: MySQL");
    const hintsIdx = content.indexOf("Additional SQL Dialect Notes");
    expect(hintsIdx).toBeGreaterThan(mysqlIdx);
  });

  test("extracts .dialect from DialectHint, not pluginId", () => {
    mockDialectHints = [{ pluginId: "should-not-appear", dialect: "Only this text." }];
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Only this text.");
    expect(content).not.toContain("should-not-appear");
  });

  test.each([
    ["clickhouse", "SQL Dialect: ClickHouse"],
    ["snowflake", "SQL Dialect: Snowflake"],
    ["duckdb", "SQL Dialect: DuckDB"],
    ["salesforce", "Query Language: Salesforce SOQL"],
  ])("non-core dbType %s without plugin hints omits hardcoded guide", (dbType, oldHeader) => {
    mockEntries.length = 0;
    mockEntries.push({ id: "default", dbType: dbType as "clickhouse" | "snowflake" | "duckdb" | "salesforce" });
    mockDialectHints = [];

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).not.toContain(oldHeader);
  });
});
