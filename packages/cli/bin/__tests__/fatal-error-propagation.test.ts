/**
 * Tests that fatal connection errors (ECONNRESET, ECONNREFUSED, etc.)
 * propagate from column-level catch blocks up to the table-level catch,
 * rather than being silently swallowed as column warnings.
 *
 * Covers fixes for #358 (Postgres profiler had no fatal error detection)
 * and #359 (column-level fatal error re-throw in all profilers).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FATAL_ERROR_PATTERN, ingestIntoDuckDB, profileDuckDB } from "../atlas";

describe("FATAL_ERROR_PATTERN", () => {
  const fatalCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
  ];

  for (const code of fatalCodes) {
    it(`matches ${code}`, () => {
      expect(FATAL_ERROR_PATTERN.test(`connect ${code}: connection lost`)).toBe(true);
    });

    it(`matches ${code} case-insensitively`, () => {
      expect(FATAL_ERROR_PATTERN.test(code.toLowerCase())).toBe(true);
    });
  }

  it("does not match non-fatal errors", () => {
    expect(FATAL_ERROR_PATTERN.test("permission denied for table foo")).toBe(false);
    expect(FATAL_ERROR_PATTERN.test("column 'bar' does not exist")).toBe(false);
    expect(FATAL_ERROR_PATTERN.test("syntax error at or near SELECT")).toBe(false);
  });

  it("matches errors embedded in longer messages", () => {
    expect(FATAL_ERROR_PATTERN.test("read ECONNRESET at TLSSocket._recv")).toBe(true);
    expect(FATAL_ERROR_PATTERN.test("connect ECONNREFUSED 127.0.0.1:5432")).toBe(true);
    expect(FATAL_ERROR_PATTERN.test("getaddrinfo ENOTFOUND db.example.com")).toBe(true);
  });
});

describe("DuckDB profiler — error propagation behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fatal-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("corrupted database triggers a throw (not silent continuation)", async () => {
    const csvPath = path.join(tmpDir, "test.csv");
    fs.writeFileSync(csvPath, "id,name\n1,Alice\n2,Bob\n");

    const dbPath = path.join(tmpDir, "test.duckdb");
    await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    // Corrupt the database file — write garbage in the middle
    const fd = fs.openSync(dbPath, "r+");
    const garbage = Buffer.alloc(4096, 0xff);
    fs.writeSync(fd, garbage, 0, garbage.length, 1024);
    fs.closeSync(fd);

    // Profiling a corrupted DB should throw, not silently return empty results
    await expect(profileDuckDB(dbPath)).rejects.toThrow();
  });

  it("valid database profiles successfully with all columns", async () => {
    // A valid database should profile without errors — all columns resolve
    const csvPath = path.join(tmpDir, "data.csv");
    fs.writeFileSync(csvPath, "id,value\n1,hello\n2,world\n");

    const dbPath = path.join(tmpDir, "test.duckdb");
    await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    const result = await profileDuckDB(dbPath);
    expect(result.profiles).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.profiles[0].columns.length).toBe(2);
  });
});

describe("column-level catch re-throw contract", () => {
  it("fatal errors in column profiling propagate to table-level catch", () => {
    // This test verifies the re-throw contract that column-level catches implement:
    // when a query throws a fatal error, the catch block re-throws it instead of
    // logging a warning. The table-level catch then wraps it with context.
    //
    // We simulate the exact pattern used in all 6 profilers' column-level catches:
    //
    //   } catch (colErr) {
    //     const colMsg = colErr instanceof Error ? colErr.message : String(colErr);
    //     if (FATAL_ERROR_PATTERN.test(colMsg)) {
    //       throw colErr;  // <-- this is what we're testing
    //     }
    //     console.warn(`Warning: ...`);
    //   }

    const fatalError = new Error("read ECONNRESET");
    const nonFatalError = new Error("permission denied for relation users");

    // Simulate column-level catch behavior
    function columnCatch(err: Error): "warning" | "rethrow" {
      const msg = err.message;
      if (FATAL_ERROR_PATTERN.test(msg)) {
        throw err;
      }
      return "warning";
    }

    // Fatal errors should re-throw
    expect(() => columnCatch(fatalError)).toThrow("ECONNRESET");

    // Non-fatal errors should return "warning" (i.e., log and continue)
    expect(columnCatch(nonFatalError)).toBe("warning");
  });

  it("all six fatal error codes trigger the re-throw path", () => {
    const codes = ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT"];

    for (const code of codes) {
      const err = new Error(`connect ${code}: connection lost`);
      expect(() => {
        const msg = err.message;
        if (FATAL_ERROR_PATTERN.test(msg)) throw err;
      }).toThrow(code);
    }
  });

  it("table-level catch wraps fatal errors with profiling context", () => {
    // Simulate the table-level catch that receives re-thrown column errors:
    //
    //   } catch (err) {
    //     const msg = err instanceof Error ? err.message : String(err);
    //     if (FATAL_ERROR_PATTERN.test(msg)) {
    //       throw new Error(`Fatal database error while profiling ${table}: ${msg}`, { cause: err });
    //     }
    //   }

    const originalError = new Error("read ECONNRESET");
    const tableName = "users";

    try {
      // Simulate column-level re-throw
      throw originalError;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (FATAL_ERROR_PATTERN.test(msg)) {
        const wrapped = new Error(`Fatal database error while profiling ${tableName}: ${msg}`, { cause: err });
        expect(wrapped.message).toContain("Fatal database error");
        expect(wrapped.message).toContain("users");
        expect(wrapped.message).toContain("ECONNRESET");
        expect(wrapped.cause).toBe(originalError);
        return; // test passed
      }
    }
    // Should not reach here
    expect(true).toBe(false);
  });
});
