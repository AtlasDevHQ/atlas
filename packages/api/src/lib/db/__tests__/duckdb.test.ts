/**
 * Tests for the DuckDB adapter (duckdb.ts) and DuckDB URL parsing.
 *
 * Uses a real in-memory DuckDB instance (no mocks) to verify end-to-end
 * query execution, column extraction, and close behavior.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { parseDuckDBUrl, createDuckDBConnection } from "../duckdb";
import type { DBConnection } from "../connection";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parseDuckDBUrl", () => {
  it("parses duckdb://:memory: as in-memory", () => {
    const config = parseDuckDBUrl("duckdb://:memory:");
    expect(config.path).toBe(":memory:");
  });

  it("parses bare duckdb:// as in-memory", () => {
    const config = parseDuckDBUrl("duckdb://");
    expect(config.path).toBe(":memory:");
  });

  it("parses duckdb:///absolute/path.duckdb", () => {
    const config = parseDuckDBUrl("duckdb:///tmp/test.duckdb");
    expect(config.path).toBe("/tmp/test.duckdb");
  });

  it("parses duckdb://relative/path.duckdb", () => {
    const config = parseDuckDBUrl("duckdb://data/test.duckdb");
    expect(config.path).toBe("data/test.duckdb");
  });

  it("throws for non-duckdb:// URL", () => {
    expect(() => parseDuckDBUrl("postgresql://localhost/db")).toThrow("Invalid DuckDB URL");
  });
});

describe("createDuckDBConnection", () => {
  let conn: DBConnection | null = null;

  afterEach(async () => {
    if (conn) {
      await conn.close();
      conn = null;
    }
  });

  it("creates a connection and runs a simple query", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    const result = await conn.query("SELECT 42 AS answer");
    expect(result.columns).toEqual(["answer"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].answer).toBe(42);
  });

  it("returns correct columns and rows for multi-column queries", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    const result = await conn.query("SELECT 1 AS a, 'hello' AS b, true AS c");
    expect(result.columns).toEqual(["a", "b", "c"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].a).toBe(1);
    expect(result.rows[0].b).toBe("hello");
    expect(result.rows[0].c).toBe(true);
  });

  it("handles empty result sets", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    const result = await conn.query("SELECT 1 AS n WHERE false");
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toHaveLength(0);
  });

  it("supports CREATE TABLE and SELECT in read-write mode", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    await conn.query("CREATE TABLE test (id INTEGER, name VARCHAR)");
    await conn.query("INSERT INTO test VALUES (1, 'alice'), (2, 'bob')");
    const result = await conn.query("SELECT * FROM test ORDER BY id");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("alice");
    expect(result.rows[1].name).toBe("bob");
  });

  it("supports VALUES clause for inline data", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    const result = await conn.query(
      "SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, letter)"
    );
    expect(result.rows).toHaveLength(3);
  });

  it("close is idempotent", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    await conn.query("SELECT 1");
    await conn.close();
    await conn.close(); // Should not throw
    conn = null; // Prevent afterEach from closing again
  });

  it("enforces read-only mode for file-based databases", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-duckdb-ro-"));
    try {
      const dbPath = path.join(tmpDir, "test.duckdb");

      // Create and populate the database first (read-write)
      const rwConn = createDuckDBConnection({ path: dbPath, readOnly: false });
      await rwConn.query("CREATE TABLE test (id INTEGER)");
      await rwConn.query("INSERT INTO test VALUES (1)");
      await rwConn.close();

      // Open in read-only mode (default for file-based)
      conn = createDuckDBConnection({ path: dbPath });
      const result = await conn.query("SELECT * FROM test");
      expect(result.rows).toHaveLength(1);

      // Write operations should fail
      expect(conn.query("INSERT INTO test VALUES (2)")).rejects.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects timeoutMs parameter", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    // A very short timeout on a query that takes some time
    await expect(
      conn.query("SELECT COUNT(*) FROM generate_series(1, 100000000)", 1)
    ).rejects.toThrow("timed out");
  });

  it("can recover after close by re-initializing", async () => {
    conn = createDuckDBConnection({ path: ":memory:", readOnly: false });
    await conn.query("SELECT 1");
    await conn.close();
    // After close + retry, lazy init should re-create the connection
    const result = await conn.query("SELECT 42 AS answer");
    expect(result.rows[0].answer).toBe(42);
  });
});
