/**
 * Tests for detectDBType from connection.ts.
 *
 * sql.test.ts registers a global mock.module for @/lib/db/connection which
 * persists across bun's test runner. To test the real implementation, we
 * import the source file via a cache-busting query string that bypasses the mock.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { resolve } from "path";

const modulePath = resolve(__dirname, "../connection.ts");
const mod = await import(`${modulePath}?t=${Date.now()}`);
const detectDBType = mod.detectDBType as (url?: string) => "postgres" | "mysql" | "duckdb";

describe("detectDBType", () => {
  const origDatabaseUrl = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    if (origDatabaseUrl !== undefined) {
      process.env.ATLAS_DATASOURCE_URL = origDatabaseUrl;
    } else {
      delete process.env.ATLAS_DATASOURCE_URL;
    }
  });

  it("detects postgresql:// as postgres", () => {
    expect(detectDBType("postgresql://user:pass@localhost:5432/db")).toBe("postgres");
  });

  it("detects postgres:// as postgres", () => {
    expect(detectDBType("postgres://user:pass@localhost:5432/db")).toBe("postgres");
  });

  it("detects mysql:// as mysql", () => {
    expect(detectDBType("mysql://user:pass@localhost:3306/db")).toBe("mysql");
  });

  it("detects mysql2:// as mysql", () => {
    expect(detectDBType("mysql2://user:pass@localhost:3306/db")).toBe("mysql");
  });

  it("uses ATLAS_DATASOURCE_URL env var when no argument provided", () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://test@localhost/db";
    expect(detectDBType()).toBe("mysql");
  });

  it("throws when ATLAS_DATASOURCE_URL is unset and no argument provided", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    expect(() => detectDBType()).toThrow("No database URL provided");
  });

  it("throws for empty string argument", () => {
    expect(() => detectDBType("")).toThrow("No database URL provided");
  });

  it("detects duckdb:// as duckdb", () => {
    expect(detectDBType("duckdb://:memory:")).toBe("duckdb");
  });

  it("detects duckdb://path as duckdb", () => {
    expect(detectDBType("duckdb:///tmp/test.duckdb")).toBe("duckdb");
  });

  it("unrecognized URL throws an error", () => {
    expect(() => detectDBType("file:./data/test.db")).toThrow(
      "Unsupported database URL"
    );
  });
});
