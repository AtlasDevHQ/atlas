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
import { FATAL_ERROR_PATTERN, isFatalConnectionError, ingestIntoDuckDB, profileDuckDB } from "../atlas";

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

  it("does not false-positive on table names containing error substrings", () => {
    // Word boundaries prevent matching partial words like "EPIPE_logs"
    expect(FATAL_ERROR_PATTERN.test("permission denied for relation EPIPE_logs")).toBe(false);
    expect(FATAL_ERROR_PATTERN.test("column ETIMEDOUT_counter not found")).toBe(false);
  });
});

describe("isFatalConnectionError", () => {
  it("detects fatal errors via message", () => {
    expect(isFatalConnectionError(new Error("read ECONNRESET"))).toBe(true);
    expect(isFatalConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
  });

  it("detects fatal errors via error.code", () => {
    const err = new Error("connection lost");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isFatalConnectionError(err)).toBe(true);
  });

  it("detects fatal errors via cause chain", () => {
    const cause = new Error("read ECONNRESET");
    const wrapper = new Error("query failed", { cause });
    expect(isFatalConnectionError(wrapper)).toBe(true);
  });

  it("detects fatal errors via cause.code", () => {
    const cause = new Error("socket closed");
    (cause as NodeJS.ErrnoException).code = "EPIPE";
    const wrapper = new Error("query failed", { cause });
    expect(isFatalConnectionError(wrapper)).toBe(true);
  });

  it("returns false for non-fatal errors", () => {
    expect(isFatalConnectionError(new Error("permission denied"))).toBe(false);
    expect(isFatalConnectionError(new Error("syntax error"))).toBe(false);
  });

  it("handles non-Error values", () => {
    expect(isFatalConnectionError("ECONNRESET")).toBe(true);
    expect(isFatalConnectionError("permission denied")).toBe(false);
    expect(isFatalConnectionError(42)).toBe(false);
  });

  it("MySQL-specific fatal codes are detected alongside generic ones", () => {
    // MySQL profiler uses: PROTOCOL_CONNECTION_LOST | ER_SERVER_SHUTDOWN | ...
    // These are checked separately in the MySQL table-level catch, not via isFatalConnectionError.
    // But the generic codes still work:
    const err = new Error("Connection lost: The server closed the connection. ECONNRESET");
    expect(isFatalConnectionError(err)).toBe(true);
  });

  it("Snowflake-specific fatal codes are numeric and checked separately", () => {
    // Snowflake uses 390100 (auth expired), 390114 (auth invalid), 250001 (connection failure)
    // These are NOT part of FATAL_ERROR_PATTERN — they are checked via /390100|390114|250001/
    // in the Snowflake table-level catch. Verify they don't accidentally match:
    expect(isFatalConnectionError(new Error("SQL error 390100: auth token expired"))).toBe(false);
    // But generic codes still work for Snowflake:
    expect(isFatalConnectionError(new Error("ECONNREFUSED"))).toBe(true);
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
  it("isFatalConnectionError triggers re-throw, non-fatal continues", () => {
    // Simulates the exact pattern used in all 6 profilers' column-level catches:
    //
    //   } catch (colErr) {
    //     if (isFatalConnectionError(colErr)) throw colErr;
    //     console.warn(`Warning: ...`);
    //   }

    const fatalError = new Error("read ECONNRESET");
    const nonFatalError = new Error("permission denied for relation users");

    function columnCatch(err: Error): "warning" | "rethrow" {
      if (isFatalConnectionError(err)) throw err;
      return "warning";
    }

    expect(() => columnCatch(fatalError)).toThrow("ECONNRESET");
    expect(columnCatch(nonFatalError)).toBe("warning");
  });

  it("fatal errors via .code also trigger re-throw", () => {
    const err = new Error("connection lost");
    (err as NodeJS.ErrnoException).code = "ECONNREFUSED";

    function columnCatch(e: Error): "warning" | "rethrow" {
      if (isFatalConnectionError(e)) throw e;
      return "warning";
    }

    expect(() => columnCatch(err)).toThrow("connection lost");
  });

  it("wrapped fatal errors propagate via cause chain", () => {
    const original = new Error("read EPIPE");
    const wrapped = new Error("query failed", { cause: original });

    function columnCatch(e: Error): "warning" | "rethrow" {
      if (isFatalConnectionError(e)) throw e;
      return "warning";
    }

    expect(() => columnCatch(wrapped)).toThrow("query failed");
  });

  it("all six fatal error codes trigger the re-throw path", () => {
    const codes = ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT"];

    for (const code of codes) {
      const err = new Error(`connect ${code}: connection lost`);
      expect(() => {
        if (isFatalConnectionError(err)) throw err;
      }).toThrow(code);
    }
  });

  it("table-level catch wraps fatal errors with profiling context", () => {
    const originalError = new Error("read ECONNRESET");
    const tableName = "users";

    try {
      // Simulate column-level re-throw
      throw originalError;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isFatalConnectionError(err)) {
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
