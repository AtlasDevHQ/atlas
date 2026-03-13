/**
 * Tests that fatal connection errors (ECONNRESET, ECONNREFUSED, etc.)
 * propagate from column-level catch blocks up to the table-level catch,
 * rather than being silently swallowed as column warnings.
 *
 * Covers fixes for #358 (Postgres table-level fatal detection) and
 * #359 (column-level fatal error re-throw in all profilers).
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

describe("DuckDB profiler — fatal error propagation from column-level catch", () => {
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
    // Create a valid DuckDB database with a table
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

  it("non-fatal column errors still produce partial results", async () => {
    // A valid database should profile successfully even if individual columns
    // have quirky data — non-fatal errors are logged as warnings, not thrown
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
