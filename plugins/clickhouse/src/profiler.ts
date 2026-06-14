/**
 * ClickHouse profiler — the introspection half of the datasource contract
 * (ADR-0017). Enumerates objects (`listClickHouseObjects`) and profiles columns
 * + sample values (`profileClickHouse`) into the SDK's structural `ProfilingResult`
 * mirror, which the host's registry-resolved profiler seam feeds into
 * `SemanticGenerator` without importing this package.
 *
 * Logic moved from the CLI's `packages/cli/lib/profilers/clickhouse.ts` so the
 * plugin package is the single home for ClickHouse introspection. It runs every
 * query through {@link createClickHouseConnection}, whose `query()` enforces
 * `readonly: 1` and a per-statement timeout — so profiling honors the same
 * read-only posture as the query path and never mutates the cluster.
 */

import type {
  PluginDatabaseObject,
  PluginColumnProfile,
  PluginTableProfile,
  PluginProfileError,
  PluginProfilingResult,
  PluginListObjectsOptions,
  PluginProfileOptions,
} from "@useatlas/plugin-sdk";
import { createClickHouseConnection } from "./connection";

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

/** Escape a ClickHouse identifier with backticks (doubles any embedded backticks). */
function chIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Single-quote escape for a ClickHouse string literal. */
function chLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const LIST_OBJECTS_SQL = `SELECT name, engine FROM system.tables
   WHERE database = currentDatabase()
     AND engine NOT IN ('System', 'MaterializedView')
   ORDER BY name`;

function rowToObject(r: { name: string; engine: string }): PluginDatabaseObject {
  return { name: r.name, type: r.engine === "View" ? "view" : "table" };
}

/**
 * Enumerate the queryable tables/views in the ClickHouse database. Excludes the
 * `System` engine and materialized-view shells (the data lands in the backing
 * table, profiled separately).
 */
export async function listClickHouseObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const conn = createClickHouseConnection({ url: options.url, database: options.schema });
  try {
    const { rows } = await conn.query(LIST_OBJECTS_SQL);
    return (rows as { name: string; engine: string }[]).map(rowToObject);
  } finally {
    await conn.close();
  }
}

/**
 * Profile the ClickHouse database into a {@link PluginProfilingResult}. For each
 * object: row count, primary-key (sorting-key) columns, column types/comments,
 * per-column null/unique counts, and enum-like sample values. ClickHouse has no
 * foreign keys (OLAP, no referential integrity), so FK fields are always empty.
 */
export async function profileClickHouse(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const { url, schema, selectedTables, prefetchedObjects, progress } = options;
  const conn = createClickHouseConnection({ url, database: schema });

  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    const allObjects: PluginDatabaseObject[] = prefetchedObjects
      ? prefetchedObjects
      : ((await conn.query(LIST_OBJECTS_SQL)).rows as { name: string; engine: string }[]).map(
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
        const countRows = (await conn.query(
          `SELECT count() AS c FROM ${chIdentifier(tableName)}`,
        )).rows as { c: string | number }[];
        const rowCount = Number(countRows[0]?.c ?? 0);

        // ClickHouse "primary keys" are sorting keys, not uniqueness constraints —
        // surfaced as PK hints for the generator. No FKs in ClickHouse.
        let primaryKeyColumns: string[] = [];
        if (objectType === "table") {
          try {
            const pkRows = (await conn.query(
              `SELECT name FROM system.columns
               WHERE database = currentDatabase()
                 AND table = '${chLiteral(tableName)}'
                 AND is_in_primary_key = 1
               ORDER BY position`,
            )).rows as { name: string }[];
            primaryKeyColumns = pkRows.map((r) => r.name);
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            // Non-fatal: continue with no PK hints rather than failing the table.
          }
        }

        const colRows = (await conn.query(
          `SELECT name, type, comment FROM system.columns
           WHERE database = currentDatabase() AND table = '${chLiteral(tableName)}'
           ORDER BY position`,
        )).rows as { name: string; type: string; comment: string }[];

        const columns: PluginColumnProfile[] = [];
        for (const col of colRows) {
          let uniqueCount: number | null = null;
          let nullCount: number | null = null;
          let sampleValues: string[] = [];
          let isEnumLike = false;
          const isPK = primaryKeyColumns.includes(col.name);

          try {
            const uqRows = (await conn.query(
              `SELECT uniqExact(${chIdentifier(col.name)}) AS c FROM ${chIdentifier(tableName)}`,
            )).rows as { c: string | number }[];
            uniqueCount = Number(uqRows[0]?.c ?? 0);

            const ncRows = (await conn.query(
              `SELECT count() AS c FROM ${chIdentifier(tableName)} WHERE ${chIdentifier(col.name)} IS NULL`,
            )).rows as { c: string | number }[];
            nullCount = Number(ncRows[0]?.c ?? 0);

            // Enum-like detection for String / LowCardinality(String) / Enum columns.
            const baseType = col.type
              .replace(/Nullable\((.+)\)/, "$1")
              .replace(/LowCardinality\((.+)\)/, "$1");
            const isTextType =
              baseType === "String" ||
              baseType.startsWith("FixedString") ||
              baseType.startsWith("Enum");
            isEnumLike =
              isTextType &&
              uniqueCount !== null &&
              uniqueCount < 20 &&
              rowCount > 0 &&
              uniqueCount / rowCount <= 0.05;

            const sampleLimit = isEnumLike ? 100 : 10;
            const svRows = (await conn.query(
              `SELECT DISTINCT ${chIdentifier(col.name)} AS v FROM ${chIdentifier(tableName)} WHERE ${chIdentifier(col.name)} IS NOT NULL ORDER BY v LIMIT ${sampleLimit}`,
            )).rows as { v: unknown }[];
            sampleValues = svRows.map((r) => String(r.v));
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            // Non-fatal: emit the column with the metadata we have.
          }

          columns.push({
            name: col.name,
            type: col.type,
            nullable: col.type.startsWith("Nullable"),
            unique_count: uniqueCount,
            null_count: nullCount,
            sample_values: sampleValues,
            is_primary_key: isPK,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes: col.comment ? [`Column comment: ${col.comment}`] : [],
          });
        }

        profiles.push({
          table_name: tableName,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: primaryKeyColumns,
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
