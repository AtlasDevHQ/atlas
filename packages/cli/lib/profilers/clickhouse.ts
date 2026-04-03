/**
 * ClickHouse database profiler.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import type {
  DatabaseObject,
  ColumnProfile,
  TableProfile,
  ProfileError,
  ProfilingResult,
} from "@atlas/api/lib/profiler";
import { isFatalConnectionError } from "@atlas/api/lib/profiler";
import type { ProfileProgressCallbacks } from "../../src/progress";
import { rewriteClickHouseUrl, clickhouseQuery } from "../test-connection";

export type ClickHouseClient = {
  query: (opts: {
    query: string;
    format: string;
  }) => Promise<{ json: () => Promise<{ data: Record<string, unknown>[] }> }>;
  close: () => Promise<void>;
};

/** Escape a ClickHouse identifier with backticks (doubles any embedded backticks). */
function chIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export async function listClickHouseObjects(
  connectionString: string,
): Promise<DatabaseObject[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@clickhouse/client");
  const client = createClient({ url: rewriteClickHouseUrl(connectionString) });
  try {
    const rows = await clickhouseQuery<{ name: string; engine: string }>(
      client,
      `SELECT name, engine FROM system.tables
       WHERE database = currentDatabase()
         AND engine NOT IN ('System', 'MaterializedView')
       ORDER BY name`,
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.engine === "View" ? ("view" as const) : ("table" as const),
    }));
  } finally {
    await client.close().catch((closeErr: unknown) => {
      console.warn(`[atlas] ClickHouse client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
    });
  }
}

async function queryClickHousePrimaryKeys(
  client: ClickHouseClient,
  tableName: string,
): Promise<string[]> {
  const rows = await clickhouseQuery<{ name: string }>(
    client,
    `SELECT name FROM system.columns
     WHERE database = currentDatabase()
       AND table = '${tableName.replace(/'/g, "''")}'
       AND is_in_primary_key = 1
     ORDER BY position`,
  );
  return rows.map((r) => r.name);
}

/** Map ClickHouse native types to Atlas semantic types. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- scaffolding for ClickHouse profiler
function mapClickHouseType(chType: string): string {
  const t = chType
    .replace(/Nullable\((.+)\)/, "$1")
    .replace(/LowCardinality\((.+)\)/, "$1")
    .toLowerCase();
  if (/^(u?int\d+|float\d+|decimal|numeric)/.test(t)) return "number";
  if (/^(date|datetime)/.test(t)) return "date";
  if (t.startsWith("bool")) return "boolean";
  return "string";
}

export async function profileClickHouse(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
): Promise<ProfilingResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@clickhouse/client");
  const client = createClient({
    url: rewriteClickHouseUrl(connectionString),
  });

  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      const rows = await clickhouseQuery<{ name: string; engine: string }>(
        client,
        `SELECT name, engine FROM system.tables
         WHERE database = currentDatabase()
           AND engine NOT IN ('System', 'MaterializedView')
         ORDER BY name`,
      );
      allObjects = rows.map((r) => ({
        name: r.name,
        type: r.engine === "View" ? ("view" as const) : ("table" as const),
      }));
    }

    const objectsToProfile = filterTables
      ? allObjects.filter((o) => filterTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const table_name = obj.name;
      const objectType = obj.type;
      const safeTable = table_name.replace(/'/g, "''");
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
        const countRows = await clickhouseQuery<{ c: string }>(
          client,
          `SELECT count() as c FROM ${chIdentifier(table_name)}`,
        );
        const rowCount = parseInt(countRows[0].c, 10);

        // ClickHouse primary keys are sorting keys, not uniqueness constraints.
        // No foreign keys in ClickHouse (OLAP, no referential integrity).
        let primaryKeyColumns: string[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await queryClickHousePrimaryKeys(
              client,
              table_name,
            );
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            console.warn(
              `    Warning: Could not read PK columns for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`,
            );
          }
        }

        // Column metadata from system.columns
        const colRows = await clickhouseQuery<{
          name: string;
          type: string;
          comment: string;
        }>(
          client,
          `SELECT name, type, comment FROM system.columns
           WHERE database = currentDatabase() AND table = '${safeTable}'
           ORDER BY position`,
        );

        const columns: ColumnProfile[] = [];

        for (const col of colRows) {
          let unique_count: number | null = null;
          let null_count: number | null = null;
          let sample_values: string[] = [];
          let isEnumLike = false;

          const isPK = primaryKeyColumns.includes(col.name);

          try {
            const uqRows = await clickhouseQuery<{ c: string }>(
              client,
              `SELECT uniqExact(${chIdentifier(col.name)}) as c FROM ${chIdentifier(table_name)}`,
            );
            unique_count = parseInt(uqRows[0].c, 10);

            const ncRows = await clickhouseQuery<{ c: string }>(
              client,
              `SELECT count() as c FROM ${chIdentifier(table_name)} WHERE ${chIdentifier(col.name)} IS NULL`,
            );
            null_count = parseInt(ncRows[0].c, 10);

            // Enum-like detection for String/LowCardinality(String) columns
            const baseType = col.type
              .replace(/Nullable\((.+)\)/, "$1")
              .replace(/LowCardinality\((.+)\)/, "$1");
            const isTextType =
              baseType === "String" ||
              baseType.startsWith("FixedString") ||
              baseType.startsWith("Enum");
            isEnumLike =
              isTextType &&
              unique_count !== null &&
              unique_count < 20 &&
              rowCount > 0 &&
              unique_count / rowCount <= 0.05;

            const sampleLimit = isEnumLike ? 100 : 10;
            const svRows = await clickhouseQuery<{ v: unknown }>(
              client,
              `SELECT DISTINCT ${chIdentifier(col.name)} as v FROM ${chIdentifier(table_name)} WHERE ${chIdentifier(col.name)} IS NOT NULL ORDER BY v LIMIT ${sampleLimit}`,
            );
            sample_values = svRows.map((r) => String(r.v));
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            console.warn(
              `    Warning: Could not profile column ${table_name}.${col.name}: ${colErr instanceof Error ? colErr.message : String(colErr)}`,
            );
          }

          columns.push({
            name: col.name,
            type: col.type,
            nullable: col.type.startsWith("Nullable"),
            unique_count,
            null_count,
            sample_values,
            is_primary_key: isPK,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes: col.comment
              ? [`Column comment: ${col.comment}`]
              : [],
          });
        }

        profiles.push({
          table_name,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: primaryKeyColumns,
          foreign_keys: [],
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
        if (isFatalConnectionError(err)) {
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
    await client.close().catch((err: unknown) => {
      console.warn(
        `[atlas] ClickHouse client cleanup warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  return { profiles, errors };
}
