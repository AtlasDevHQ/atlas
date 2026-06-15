/**
 * Salesforce profiler — the introspection half of the datasource contract
 * (ADR-0017). Enumerates SObjects (`listSalesforceObjects`) and profiles fields
 * + sample values (`profileSalesforce`) into the SDK's structural
 * `ProfilingResult` mirror, which the host's registry-resolved profiler seam
 * feeds into `SemanticGenerator` without importing this package.
 *
 * Salesforce is NOT SQL — it speaks SOQL over jsforce's REST/describe API.
 * `listObjects` enumerates queryable SObjects via `describeGlobal`; `profile`
 * maps each SObject's describe metadata → column profiles (field types,
 * picklist values surfaced as enum-like sample values, `reference` fields as
 * foreign keys), with a bounded `SELECT COUNT(Id)` for the row count. The
 * profiler is therefore **read-only** — describe + a single aggregate SELECT
 * per object, no DML.
 *
 * Salesforce stays on OAuth (ADR-0014): the `url` here is the same
 * `salesforce://` value `createFromConfig` resolves, which the connection
 * factory turns into the OAuth/jsforce session. No SQL `url` assumption — the
 * connection is built the same way the query path builds it.
 *
 * Logic adapted from the CLI's `packages/cli/lib/profilers/salesforce.ts` —
 * this plugin package becomes the home the registry resolves and the CLI
 * consumes directly. Never echoes credentials/tokens: caught errors are
 * type-narrowed to a message string and the connection's own logger/`close`
 * paths already scrub.
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
} from "@useatlas/plugin-sdk";
import {
  parseSalesforceURL,
  createSalesforceConnection,
} from "./connection";
import type { SObjectField, SalesforceConnection } from "./connection";

/** Connection-level errors that will fail every remaining object — abort fast. */
const FATAL_ERROR_PATTERN =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b|\bINVALID_LOGIN\b|\bINVALID_SESSION_ID\b/i;

/**
 * Detect a connection-level (vs. per-object) failure. A fatal error means the
 * whole profile should abort rather than recording N identical per-object
 * errors. Mirrors the host's `isFatalConnectionError` (kept local to avoid
 * importing `@atlas/api` into the plugin package — ADR-0013).
 */
function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return FATAL_ERROR_PATTERN.test(String(err));
  if (FATAL_ERROR_PATTERN.test(err.message)) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

/** Type-narrow a caught error to a message string (never echoes secrets). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort connection cleanup that never throws past the caller. */
async function closeQuietly(
  source: SalesforceConnection,
  log?: PluginProfileOptions["logger"],
): Promise<void> {
  try {
    await source.close();
  } catch (closeErr) {
    log?.warn(
      { err: errMessage(closeErr) },
      "Salesforce client cleanup warning",
    );
  }
}

/**
 * Enumerate the queryable SObjects in the connected Salesforce org. Only
 * `queryable` SObjects are returned (the connection's `listObjects` already
 * filters these via `describeGlobal`). SObjects map to `table` — SOQL has no
 * views.
 */
export async function listSalesforceObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const config = parseSalesforceURL(options.url);
  const source = createSalesforceConnection(config);
  try {
    const objects = await source.listObjects();
    return objects.map((obj) => ({ name: obj.name, type: "table" as const }));
  } finally {
    await closeQuietly(source);
  }
}

/**
 * Profile the connected Salesforce org into a {@link PluginProfilingResult}.
 * For each SObject: a bounded `SELECT COUNT(Id)` row count, plus field →
 * column mapping from the describe metadata — `Id` as the primary key,
 * `reference` fields as foreign keys (→ the referenced SObject's `Id`), and
 * picklist/multipicklist fields surfaced as enum-like columns whose active
 * values become `sample_values`. Read-only: describe + one aggregate SELECT
 * per object, no DML.
 */
export async function profileSalesforce(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const { url, selectedTables, prefetchedObjects, progress, logger } = options;
  const config = parseSalesforceURL(url);
  const source = createSalesforceConnection(config);

  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    const allObjects: PluginDatabaseObject[] = prefetchedObjects
      ? prefetchedObjects
      : (await source.listObjects()).map((obj) => ({
          name: obj.name,
          type: "table" as const,
        }));

    const objectsToProfile = selectedTables
      ? allObjects.filter((o) => selectedTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const objectName = obj.name;
      progress?.onTableStart(objectName, i, objectsToProfile.length);

      try {
        const desc = await source.describe(objectName);

        // Row count via a bounded aggregate SOQL query. Non-fatal failures
        // (e.g. objects that disallow COUNT) leave the count at 0.
        let rowCount = 0;
        try {
          const countResult = await source.query(
            `SELECT COUNT(Id) FROM ${objectName}`,
          );
          if (countResult.rows.length > 0) {
            const firstRow = countResult.rows[0];
            // Salesforce COUNT(Id) returns { expr0: N } (or { count: N }).
            const countVal =
              firstRow.expr0 ?? firstRow.count ?? Object.values(firstRow)[0];
            rowCount = parseInt(String(countVal ?? "0"), 10);
            if (Number.isNaN(rowCount)) rowCount = 0;
          }
        } catch (countErr) {
          if (isFatalConnectionError(countErr)) throw countErr;
          logger?.warn(
            { object: objectName, err: errMessage(countErr) },
            "Could not get row count",
          );
        }

        const foreignKeys: PluginForeignKey[] = [];
        const primaryKeyColumns: string[] = [];

        const columns: PluginColumnProfile[] = desc.fields.map(
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

            // Picklist fields expose their active values as sample values.
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
        const msg = errMessage(err);
        // Fatal connection-level error — every remaining object fails the same
        // way, so abort rather than recording N identical errors.
        if (isFatalConnectionError(err)) {
          throw new Error(
            `Fatal Salesforce error while profiling ${objectName}: ${msg}`,
            { cause: err },
          );
        }
        progress?.onTableError(objectName, msg, i, objectsToProfile.length);
        errors.push({ table: objectName, error: msg });
      }
    }
  } finally {
    await closeQuietly(source, logger);
  }

  return { profiles, errors };
}
