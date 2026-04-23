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
 * moves them to boot time, or drops them will fail this test.
 *
 * To defeat the "comment out but keep the string" silent-regression class
 * (H1 from PR #1775 review), every pin anchors to the enclosing
 * `await client.query(...)` / `await conn.execute(...)` call — matching
 * the literal SQL inside a comment would still pass a bare `toContain`
 * check, but cannot satisfy the full "await <client>.<call>(<literal>)"
 * shape without actually being executable code.
 *
 * Full end-to-end coverage lives in
 * `packages/api/src/lib/tools/__tests__/sql-audit.test.ts`, which runs
 * against a real container in CI when available.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const connSrc = readFileSync(resolve(__dirname, "../connection.ts"), "utf-8");
const sqlSrc = readFileSync(resolve(__dirname, "../../tools/sql.ts"), "utf-8");

describe("runtime guards — PostgreSQL driver (anchored to executable call)", () => {
  it("awaits client.query of `SET statement_timeout = ${timeoutMs}` per query", () => {
    // Anchoring to `await client.query(` ensures a commented-out line
    // (`// await client.query(\`SET statement_timeout...\`)`) would not
    // satisfy the pin — comments would move the `await` out of view.
    expect(connSrc).toMatch(/await\s+client\.query\(`SET statement_timeout = \$\{timeoutMs\}`\)/);
  });

  it("awaits client.query of `SET default_transaction_read_only = on` per query", () => {
    expect(connSrc).toMatch(/await\s+client\.query\("SET default_transaction_read_only = on"\)/);
  });

  it("applies both guards BEFORE the user query (ordering)", () => {
    // Uses the literal anchored forms so that moving either guard into a
    // commented block also breaks this ordering check (since indexOf on a
    // block-comment match still returns a valid byte offset, the *executable*
    // anchor above is the primary defense — this test is the secondary pin).
    const tIdx = connSrc.indexOf("await client.query(`SET statement_timeout");
    const roIdx = connSrc.indexOf('await client.query("SET default_transaction_read_only');
    const userQueryIdx = connSrc.indexOf("const result = await client.query(sql);");
    expect(tIdx).toBeGreaterThan(-1);
    expect(roIdx).toBeGreaterThan(-1);
    expect(userQueryIdx).toBeGreaterThan(-1);
    expect(tIdx).toBeLessThan(userQueryIdx);
    expect(roIdx).toBeLessThan(userQueryIdx);
  });
});

describe("runtime guards — MySQL driver (anchored to executable call)", () => {
  it("awaits conn.execute of 'SET SESSION TRANSACTION READ ONLY'", () => {
    expect(connSrc).toMatch(/await\s+conn\.execute\('SET SESSION TRANSACTION READ ONLY'\)/);
  });

  it("awaits conn.execute of `SET SESSION MAX_EXECUTION_TIME = ${safeTimeout}`", () => {
    expect(connSrc).toMatch(/await\s+conn\.execute\(`SET SESSION MAX_EXECUTION_TIME = \$\{safeTimeout\}`\)/);
  });

  it("sanitises timeoutMs through Math.floor before interpolation", () => {
    // Prevents NaN / fractional injection in the SET statement. Anchored
    // to the assignment because the Math.floor call is itself the defense —
    // moving it elsewhere (e.g. at the boundary of the driver call) still
    // counts as intact.
    expect(connSrc).toMatch(/Math\.floor\(timeoutMs\)/);
  });
});

describe("runtime guards — validator-layer auto-LIMIT", () => {
  it("appends LIMIT when not already present in the query", () => {
    // Anchored to the actual statement shape in sql.ts so a comment-out
    // cannot satisfy the pin.
    expect(sqlSrc).toMatch(/if \(!customValidator && !\/\\bLIMIT\\b\/i\.test\(querySql\)\) \{\s*querySql \+= ` LIMIT \$\{rowLimit\}`;\s*\}/);
  });

  it("reads row limit from settings cache (hot-reload path) with default 1000", () => {
    expect(sqlSrc).toContain('getSetting("ATLAS_ROW_LIMIT") ?? "1000"');
  });

  it("reads query timeout from settings cache with default 30000ms", () => {
    expect(sqlSrc).toContain('getSetting("ATLAS_QUERY_TIMEOUT") ?? "30000"');
  });
});
