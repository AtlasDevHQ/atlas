/**
 * Snowflake database profiler.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import type {
  DatabaseObject,
  ColumnProfile,
  ForeignKey,
  TableProfile,
  ProfileError,
  ProfilingResult,
} from "@atlas/api/lib/profiler";
import { isFatalConnectionError } from "@atlas/api/lib/profiler";
import type { ProfileProgressCallbacks } from "../../src/progress";
import { snowflakeQuery, createSnowflakePool } from "../test-connection";

export type SnowflakePool = ReturnType<
  typeof import("snowflake-sdk").createPool
>;

export async function listSnowflakeObjects(
  connectionString: string,
): Promise<DatabaseObject[]> {
  const { pool } = await createSnowflakePool(connectionString, 1);

  try {
    const result = await snowflakeQuery(
      pool,
      `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_NAME`,
    );
    return result.rows.map((r) => ({
      name: String(r.TABLE_NAME),
      type:
        String(r.TABLE_TYPE) === "VIEW"
          ? ("view" as const)
          : ("table" as const),
    }));
  } finally {
    await pool.drain().catch((err: unknown) => {
      console.warn(
        `[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    try {
      await pool.clear();
    } catch (err: unknown) {
      console.warn(
        `[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function querySnowflakePrimaryKeys(
  pool: SnowflakePool,
  tableName: string,
  database?: string,
  schema?: string,
): Promise<string[]> {
  // SHOW PRIMARY KEYS returns one row per PK column
  const dbRef = database ? `"${database}".` : "";
  const schemaRef = schema ? `"${schema}".` : "";
  const result = await snowflakeQuery(
    pool,
    `SHOW PRIMARY KEYS IN TABLE ${dbRef}${schemaRef}"${tableName}"`,
  );
  // SHOW PRIMARY KEYS columns vary by Snowflake version; "column_name" is the standard field
  return result.rows
    .map((r) => String(r.column_name ?? r.COLUMN_NAME ?? ""))
    .filter(Boolean);
}

async function querySnowflakeForeignKeys(
  pool: SnowflakePool,
  tableName: string,
  database?: string,
  schema?: string,
): Promise<ForeignKey[]> {
  const dbRef = database ? `"${database}".` : "";
  const schemaRef = schema ? `"${schema}".` : "";
  const result = await snowflakeQuery(
    pool,
    `SHOW IMPORTED KEYS IN TABLE ${dbRef}${schemaRef}"${tableName}"`,
  );
  return result.rows
    .map((r) => ({
      from_column: String(r.fk_column_name ?? r.FK_COLUMN_NAME ?? ""),
      to_table: String(r.pk_table_name ?? r.PK_TABLE_NAME ?? ""),
      to_column: String(r.pk_column_name ?? r.PK_COLUMN_NAME ?? ""),
      source: "constraint" as const,
    }))
    .filter((fk) => fk.from_column && fk.to_table && fk.to_column);
}

/** Map Snowflake data types to semantic layer type names. */
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

export async function profileSnowflake(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
): Promise<ProfilingResult> {
  const { pool, opts } = await createSnowflakePool(connectionString, 3);

  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];
  const escId = (name: string) => name.replace(/"/g, '""');

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      const tablesResult = await snowflakeQuery(
        pool,
        `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
         ORDER BY TABLE_NAME`,
      );
      allObjects = tablesResult.rows.map((r) => ({
        name: String(r.TABLE_NAME),
        type:
          String(r.TABLE_TYPE) === "VIEW"
            ? ("view" as const)
            : ("table" as const),
      }));
    }

    const objectsToProfile = filterTables
      ? allObjects.filter((o) => filterTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const table_name = obj.name;
      const objectType = obj.type;
      const objectLabel = objectType === "view" ? " [view]" : "";
      if (progress) {
        progress.onTableStart(
          table_name + objectLabel,
          i,
          objectsToProfile.length,
        );
      } else {
        console.log(
          `  [${i + 1}/${objectsToProfile.length}] Profiling ${table_name}${objectLabel}...`,
        );
      }

      try {
        let primaryKeyColumns: string[] = [];
        let foreignKeys: ForeignKey[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await querySnowflakePrimaryKeys(
              pool,
              table_name,
              opts.database,
              opts.schema,
            );
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            console.warn(
              `    Warning: Could not read PK constraints for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`,
            );
          }
          try {
            foreignKeys = await querySnowflakeForeignKeys(
              pool,
              table_name,
              opts.database,
              opts.schema,
            );
          } catch (fkErr) {
            if (isFatalConnectionError(fkErr)) throw fkErr;
            console.warn(
              `    Warning: Could not read FK constraints for ${table_name}: ${fkErr instanceof Error ? fkErr.message : String(fkErr)}`,
            );
          }
        }

        const fkLookup = new Map(
          foreignKeys.map((fk) => [fk.from_column, fk]),
        );

        const colResult = await snowflakeQuery(
          pool,
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [table_name],
        );

        const colNames = colResult.rows.map((c) => String(c.COLUMN_NAME));

        // Bulk stats: row count + unique count + null count per column in 1 query
        let rowCount = 0;
        const statsPerCol: { unique: number; nulls: number }[] = [];
        if (colNames.length > 0) {
          try {
            const statsAggregates = colNames.map(
              (name, i) =>
                `COUNT(DISTINCT "${escId(name)}") as "U${i}", COUNT_IF("${escId(name)}" IS NULL) as "N${i}"`,
            );
            const statsQuery = `SELECT COUNT(*) as "RC", ${statsAggregates.join(", ")} FROM "${escId(table_name)}"`;
            const statsResult = await snowflakeQuery(pool, statsQuery);
            const stats = statsResult.rows[0] ?? {};
            rowCount = parseInt(String(stats.RC ?? "0"), 10);
            for (let i = 0; i < colNames.length; i++) {
              statsPerCol.push({
                unique: parseInt(String(stats[`U${i}`] ?? "0"), 10),
                nulls: parseInt(String(stats[`N${i}`] ?? "0"), 10),
              });
            }
          } catch (bulkErr) {
            if (isFatalConnectionError(bulkErr)) throw bulkErr;
            console.warn(
              `    Warning: Bulk stats query failed for ${table_name}, falling back to row count only: ${bulkErr instanceof Error ? bulkErr.message : String(bulkErr)}`,
            );
            try {
              const countResult = await snowflakeQuery(
                pool,
                `SELECT COUNT(*) as "RC" FROM "${escId(table_name)}"`,
              );
              rowCount = parseInt(
                String(countResult.rows[0]?.RC ?? "0"),
                10,
              );
            } catch (countErr) {
              if (isFatalConnectionError(countErr)) throw countErr;
              console.warn(
                `    Warning: Row count query also failed for ${table_name}: ${countErr instanceof Error ? countErr.message : String(countErr)}`,
              );
            }
          }
        } else {
          try {
            const countResult = await snowflakeQuery(
              pool,
              `SELECT COUNT(*) as "RC" FROM "${escId(table_name)}"`,
            );
            rowCount = parseInt(
              String(countResult.rows[0]?.RC ?? "0"),
              10,
            );
          } catch (countErr) {
            if (isFatalConnectionError(countErr)) throw countErr;
            console.warn(
              `    Warning: Row count query failed for ${table_name}: ${countErr instanceof Error ? countErr.message : String(countErr)}`,
            );
          }
        }

        // Determine enum-like status and sample limits per column
        const colMeta = colNames.map((name, i) => {
          const dataType = String(colResult.rows[i].DATA_TYPE);
          const mappedType = mapSnowflakeType(dataType);
          const uniqueStats = statsPerCol[i];
          const isEnumLike =
            uniqueStats != null &&
            mappedType === "text" &&
            uniqueStats.unique < 20 &&
            rowCount > 0 &&
            uniqueStats.unique / rowCount <= 0.05;
          return {
            name,
            dataType,
            isEnumLike,
            sampleLimit: isEnumLike ? 100 : 10,
          };
        });

        // Batched sample values: 1 UNION ALL query for all columns
        const samplesMap = new Map<string, string[]>();
        if (colMeta.length > 0) {
          const sampleParts = colMeta.map(
            ({ name, sampleLimit }) =>
              `SELECT '${name.replace(/'/g, "''")}' as "CN", CAST("${escId(name)}" AS VARCHAR) as "V" FROM (SELECT DISTINCT "${escId(name)}" FROM "${escId(table_name)}" WHERE "${escId(name)}" IS NOT NULL ORDER BY "${escId(name)}" LIMIT ${sampleLimit})`,
          );
          try {
            const samplesResult = await snowflakeQuery(
              pool,
              sampleParts.join(" UNION ALL "),
            );
            for (const row of samplesResult.rows) {
              const cn = String(row.CN);
              if (!samplesMap.has(cn)) samplesMap.set(cn, []);
              samplesMap.get(cn)!.push(String(row.V));
            }
          } catch (sampleErr) {
            if (isFatalConnectionError(sampleErr)) throw sampleErr;
            console.warn(
              `    Warning: Batched sample values query failed for ${table_name} (${colMeta.length} columns affected): ${sampleErr instanceof Error ? sampleErr.message : String(sampleErr)}`,
            );
          }
        }

        // Build ColumnProfile[] from parsed data
        const columns: ColumnProfile[] = colResult.rows.map((col, i) => {
          const colName = colNames[i];
          const dataType = String(col.DATA_TYPE);
          const isPK = primaryKeyColumns.includes(colName);
          const fkInfo = fkLookup.get(colName);
          return {
            name: colName,
            type: dataType,
            nullable: String(col.IS_NULLABLE) === "YES",
            unique_count: statsPerCol[i]?.unique ?? null,
            null_count: statsPerCol[i]?.nulls ?? null,
            sample_values: samplesMap.get(colName) ?? [],
            is_primary_key: isPK,
            is_foreign_key: !!fkInfo,
            fk_target_table: fkInfo?.to_table ?? null,
            fk_target_column: fkInfo?.to_column ?? null,
            is_enum_like: colMeta[i]?.isEnumLike ?? false,
            profiler_notes: [],
          };
        });

        profiles.push({
          table_name,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: primaryKeyColumns,
          foreign_keys: foreignKeys,
          inferred_foreign_keys: [],
          profiler_notes: [],
          table_flags: {
            possibly_abandoned: false,
            possibly_denormalized: false,
          },
        });
        progress?.onTableDone(table_name, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining tables
        // Snowflake-specific: 390100 = auth token expired, 390114 = auth token invalid, 250001 = connection failure
        if (
          isFatalConnectionError(err) ||
          /390100|390114|250001/.test(msg)
        ) {
          throw new Error(
            `Fatal database error while profiling ${table_name}: ${msg}`,
            { cause: err },
          );
        }
        if (progress) {
          progress.onTableError(table_name, msg, i, objectsToProfile.length);
        } else {
          console.error(
            `  Warning: Failed to profile ${table_name}: ${msg}`,
          );
        }
        errors.push({ table: table_name, error: msg });
        continue;
      }
    }
  } finally {
    await pool.drain().catch((err: unknown) => {
      console.warn(
        `[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    try {
      await pool.clear();
    } catch (err: unknown) {
      console.warn(
        `[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { profiles, errors };
}
