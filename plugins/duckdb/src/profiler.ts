/**
 * DuckDB profiler — the introspection half of the datasource contract
 * (ADR-0017). Enumerates objects (`listDuckDBObjects`) and profiles columns
 * + sample values (`profileDuckDB`) into the SDK's structural `ProfilingResult`
 * mirror, which the host's registry-resolved profiler seam feeds into
 * `SemanticGenerator` without importing this package.
 *
 * Logic relocated from the CLI's former `packages/cli/lib/profilers/duckdb.ts`
 * (now deleted, #3672) — this plugin package is the one home the registry
 * resolves and the CLI consumes directly. CSV/Parquet ingestion
 * (`ingestIntoDuckDB`) is a write path and stays in the CLI
 * (`packages/cli/lib/duckdb-ingest.ts`); only the read-only introspection lives here.
 *
 * It runs every query through {@link createDuckDBConnection}, which opens file
 * databases with `access_mode: "READ_ONLY"` — so profiling honors the same
 * read-only posture as the query path and never mutates the database. Errors are
 * type-narrowed and never echo the connection string / file path beyond the
 * table name being profiled.
 */

import type {
  PluginDatabaseObject,
  PluginColumnProfile,
  PluginTableProfile,
  PluginProfileError,
  PluginProfilingResult,
  PluginListObjectsOptions,
  PluginProfileOptions,
  PluginDBConnection,
} from "@useatlas/plugin-sdk";
import { createDuckDBConnection, parseDuckDBUrl } from "./connection";

/** Connection-level errors that will fail every remaining table — abort fast. */
const FATAL_ERROR_PATTERN =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b/i;

/**
 * Detect a connection-level (vs. per-table) failure. A fatal error means the
 * whole profile should abort rather than recording N identical per-table errors.
 * Mirrors the host's `isFatalConnectionError` (kept local to avoid importing
 * `@atlas/api` into the plugin package — ADR-0013).
 */
function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return FATAL_ERROR_PATTERN.test(String(err));
  if (FATAL_ERROR_PATTERN.test(err.message)) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

/** Single-quote escape for a DuckDB string literal. */
function ddLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Escape a DuckDB identifier with double quotes (doubles any embedded quotes). */
function ddIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const LIST_OBJECTS_SQL = `SELECT table_name as name,
        CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END as type
 FROM information_schema.tables
 WHERE table_schema = 'main'
 ORDER BY table_name`;

function rowToObject(r: { name: string; type: string }): PluginDatabaseObject {
  return { name: r.name, type: r.type === "view" ? "view" : "table" };
}

/**
 * Open a read-only DuckDB connection for the given url. File databases are
 * opened with `access_mode: "READ_ONLY"`; `:memory:` cannot be read-only.
 */
function openConnection(url: string): PluginDBConnection {
  const parsed = parseDuckDBUrl(url);
  return createDuckDBConnection({ path: parsed.path, readOnly: parsed.readOnly });
}

/** Map DuckDB types to the common type system for enum-like heuristics. */
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
  if (t.includes("date") || t.includes("time") || t.includes("timestamp")) {
    return "date";
  }
  return "string";
}

/**
 * Enumerate the queryable tables/views in the DuckDB `main` schema.
 */
export async function listDuckDBObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const conn = openConnection(options.url);
  try {
    const { rows } = await conn.query(LIST_OBJECTS_SQL);
    return (rows as { name: string; type: string }[]).map(rowToObject);
  } finally {
    await conn.close();
  }
}

/**
 * Profile the DuckDB database into a {@link PluginProfilingResult}. For each
 * object: row count, column types/nullability, per-column null/unique counts,
 * and enum-like sample values. DuckDB does not enforce primary or foreign keys
 * on loaded data, so PK/FK fields are always empty.
 */
export async function profileDuckDB(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const { url, selectedTables, prefetchedObjects, progress, logger } = options;
  const conn = openConnection(url);

  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    const allObjects: PluginDatabaseObject[] = prefetchedObjects
      ? prefetchedObjects
      : ((await conn.query(LIST_OBJECTS_SQL)).rows as { name: string; type: string }[]).map(
          rowToObject,
        );

    const objectsToProfile = selectedTables
      ? allObjects.filter((o) => selectedTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const tableName = obj.name;
      const objectType = obj.type;
      const objectLabel = objectType === "view" ? " [view]" : "";
      progress?.onTableStart(tableName + objectLabel, i, objectsToProfile.length);

      try {
        const countRows = (
          await conn.query(`SELECT COUNT(*) as c FROM ${ddIdentifier(tableName)}`)
        ).rows as { c: number | bigint }[];
        const rowCount = Number(countRows[0]?.c ?? 0);

        const colRows = (
          await conn.query(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_name = '${ddLiteral(tableName)}' AND table_schema = 'main'
             ORDER BY ordinal_position`,
          )
        ).rows as { column_name: string; data_type: string; is_nullable: string }[];

        const columns: PluginColumnProfile[] = [];
        for (const col of colRows) {
          let uniqueCount: number | null = null;
          let nullCount: number | null = null;
          let sampleValues: string[] = [];
          let isEnumLike = false;
          const colNotes: string[] = [];

          try {
            const stats = (
              await conn.query(
                `SELECT COUNT(DISTINCT ${ddIdentifier(col.column_name)}) as u, COUNT(*) - COUNT(${ddIdentifier(col.column_name)}) as n FROM ${ddIdentifier(tableName)}`,
              )
            ).rows as { u: number | bigint; n: number | bigint }[];
            uniqueCount = Number(stats[0]?.u ?? 0);
            nullCount = Number(stats[0]?.n ?? 0);

            // Enum-like detection: text columns with <=20 unique values and
            // either <5% cardinality or <=10 distinct values.
            const mappedType = mapDuckDBType(col.data_type);
            if (
              mappedType === "string" &&
              uniqueCount > 0 &&
              uniqueCount <= 20 &&
              rowCount > 0
            ) {
              const cardinality = uniqueCount / rowCount;
              if (cardinality < 0.05 || uniqueCount <= 10) {
                isEnumLike = true;
                const enumRows = (
                  await conn.query(
                    `SELECT DISTINCT CAST(${ddIdentifier(col.column_name)} AS VARCHAR) as v FROM ${ddIdentifier(tableName)} WHERE ${ddIdentifier(col.column_name)} IS NOT NULL ORDER BY v LIMIT 20`,
                  )
                ).rows as { v: unknown }[];
                sampleValues = enumRows.map((r) => String(r.v));
              }
            }

            // Sample values for non-enum columns.
            if (!isEnumLike) {
              const sampleRows = (
                await conn.query(
                  `SELECT DISTINCT CAST(${ddIdentifier(col.column_name)} AS VARCHAR) as v FROM ${ddIdentifier(tableName)} WHERE ${ddIdentifier(col.column_name)} IS NOT NULL LIMIT 5`,
                )
              ).rows as { v: unknown }[];
              sampleValues = sampleRows.map((r) => String(r.v));
            }
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            // Non-fatal: emit the column with the metadata we have, but signal
            // that its stats/samples are missing rather than dropping silently.
            const msg = colErr instanceof Error ? colErr.message : String(colErr);
            logger?.warn(
              { table: tableName, column: col.column_name, err: msg },
              "DuckDB: could not compute column statistics",
            );
            colNotes.push("Column statistics unavailable (introspection query failed).");
          }

          columns.push({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            unique_count: uniqueCount,
            null_count: nullCount,
            sample_values: sampleValues,
            is_primary_key: false, // DuckDB doesn't enforce PKs on loaded data.
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes: colNotes,
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
          table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        });
        progress?.onTableDone(tableName, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isFatalConnectionError(err)) {
          // Connection-level — every remaining table will fail the same way.
          throw new Error(`Fatal database error while profiling ${tableName}: ${msg}`, {
            cause: err,
          });
        }
        progress?.onTableError(tableName, msg, i, objectsToProfile.length);
        errors.push({ table: tableName, error: msg });
      }
    }
  } finally {
    await conn.close();
  }

  return { profiles, errors };
}
