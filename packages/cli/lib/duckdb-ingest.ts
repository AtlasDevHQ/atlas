/**
 * DuckDB CSV/Parquet ingestion for `atlas init --csv` / `--parquet`.
 *
 * This is a CLI-only WRITE path (it creates tables from local files), distinct
 * from profiling — which is the DuckDB plugin's job (`plugins/duckdb/src/profiler`,
 * the one profiler home the CLI consumes after ingestion). Relocated out of the
 * deleted `lib/profilers/duckdb.ts` so the CLI keeps no parallel profiler home.
 */

import * as fs from "fs";
import * as path from "path";
import { loadDuckDB } from "./test-connection";

/**
 * Ingest CSV/Parquet files into a DuckDB database file.
 *
 * Each file becomes a table named after the file stem (e.g. `sales.csv` → `sales`).
 * Returns the list of created table names.
 */
export async function ingestIntoDuckDB(
  dbPath: string,
  files: { path: string; format: "csv" | "parquet" }[],
): Promise<string[]> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const tableNames: string[] = [];
  const usedNames = new Set<string>();

  try {
    for (const file of files) {
      const absPath = path.resolve(file.path);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${absPath}`);
      }
      // Table name from file stem (lowercase, replace non-identifier chars with _)
      const stem = path
        .basename(absPath, path.extname(absPath))
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^(\d)/, "_$1"); // prefix digit-leading names

      if (usedNames.has(stem)) {
        throw new Error(
          `Table name collision: multiple files map to "${stem}". Rename files or pass one at a time.`,
        );
      }
      usedNames.add(stem);

      const readFn =
        file.format === "csv"
          ? `read_csv_auto('${absPath.replace(/'/g, "''")}')`
          : `read_parquet('${absPath.replace(/'/g, "''")}')`;

      await conn.run(`CREATE TABLE "${stem}" AS SELECT * FROM ${readFn}`);
      tableNames.push(stem);
      console.log(
        `  Loaded ${file.format.toUpperCase()} → table "${stem}" from ${file.path}`,
      );
    }
    return tableNames;
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    conn.disconnectSync();
    instance.closeSync();
  }
}
