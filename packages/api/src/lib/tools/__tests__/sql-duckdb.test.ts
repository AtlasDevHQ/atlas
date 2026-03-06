/**
 * SQL validation tests specific to DuckDB queries.
 *
 * Verifies that:
 * - Standard SELECT queries pass validation in DuckDB mode
 * - DuckDB-specific forbidden operations (PRAGMA, ATTACH, etc.) are blocked
 * - Common DuckDB query patterns work with the PostgreSQL parser mode
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

// Mock semantic layer
mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () =>
    new Set(["sales", "customers", "products", "orders"]),
  _resetWhitelists: () => {},
}));

// Mock the DB connection
const mockDBConnection = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};

const mockDetectDBType = () => {
  const url = process.env.ATLAS_DATASOURCE_URL ?? "";
  if (url.startsWith("duckdb://")) return "duckdb";
  if (url.startsWith("postgresql://")) return "postgres";
  throw new Error(`Unsupported: ${url}`);
};

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => mockDetectDBType(),
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
  },
  detectDBType: mockDetectDBType,
}));

const { validateSQL } = await import("@atlas/api/lib/tools/sql");

const origEnv = { ...process.env };

describe("validateSQL — DuckDB mode", () => {
  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "duckdb://:memory:";
  });

  afterEach(() => {
    if (origEnv.ATLAS_DATASOURCE_URL === undefined) {
      delete process.env.ATLAS_DATASOURCE_URL;
    } else {
      process.env.ATLAS_DATASOURCE_URL = origEnv.ATLAS_DATASOURCE_URL;
    }
  });

  // --- Valid queries ---

  it("allows simple SELECT", () => {
    const result = validateSQL("SELECT * FROM sales");
    expect(result.valid).toBe(true);
  });

  it("allows SELECT with aggregate functions", () => {
    const result = validateSQL(
      "SELECT COUNT(*), SUM(amount) FROM sales GROUP BY product_id"
    );
    expect(result.valid).toBe(true);
  });

  it("allows SELECT with CTE", () => {
    const result = validateSQL(
      "WITH totals AS (SELECT customer_id, SUM(amount) AS total FROM sales GROUP BY customer_id) SELECT * FROM totals"
    );
    expect(result.valid).toBe(true);
  });

  it("allows SELECT with window function", () => {
    const result = validateSQL(
      "SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS rn FROM sales"
    );
    expect(result.valid).toBe(true);
  });

  it("allows SELECT with JOIN", () => {
    const result = validateSQL(
      "SELECT s.*, c.name FROM sales s JOIN customers c ON s.customer_id = c.id"
    );
    expect(result.valid).toBe(true);
  });

  it("allows CAST expressions", () => {
    const result = validateSQL(
      "SELECT CAST(amount AS VARCHAR) FROM sales"
    );
    expect(result.valid).toBe(true);
  });

  it("allows COALESCE and CASE", () => {
    const result = validateSQL(
      "SELECT COALESCE(name, 'unknown'), CASE WHEN amount > 100 THEN 'high' ELSE 'low' END FROM sales"
    );
    expect(result.valid).toBe(true);
  });

  // --- Blocked operations ---

  it("blocks PRAGMA", () => {
    const result = validateSQL("PRAGMA database_list");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks ATTACH", () => {
    const result = validateSQL("ATTACH '/tmp/other.duckdb' AS other");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks DETACH", () => {
    const result = validateSQL("DETACH other");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks INSTALL", () => {
    const result = validateSQL("INSTALL httpfs");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks EXPORT", () => {
    const result = validateSQL("EXPORT DATABASE '/tmp/backup'");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks IMPORT", () => {
    const result = validateSQL("IMPORT DATABASE '/tmp/backup'");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks CHECKPOINT", () => {
    const result = validateSQL("CHECKPOINT");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks INSERT", () => {
    const result = validateSQL("INSERT INTO sales VALUES (1, 100)");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks CREATE TABLE", () => {
    const result = validateSQL("CREATE TABLE foo (id INT)");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks DROP TABLE", () => {
    const result = validateSQL("DROP TABLE sales");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks DESCRIBE", () => {
    const result = validateSQL("DESCRIBE sales");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks SHOW", () => {
    const result = validateSQL("SHOW TABLES");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  // --- Table whitelist ---

  it("rejects queries on non-whitelisted tables", () => {
    const result = validateSQL("SELECT * FROM secret_data");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("allows queries on whitelisted tables", () => {
    const result = validateSQL("SELECT * FROM customers");
    expect(result.valid).toBe(true);
  });

  // --- File-reading function blocks ---

  it("blocks read_csv_auto", () => {
    const result = validateSQL("SELECT * FROM read_csv_auto('/etc/passwd')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks read_parquet", () => {
    const result = validateSQL("SELECT * FROM read_parquet('/data/secret.parquet')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks read_json_auto", () => {
    const result = validateSQL("SELECT * FROM read_json_auto('/tmp/data.json')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks SET", () => {
    const result = validateSQL("SET memory_limit='100GB'");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks COPY ... TO (via base patterns)", () => {
    const result = validateSQL("COPY sales TO '/tmp/exfil.csv'");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("blocks LOAD (via base patterns)", () => {
    const result = validateSQL("LOAD httpfs");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden");
  });
});
