/**
 * Snowflake profiler — the introspection half of the datasource contract
 * (ADR-0017). Enumerates objects (`listSnowflakeObjects`) and profiles columns
 * + sample values (`profileSnowflake`) into the SDK's structural
 * `ProfilingResult` mirror, which the host's registry-resolved profiler seam
 * feeds into `SemanticGenerator` without importing this package.
 *
 * Logic relocated from the CLI's `packages/cli/lib/profilers/snowflake.ts` —
 * this plugin package becomes the home the registry resolves and the CLI
 * consumes directly.
 *
 * Read-only posture: Snowflake has no session-level read-only mode (unlike
 * ClickHouse's `readonly: 1`). Every query runs through
 * {@link createSnowflakeConnection}, whose `query()` sets a session statement
 * timeout and stamps `QUERY_TAG = 'atlas:readonly'`; the profiler issues only
 * SELECT / `INFORMATION_SCHEMA` / `SHOW` introspection statements and never
 * mutates the warehouse. Defense-in-depth read-only is the connection role's
 * SELECT-only grant (see the plugin's `initialize()` warning). Caught errors
 * are type-narrowed and never echo the connection URL or credentials.
 */

import type {
  PluginDatabaseObject,
  PluginColumnProfile,
  PluginForeignKey,
  PluginTableProfile,
  PluginProfileError,
  PluginProfilingResult,
  PluginListObjectsOptions,
  PluginProfileOptions,
  PluginDBConnection,
} from "@useatlas/plugin-sdk";
import { createSnowflakeConnection, parseSnowflakeURL } from "./connection";

/** Connection-level errors that will fail every remaining table — abort fast. */
const FATAL_ERROR_PATTERN =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b/i;

/**
 * Snowflake-specific fatal session errors: 390100 = auth token expired,
 * 390114 = auth token invalid, 250001 = connection failure. Like the network
 * patterns, these mean the whole profile should abort rather than recording N
 * identical per-table errors.
 */
const FATAL_SNOWFLAKE_ERROR_PATTERN = /390100|390114|250001/;

/**
 * Detect a connection-level (vs. per-table) failure. A fatal error means the
 * whole profile should abort rather than recording N identical per-table errors.
 * Mirrors the host's `isFatalConnectionError` (kept local to avoid importing
 * `@atlas/api` into the plugin package — ADR-0013).
 */
function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    const s = String(err);
    return FATAL_ERROR_PATTERN.test(s) || FATAL_SNOWFLAKE_ERROR_PATTERN.test(s);
  }
  if (
    FATAL_ERROR_PATTERN.test(err.message) ||
    FATAL_SNOWFLAKE_ERROR_PATTERN.test(err.message)
  )
    return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

/** Escape a Snowflake identifier for use inside double quotes (doubles any embedded quotes). */
function escId(name: string): string {
  return name.replace(/"/g, '""');
}

/** Single-quote escape for a Snowflake string literal. */
function escLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const LIST_OBJECTS_SQL = `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
   ORDER BY TABLE_NAME`;

function rowToObject(r: Record<string, unknown>): PluginDatabaseObject {
  return {
    name: String(r.TABLE_NAME),
    type: String(r.TABLE_TYPE) === "VIEW" ? "view" : "table",
  };
}

/** Map Snowflake data types to semantic layer type names (used for enum-like heuristics). */
function mapSnowflakeType(sfType: string): string {
  const upper = sfType.toUpperCase();
  if (
    upper.startsWith("VARCHAR") ||
    upper.startsWith("CHAR") ||
    upper === "STRING" ||
    upper === "TEXT"
  )
    return "text";
  if (
    upper === "NUMBER" ||
    upper.startsWith("DECIMAL") ||
    upper.startsWith("NUMERIC")
  )
    return "numeric";
  if (
    upper === "INT" ||
    upper === "INTEGER" ||
    upper === "BIGINT" ||
    upper === "SMALLINT" ||
    upper === "TINYINT" ||
    upper === "BYTEINT"
  )
    return "integer";
  if (
    upper === "FLOAT" ||
    upper === "FLOAT4" ||
    upper === "FLOAT8" ||
    upper === "DOUBLE" ||
    upper.startsWith("DOUBLE") ||
    upper === "REAL"
  )
    return "real";
  if (upper === "BOOLEAN") return "boolean";
  if (upper === "DATE") return "date";
  if (upper.startsWith("TIMESTAMP") || upper === "DATETIME") return "date";
  if (upper === "TIME") return "text";
  if (upper === "VARIANT" || upper === "OBJECT" || upper === "ARRAY")
    return "text";
  if (upper === "BINARY" || upper === "VARBINARY") return "text";
  if (upper === "GEOGRAPHY" || upper === "GEOMETRY") return "text";
  return "text";
}

/**
 * Enumerate the queryable tables/views in the current Snowflake schema. Restricts
 * to `BASE TABLE` / `VIEW` object types in `CURRENT_SCHEMA()`.
 */
export async function listSnowflakeObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const conn = createSnowflakeConnection({ url: options.url, maxConnections: 1 });
  try {
    const { rows } = await conn.query(LIST_OBJECTS_SQL);
    return rows.map(rowToObject);
  } finally {
    await conn.close();
  }
}

/** Read primary-key columns for a table via `SHOW PRIMARY KEYS`. */
async function querySnowflakePrimaryKeys(
  conn: PluginDBConnection,
  tableName: string,
  database?: string,
  schema?: string,
): Promise<string[]> {
  const dbRef = database ? `"${escId(database)}".` : "";
  const schemaRef = schema ? `"${escId(schema)}".` : "";
  const { rows } = await conn.query(
    `SHOW PRIMARY KEYS IN TABLE ${dbRef}${schemaRef}"${escId(tableName)}"`,
  );
  // SHOW PRIMARY KEYS columns vary by Snowflake version; "column_name" is standard.
  return rows
    .map((r) => String(r.column_name ?? r.COLUMN_NAME ?? ""))
    .filter(Boolean);
}

/** Read foreign-key constraints for a table via `SHOW IMPORTED KEYS`. */
async function querySnowflakeForeignKeys(
  conn: PluginDBConnection,
  tableName: string,
  database?: string,
  schema?: string,
): Promise<PluginForeignKey[]> {
  const dbRef = database ? `"${escId(database)}".` : "";
  const schemaRef = schema ? `"${escId(schema)}".` : "";
  const { rows } = await conn.query(
    `SHOW IMPORTED KEYS IN TABLE ${dbRef}${schemaRef}"${escId(tableName)}"`,
  );
  return rows
    .map((r) => ({
      from_column: String(r.fk_column_name ?? r.FK_COLUMN_NAME ?? ""),
      to_table: String(r.pk_table_name ?? r.PK_TABLE_NAME ?? ""),
      to_column: String(r.pk_column_name ?? r.PK_COLUMN_NAME ?? ""),
      source: "constraint" as const,
    }))
    .filter((fk) => fk.from_column && fk.to_table && fk.to_column);
}

/**
 * Profile the Snowflake schema into a {@link PluginProfilingResult}. For each
 * object: row count, primary/foreign keys, column types, per-column null/unique
 * counts (one bulk aggregate query), and enum-like sample values (one batched
 * `UNION ALL` query). Per-table failures below the fatal threshold are recorded
 * in `errors` rather than thrown.
 */
export async function profileSnowflake(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const { url, selectedTables, prefetchedObjects, progress } = options;
  const conn = createSnowflakeConnection({ url, maxConnections: 3 });
  // Resolve the schema/database context for SHOW … IN TABLE qualification, parsed
  // from the URL (never logged) — same source the connection factory uses.
  const opts = parseSnowflakeURL(url);

  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    const allObjects: PluginDatabaseObject[] = prefetchedObjects
      ? prefetchedObjects
      : (await conn.query(LIST_OBJECTS_SQL)).rows.map(rowToObject);

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
        let primaryKeyColumns: string[] = [];
        let foreignKeys: PluginForeignKey[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await querySnowflakePrimaryKeys(
              conn,
              tableName,
              opts.database,
              opts.schema,
            );
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            // Non-fatal: continue with no PK hints rather than failing the table.
          }
          try {
            foreignKeys = await querySnowflakeForeignKeys(
              conn,
              tableName,
              opts.database,
              opts.schema,
            );
          } catch (fkErr) {
            if (isFatalConnectionError(fkErr)) throw fkErr;
            // Non-fatal: continue with no FK metadata.
          }
        }

        const fkLookup = new Map(foreignKeys.map((fk) => [fk.from_column, fk]));

        const colResult = await conn.query(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_NAME = '${escLiteral(tableName)}'
           ORDER BY ORDINAL_POSITION`,
        );

        const colNames = colResult.rows.map((c) => String(c.COLUMN_NAME));

        // Bulk stats: row count + unique count + null count per column in one query.
        let rowCount = 0;
        const statsPerCol: { unique: number; nulls: number }[] = [];
        if (colNames.length > 0) {
          try {
            const statsAggregates = colNames.map(
              (name, idx) =>
                `COUNT(DISTINCT "${escId(name)}") as "U${idx}", COUNT_IF("${escId(name)}" IS NULL) as "N${idx}"`,
            );
            const statsQuery = `SELECT COUNT(*) as "RC", ${statsAggregates.join(", ")} FROM "${escId(tableName)}"`;
            const statsResult = await conn.query(statsQuery);
            const stats = statsResult.rows[0] ?? {};
            rowCount = parseInt(String(stats.RC ?? "0"), 10);
            for (let idx = 0; idx < colNames.length; idx++) {
              statsPerCol.push({
                unique: parseInt(String(stats[`U${idx}`] ?? "0"), 10),
                nulls: parseInt(String(stats[`N${idx}`] ?? "0"), 10),
              });
            }
          } catch (bulkErr) {
            if (isFatalConnectionError(bulkErr)) throw bulkErr;
            // Non-fatal: fall back to a bare row count.
            try {
              const countResult = await conn.query(
                `SELECT COUNT(*) as "RC" FROM "${escId(tableName)}"`,
              );
              rowCount = parseInt(String(countResult.rows[0]?.RC ?? "0"), 10);
            } catch (countErr) {
              if (isFatalConnectionError(countErr)) throw countErr;
              // Non-fatal: leave rowCount at 0.
            }
          }
        } else {
          try {
            const countResult = await conn.query(
              `SELECT COUNT(*) as "RC" FROM "${escId(tableName)}"`,
            );
            rowCount = parseInt(String(countResult.rows[0]?.RC ?? "0"), 10);
          } catch (countErr) {
            if (isFatalConnectionError(countErr)) throw countErr;
            // Non-fatal: leave rowCount at 0.
          }
        }

        // Determine enum-like status and per-column sample limits.
        const colMeta = colNames.map((name, idx) => {
          const dataType = String(colResult.rows[idx].DATA_TYPE);
          const mappedType = mapSnowflakeType(dataType);
          const uniqueStats = statsPerCol[idx];
          const isEnumLike =
            uniqueStats != null &&
            mappedType === "text" &&
            uniqueStats.unique < 20 &&
            rowCount > 0 &&
            uniqueStats.unique / rowCount <= 0.05;
          return { name, dataType, isEnumLike, sampleLimit: isEnumLike ? 100 : 10 };
        });

        // Batched sample values: one UNION ALL query for all columns.
        const samplesMap = new Map<string, string[]>();
        if (colMeta.length > 0) {
          const sampleParts = colMeta.map(
            ({ name, sampleLimit }) =>
              `SELECT '${escLiteral(name)}' as "CN", CAST("${escId(name)}" AS VARCHAR) as "V" FROM (SELECT DISTINCT "${escId(name)}" FROM "${escId(tableName)}" WHERE "${escId(name)}" IS NOT NULL ORDER BY "${escId(name)}" LIMIT ${sampleLimit})`,
          );
          try {
            const samplesResult = await conn.query(sampleParts.join(" UNION ALL "));
            for (const row of samplesResult.rows) {
              const cn = String(row.CN);
              const bucket = samplesMap.get(cn) ?? [];
              bucket.push(String(row.V));
              samplesMap.set(cn, bucket);
            }
          } catch (sampleErr) {
            if (isFatalConnectionError(sampleErr)) throw sampleErr;
            // Non-fatal: emit columns without sample values.
          }
        }

        const columns: PluginColumnProfile[] = colResult.rows.map((col, idx) => {
          const colName = colNames[idx];
          const dataType = String(col.DATA_TYPE);
          const isPK = primaryKeyColumns.includes(colName);
          const fkInfo = fkLookup.get(colName);
          return {
            name: colName,
            type: dataType,
            nullable: String(col.IS_NULLABLE) === "YES",
            unique_count: statsPerCol[idx]?.unique ?? null,
            null_count: statsPerCol[idx]?.nulls ?? null,
            sample_values: samplesMap.get(colName) ?? [],
            is_primary_key: isPK,
            is_foreign_key: !!fkInfo,
            fk_target_table: fkInfo?.to_table ?? null,
            fk_target_column: fkInfo?.to_column ?? null,
            is_enum_like: colMeta[idx]?.isEnumLike ?? false,
            profiler_notes: [],
          };
        });

        profiles.push({
          table_name: tableName,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: primaryKeyColumns,
          foreign_keys: foreignKeys,
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
