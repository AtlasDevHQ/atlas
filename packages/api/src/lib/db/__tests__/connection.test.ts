/**
 * Tests for detectDBType and resolveDatasourceUrl from connection.ts.
 *
 * sql.test.ts registers a global mock.module for @/lib/db/connection which
 * persists across bun's test runner. To test the real implementation, we
 * import the source file via a cache-busting query string that bypasses the mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";

const modulePath = resolve(__dirname, "../connection.ts");
const mod = await import(`${modulePath}?t=${Date.now()}`);
const detectDBType = mod.detectDBType as (url?: string) => "postgres" | "mysql";
const resolveDatasourceUrl = mod.resolveDatasourceUrl as () => string | undefined;

// Env vars touched by tests — save/restore
const MANAGED_VARS = [
  "ATLAS_DATASOURCE_URL",
  "ATLAS_DEMO_DATA",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const key of MANAGED_VARS) savedEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const key of MANAGED_VARS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
}

describe("resolveDatasourceUrl", () => {
  beforeEach(() => {
    saveEnv();
    for (const key of MANAGED_VARS) delete process.env[key];
  });

  afterEach(restoreEnv);

  it("returns ATLAS_DATASOURCE_URL when set", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://explicit@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://explicit@localhost/db");
  });

  it("returns ATLAS_DATASOURCE_URL even when ATLAS_DEMO_DATA=true", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://explicit@localhost/db";
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL = "postgresql://fallback@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://explicit@localhost/db");
  });

  it("returns DATABASE_URL_UNPOOLED when ATLAS_DEMO_DATA=true and both fallbacks set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://unpooled@localhost/db";
    process.env.DATABASE_URL = "postgresql://pooled@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://unpooled@localhost/db");
  });

  it("returns DATABASE_URL when ATLAS_DEMO_DATA=true and only DATABASE_URL set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL = "postgresql://pooled@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://pooled@localhost/db");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveDatasourceUrl()).toBeUndefined();
  });

  it("returns undefined when ATLAS_DEMO_DATA is not exactly 'true'", () => {
    process.env.ATLAS_DEMO_DATA = "TRUE";
    process.env.DATABASE_URL = "postgresql://fallback@localhost/db";
    expect(resolveDatasourceUrl()).toBeUndefined();
  });

  it("returns undefined when ATLAS_DEMO_DATA=true but no DATABASE_URL vars set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    expect(resolveDatasourceUrl()).toBeUndefined();
  });
});

describe("detectDBType", () => {
  beforeEach(() => {
    saveEnv();
    for (const key of MANAGED_VARS) delete process.env[key];
  });

  afterEach(restoreEnv);

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

  it("throws for non-core adapter URLs with plugin migration hint", () => {
    expect(() => detectDBType("duckdb://:memory:")).toThrow("now a plugin");
    expect(() => detectDBType("clickhouse://localhost:8123/default")).toThrow("now a plugin");
    expect(() => detectDBType("snowflake://user:pass@account/db")).toThrow("now a plugin");
    expect(() => detectDBType("salesforce://user:pass@login.salesforce.com")).toThrow("now a plugin");
  });

  it("suggests correct plugin name for TLS scheme variants", () => {
    expect(() => detectDBType("clickhouses://localhost:8443/default")).toThrow("@atlas/plugin-clickhouse");
  });

  it("includes the detected scheme in the error message", () => {
    expect(() => detectDBType("duckdb://:memory:")).toThrow("duckdb://");
    expect(() => detectDBType("clickhouse://localhost")).toThrow("clickhouse://");
  });

  it("unrecognized URL throws an error", () => {
    expect(() => detectDBType("file:./data/test.db")).toThrow(
      "Unsupported database URL"
    );
  });
});
