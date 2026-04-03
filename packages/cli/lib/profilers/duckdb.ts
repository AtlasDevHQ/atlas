/**
 * DuckDB profiler — profiles tables in DuckDB databases, with CSV/Parquet ingestion support.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import * as path from "path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type {
  DatabaseObject,
  ColumnProfile,
  TableProfile,
  ProfileError,
  ProfilingResult,
} from "@atlas/api/lib/profiler";
import { isFatalConnectionError } from "@atlas/api/lib/profiler";
import type { ProfileProgressCallbacks } from "../../src/progress";
import { loadDuckDB } from "../test-connection";

/** Helper to run a DuckDB query and return typed rows. */
async function duckdbQuery<T = Record<string, unknown>>(
  conn: DuckDBConnection,
  sql: string,
): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}

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

/** List tables in a DuckDB database. */
export async function listDuckDBObjects(
  dbPath: string,
): Promise<DatabaseObject[]> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath, {
    access_mode: "READ_ONLY",
  });
  const conn = await instance.connect();
  try {
    const rows = await duckdbQuery<{ name: string; type: string }>(
      conn,
      `SELECT table_name as name,
              CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END as type
       FROM information_schema.tables
       WHERE table_schema = 'main'
       ORDER BY table_name`,
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type === "view" ? ("view" as const) : ("table" as const),
    }));
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    conn.disconnectSync();
    instance.closeSync();
  }
}

/** Map DuckDB types to the common type system. */
function mapDuckDBType(duckType: string): string {
  const t = duckType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t === "hugeint" ||
    t === "uhugeint"
  ) {
    return "number";
  }
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp"))
    return "date";
  return "string";
}

/** Profile tables in a DuckDB database. */
export async function profileDuckDB(
  dbPath: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
): Promise<ProfilingResult> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath, {
    access_mode: "READ_ONLY",
  });
  const conn = await instance.connect();
  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      allObjects = await listDuckDBObjects(dbPath);
    }

    const objectsToProfile = filterTables
      ? allObjects.filter((o) => filterTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const tableName = obj.name;
      const objectType = obj.type;
      const objectLabel = objectType === "view" ? " [view]" : "";
      if (progress) {
        progress.onTableStart(
          tableName + objectLabel,
          i,
          objectsToProfile.length,
        );
      } else {
        console.log(
          `  [${i + 1}/${objectsToProfile.length}] Profiling ${tableName}${objectLabel}...`,
        );
      }

      try {
        const countRows = await duckdbQuery<{ c: number | bigint }>(
          conn,
          `SELECT COUNT(*) as c FROM "${tableName}"`,
        );
        const rowCount = Number(countRows[0].c);

        // Get column info
        const colRows = await duckdbQuery<{
          column_name: string;
          data_type: string;
          is_nullable: string;
        }>(
          conn,
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_name = '${tableName.replace(/'/g, "''")}' AND table_schema = 'main'
           ORDER BY ordinal_position`,
        );

        const columns: ColumnProfile[] = [];
        for (const col of colRows) {
          let uniqueCount: number | null = null;
          let nullCount: number | null = null;
          let sampleValues: string[] = [];
          let isEnumLike = false;

          try {
            const stats = await duckdbQuery<{
              u: number | bigint;
              n: number | bigint;
            }>(
              conn,
              `SELECT COUNT(DISTINCT "${col.column_name}") as u, COUNT(*) - COUNT("${col.column_name}") as n FROM "${tableName}"`,
            );
            uniqueCount = Number(stats[0].u);
            nullCount = Number(stats[0].n);

            // Enum-like detection: text columns with <20 unique values and <5% cardinality
            const mappedType = mapDuckDBType(col.data_type);
            if (
              mappedType === "string" &&
              uniqueCount !== null &&
              uniqueCount > 0 &&
              uniqueCount <= 20 &&
              rowCount > 0
            ) {
              const cardinality = uniqueCount / rowCount;
              if (cardinality < 0.05 || uniqueCount <= 10) {
                isEnumLike = true;
                const enumRows = await duckdbQuery<{ v: string }>(
                  conn,
                  `SELECT DISTINCT CAST("${col.column_name}" AS VARCHAR) as v FROM "${tableName}" WHERE "${col.column_name}" IS NOT NULL ORDER BY v LIMIT 20`,
                );
                sampleValues = enumRows.map((r) => String(r.v));
              }
            }

            // Sample values for non-enum columns
            if (!isEnumLike) {
              const sampleRows = await duckdbQuery<{ v: string }>(
                conn,
                `SELECT DISTINCT CAST("${col.column_name}" AS VARCHAR) as v FROM "${tableName}" WHERE "${col.column_name}" IS NOT NULL LIMIT 5`,
              );
              sampleValues = sampleRows.map((r) => String(r.v));
            }
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            console.warn(
              `    Warning: Could not profile column ${tableName}.${col.column_name}: ${colErr instanceof Error ? colErr.message : String(colErr)}`,
            );
          }

          columns.push({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            unique_count: uniqueCount,
            null_count: nullCount,
            sample_values: sampleValues,
            is_primary_key: false, // DuckDB doesn't enforce PKs on loaded data
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes: [],
          });
        }

        profiles.push({
          table_name: tableName,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: [],
          foreign_keys: [],
          inferred_foreign_keys: [],
          profiler_notes: [],
          table_flags: {
            possibly_abandoned: false,
            possibly_denormalized: false,
          },
        });
        progress?.onTableDone(tableName, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining tables
        if (isFatalConnectionError(err)) {
          throw new Error(
            `Fatal database error while profiling ${tableName}: ${msg}`,
            { cause: err },
          );
        }
        if (progress) {
          progress.onTableError(tableName, msg, i, objectsToProfile.length);
        } else {
          console.error(
            `  Warning: Failed to profile ${tableName}: ${msg}`,
          );
        }
        errors.push({ table: tableName, error: msg });
      }
    }
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    conn.disconnectSync();
    instance.closeSync();
  }

  return { profiles, errors };
}
