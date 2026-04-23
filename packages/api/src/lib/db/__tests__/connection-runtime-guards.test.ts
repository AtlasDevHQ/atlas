/**
 * Runtime-guard pin for the PostgreSQL and MySQL drivers.
 *
 * Phase 3 of the 1.2.3 security sweep (issue #1722, tracking #1718). The
 * 4-layer validator is defense-in-depth — the driver layer applies the
 * actual enforcement for statement timeout and read-only session.
 *
 * This test pins the exact SET commands the driver issues on each query.
 * Source-level grep, not a behavioral test: the pg module is loaded via
 * `require("pg")` inside the driver factory and cannot be reliably
 * mock-intercepted under the bun test runner's CJS interop. Source pin
 * is sufficient because the guards are short, load-bearing strings that
 * must never be removed — any refactor that gates them behind a flag,
 * moves them to boot time, or drops them will fail this test. Full
 * end-to-end coverage lives in sql-audit.test.ts, which runs against a
 * real container in CI when available.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const connSrc = readFileSync(resolve(__dirname, "../connection.ts"), "utf-8");

describe("runtime guards — PostgreSQL driver", () => {
  it("sets statement_timeout per query with the caller-supplied value", () => {
    expect(connSrc).toMatch(/SET statement_timeout = \$\{timeoutMs\}/);
  });

  it("sets default_transaction_read_only = on per query", () => {
    expect(connSrc).toContain("SET default_transaction_read_only = on");
  });

  it("applies both guards BEFORE the user query", () => {
    // Order check: the SET commands must appear in the source BEFORE the
    // line that executes the user-supplied SQL. A refactor that moved the
    // SET to after `client.query(sql)` would break read-only enforcement.
    const tIdx = connSrc.indexOf("SET statement_timeout");
    const roIdx = connSrc.indexOf("SET default_transaction_read_only");
    const userQueryIdx = connSrc.indexOf("const result = await client.query(sql)");
    expect(tIdx).toBeGreaterThan(-1);
    expect(roIdx).toBeGreaterThan(-1);
    expect(userQueryIdx).toBeGreaterThan(-1);
    expect(tIdx).toBeLessThan(userQueryIdx);
    expect(roIdx).toBeLessThan(userQueryIdx);
  });
});

describe("runtime guards — MySQL driver", () => {
  it("sets SESSION TRANSACTION READ ONLY per query", () => {
    expect(connSrc).toContain("SET SESSION TRANSACTION READ ONLY");
  });

  it("sets MAX_EXECUTION_TIME per query with the caller-supplied value", () => {
    expect(connSrc).toMatch(/SET SESSION MAX_EXECUTION_TIME = \$\{safeTimeout\}/);
  });

  it("uses Math.floor on the timeout value before interpolation", () => {
    // Prevents NaN / fractional injection in the SET statement.
    expect(connSrc).toContain("Math.floor(timeoutMs)");
  });
});

describe("runtime guards — validator-layer auto-LIMIT", () => {
  const sqlSrc = readFileSync(resolve(__dirname, "../../tools/sql.ts"), "utf-8");

  it("appends LIMIT when not already present in the query", () => {
    expect(sqlSrc).toMatch(/if \(!customValidator && !\/\\bLIMIT\\b\/i\.test\(querySql\)\) \{\s*querySql \+= ` LIMIT \$\{rowLimit\}`;/);
  });

  it("reads row limit from settings cache (hot-reload path) with default 1000", () => {
    expect(sqlSrc).toContain('getSetting("ATLAS_ROW_LIMIT") ?? "1000"');
  });

  it("reads query timeout from settings cache with default 30000ms", () => {
    expect(sqlSrc).toContain('getSetting("ATLAS_QUERY_TIMEOUT") ?? "30000"');
  });
});
