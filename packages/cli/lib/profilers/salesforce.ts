/**
 * Salesforce profiler.
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
import type { SObjectField } from "../../../../plugins/salesforce/src/connection";
import type { ProfileProgressCallbacks } from "../../src/progress";

export async function listSalesforceObjects(
  connectionString: string,
): Promise<DatabaseObject[]> {
  const { parseSalesforceURL, createSalesforceConnection } = await import(
    "../../../../plugins/salesforce/src/connection"
  );
  const config = parseSalesforceURL(connectionString);
  const source = createSalesforceConnection(config);
  try {
    const objects = await source.listObjects();
    return objects.map((obj: { name: string }) => ({
      name: obj.name,
      type: "table" as const,
    }));
  } finally {
    await source.close().catch((closeErr: unknown) => {
      console.warn(`[atlas] Salesforce client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
    });
  }
}

export async function profileSalesforce(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
): Promise<ProfilingResult> {
  const { parseSalesforceURL, createSalesforceConnection } = await import(
    "../../../../plugins/salesforce/src/connection"
  );
  const config = parseSalesforceURL(connectionString);
  const source = createSalesforceConnection(config);

  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      const objects = await source.listObjects();
      allObjects = objects.map((obj: { name: string }) => ({
        name: obj.name,
        type: "table" as const,
      }));
    }

    const objectsToProfile = filterTables
      ? allObjects.filter((o) => filterTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const objectName = obj.name;
      if (progress) {
        progress.onTableStart(objectName, i, objectsToProfile.length);
      } else {
        console.log(
          `  [${i + 1}/${objectsToProfile.length}] Profiling ${objectName}...`,
        );
      }

      try {
        const desc = await source.describe(objectName);

        // Get row count via SOQL
        let rowCount = 0;
        try {
          const countResult = await source.query(
            `SELECT COUNT(Id) FROM ${objectName}`,
          );
          // Salesforce COUNT(Id) returns { records: [{ expr0: N }] }
          if (countResult.rows.length > 0) {
            const firstRow = countResult.rows[0];
            const countVal =
              firstRow.expr0 ?? firstRow.count ?? Object.values(firstRow)[0];
            rowCount = parseInt(String(countVal ?? "0"), 10);
          }
        } catch (countErr) {
          if (isFatalConnectionError(countErr)) throw countErr;
          console.warn(
            `    Warning: Could not get row count for ${objectName}: ${countErr instanceof Error ? countErr.message : String(countErr)}`,
          );
        }

        const foreignKeys: ForeignKey[] = [];
        const primaryKeyColumns: string[] = [];

        const columns: ColumnProfile[] = desc.fields.map(
          (field: SObjectField) => {
            const isPK = field.name === "Id";
            if (isPK) primaryKeyColumns.push(field.name);

            const isFK =
              field.type === "reference" && field.referenceTo.length > 0;
            if (isFK) {
              foreignKeys.push({
                from_column: field.name,
                to_table: field.referenceTo[0],
                to_column: "Id",
                source: "constraint",
              });
            }

            const isEnumLike =
              field.type === "picklist" || field.type === "multipicklist";

            // For picklist fields, extract active values as sample_values
            const sampleValues = isEnumLike
              ? field.picklistValues
                  .filter((pv) => pv.active)
                  .map((pv) => pv.value)
              : [];

            return {
              name: field.name,
              type: field.type,
              nullable: field.nillable,
              unique_count: null,
              null_count: null,
              sample_values: sampleValues,
              is_primary_key: isPK,
              is_foreign_key: isFK,
              fk_target_table: isFK ? field.referenceTo[0] : null,
              fk_target_column: isFK ? "Id" : null,
              is_enum_like: isEnumLike,
              profiler_notes: [],
            };
          },
        );

        profiles.push({
          table_name: objectName,
          object_type: "table",
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
        progress?.onTableDone(objectName, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining objects
        if (isFatalConnectionError(err)) {
          throw new Error(
            `Fatal Salesforce error while profiling ${objectName}: ${msg}`,
            { cause: err },
          );
        }
        if (progress) {
          progress.onTableError(objectName, msg, i, objectsToProfile.length);
        } else {
          console.error(
            `  Warning: Failed to profile ${objectName}: ${msg}`,
          );
        }
        errors.push({ table: objectName, error: msg });
        continue;
      }
    }
  } finally {
    await source.close().catch((closeErr: unknown) => {
      console.warn(`[atlas] Salesforce client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
    });
  }

  return { profiles, errors };
}
