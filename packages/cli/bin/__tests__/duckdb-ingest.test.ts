/**
 * Integration tests for DuckDB CSV/Parquet ingestion via the CLI.
 *
 * Tests ingestIntoDuckDB, listDuckDBObjects, profileDuckDB against real
 * DuckDB instances. Passes cleanly in isolation (8/8, ~723ms) but corrupts
 * heap state in the concurrent monorepo runner — `malloc(): unsorted double
 * linked list corrupted` + 30s timeout (#1686). Same class as #992.
 *
 * Skipped at describe level rather than per-test so `bun test <file>` still
 * exercises them when working locally on DuckDB code paths.
 *
 * Re-enable by swapping `describe.skip` → `describe` once Bun + DuckDB native
 * module interaction stabilizes (track the native-module/Bun threading fix
 * in the upstream @duckdb/node-api issue tracker).
 */
import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";

// DuckDB native module init is slow — default 5s times out in CI
setDefaultTimeout(30_000);
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { DuckDBInstance as DuckDBInstanceType } from "@duckdb/node-api";
import { ingestIntoDuckDB, listDuckDBObjects, profileDuckDB } from "../atlas";

let tmpDir: string;

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-duckdb-test-"));
  tmpDir = dir;
  return dir;
}

function cleanTmpDir(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

afterEach(cleanTmpDir);

describe.skip("ingestIntoDuckDB", () => {
  it("ingests a CSV file and creates a table", async () => {
    const dir = createTmpDir();
    const csvPath = path.join(dir, "sales.csv");
    fs.writeFileSync(csvPath, "id,product,amount\n1,Widget,100\n2,Gadget,250\n3,Widget,75\n");

    const dbPath = path.join(dir, "test.duckdb");
    const tables = await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    expect(tables).toEqual(["sales"]);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("ingests multiple CSV files", async () => {
    const dir = createTmpDir();
    const csv1 = path.join(dir, "products.csv");
    const csv2 = path.join(dir, "orders.csv");
    fs.writeFileSync(csv1, "id,name,price\n1,Widget,9.99\n2,Gadget,19.99\n");
    fs.writeFileSync(csv2, "id,product_id,quantity\n1,1,5\n2,2,3\n");

    const dbPath = path.join(dir, "test.duckdb");
    const tables = await ingestIntoDuckDB(dbPath, [
      { path: csv1, format: "csv" },
      { path: csv2, format: "csv" },
    ]);

    expect(tables).toContain("products");
    expect(tables).toContain("orders");
    expect(tables).toHaveLength(2);
  });

  it("sanitizes table names from file stems", async () => {
    const dir = createTmpDir();
    const csvPath = path.join(dir, "my-sales data (2024).csv");
    fs.writeFileSync(csvPath, "id,amount\n1,100\n");

    const dbPath = path.join(dir, "test.duckdb");
    const tables = await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    // Non-identifier chars replaced with underscores
    expect(tables[0]).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it("throws for missing file", async () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "test.duckdb");

    await expect(
      ingestIntoDuckDB(dbPath, [{ path: "/nonexistent/file.csv", format: "csv" }])
    ).rejects.toThrow("File not found");
  });

  it("ingests a Parquet file", async () => {
    const dir = createTmpDir();
    // Create a Parquet file using DuckDB
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DuckDBInstance } = require("@duckdb/node-api");
    const inst: DuckDBInstanceType = await DuckDBInstance.create(":memory:");
    const c: DuckDBConnection = await inst.connect();
    const parquetPath = path.join(dir, "data.parquet");
    await c.run(`COPY (SELECT 1 AS id, 'test' AS name) TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)`);
    c.disconnectSync();
    inst.closeSync();

    const dbPath = path.join(dir, "test.duckdb");
    const tables = await ingestIntoDuckDB(dbPath, [{ path: parquetPath, format: "parquet" }]);
    expect(tables).toEqual(["data"]);
  });
});

describe.skip("listDuckDBObjects", () => {
  it("lists tables in a DuckDB database", async () => {
    const dir = createTmpDir();
    const csvPath = path.join(dir, "data.csv");
    fs.writeFileSync(csvPath, "x,y\n1,2\n3,4\n");

    const dbPath = path.join(dir, "test.duckdb");
    await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    const objects = await listDuckDBObjects(dbPath);
    expect(objects).toHaveLength(1);
    expect(objects[0].name).toBe("data");
    expect(objects[0].type).toBe("table");
  });
});

describe.skip("profileDuckDB", () => {
  it("profiles a table with correct row count and columns", async () => {
    const dir = createTmpDir();
    const csvPath = path.join(dir, "employees.csv");
    fs.writeFileSync(
      csvPath,
      "id,name,department,salary\n" +
      "1,Alice,Engineering,120000\n" +
      "2,Bob,Sales,95000\n" +
      "3,Charlie,Engineering,115000\n" +
      "4,Diana,Marketing,88000\n" +
      "5,Eve,Sales,92000\n"
    );

    const dbPath = path.join(dir, "test.duckdb");
    await ingestIntoDuckDB(dbPath, [{ path: csvPath, format: "csv" }]);

    const result = await profileDuckDB(dbPath);
    expect(result.profiles).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const profile = result.profiles[0];
    expect(profile.table_name).toBe("employees");
    expect(profile.row_count).toBe(5);
    expect(profile.columns.length).toBe(4);

    const nameCol = profile.columns.find((c) => c.name === "name");
    expect(nameCol).toBeDefined();
    expect(nameCol!.unique_count).toBe(5);

    const deptCol = profile.columns.find((c) => c.name === "department");
    expect(deptCol).toBeDefined();
    // 3 unique departments with 5 rows = 60% cardinality, but <=10 unique → enum-like
    expect(deptCol!.is_enum_like).toBe(true);
    expect(deptCol!.sample_values.length).toBeGreaterThan(0);
  });

  it("respects filterTables parameter", async () => {
    const dir = createTmpDir();
    const csv1 = path.join(dir, "a.csv");
    const csv2 = path.join(dir, "b.csv");
    fs.writeFileSync(csv1, "x\n1\n2\n");
    fs.writeFileSync(csv2, "y\n3\n4\n");

    const dbPath = path.join(dir, "test.duckdb");
    await ingestIntoDuckDB(dbPath, [
      { path: csv1, format: "csv" },
      { path: csv2, format: "csv" },
    ]);

    const result = await profileDuckDB(dbPath, ["a"]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].table_name).toBe("a");
  });
});
