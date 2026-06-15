/**
 * Salesforce OAuth introspection — the profiling half of the live connection
 * for OAuth-managed Salesforce datasources (#3667, ADR-0014).
 *
 * Salesforce stays on the OAuth path (ADR-0014): its per-workspace connection is
 * built from `integration_credentials` tokens via the `LazyPluginLoader`, NOT via
 * the plugin's `createFromConfig` bridge. Because core `@atlas/api` must not
 * import the `@useatlas/salesforce` plugin package (ADR-0013), the OAuth path's
 * introspection lives HERE, in core, operating over the OAuth `jsforce` session
 * the lazy builder already owns. (The plugin's url/password profiler remains the
 * CLI-with-credentialed-url path.)
 *
 * The describe → column-profile mapping mirrors `plugins/salesforce/src/profiler.ts`
 * field-for-field: `Id` is the primary key, `reference` fields are foreign keys
 * (→ the referenced SObject's `Id`), picklist/multipicklist fields surface their
 * active values as enum-like `sample_values`, and the row count comes from a
 * bounded `SELECT COUNT(Id)`. Read-only: describe + one aggregate SELECT per
 * object, no DML.
 *
 * SECURITY: the OAuth access/refresh tokens are decrypted secret material owned
 * by the lazy builder. They never reach this module — it receives only a
 * describe/query surface. Caught errors are type-narrowed to a message string
 * and never echo tokens.
 */

import type {
  DatabaseObject,
  ColumnProfile,
  ForeignKey,
  TableProfile,
  ProfileError,
  ProfilingResult,
} from "@useatlas/types";
import type { LiveConnectionProfileOptions } from "@atlas/api/lib/effect/semantic-generator";

/** A single SObject field as returned by jsforce `describe` (structural subset). */
interface RawSObjectField {
  name?: string;
  type?: string;
  nillable?: boolean;
  referenceTo?: readonly string[];
  picklistValues?: ReadonlyArray<{ value?: string; active?: boolean }>;
}

/**
 * The describe/query surface the introspection runs against — a structural slice
 * of the OAuth `jsforce` session, each call routed through the lazy builder's
 * refresh-retry harness (so a mid-profile `INVALID_SESSION_ID` refreshes once and,
 * on permanent failure, throws the reconnect-required error). Tokens stay inside
 * the surface's closures; they never cross into this module.
 */
export interface SalesforceDescribeSurface {
  describeGlobal(): Promise<{ sobjects?: ReadonlyArray<{ name?: string; queryable?: boolean }> }>;
  describe(objectName: string): Promise<{ fields?: readonly RawSObjectField[] }>;
  /** Run a (read-only) SOQL query and return its records. */
  query(soql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** Connection-level errors that fail every remaining object — abort fast. */
const FATAL_ERROR_PATTERN =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b|\bINVALID_LOGIN\b|\bINVALID_SESSION_ID\b/i;

function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return FATAL_ERROR_PATTERN.test(String(err));
  if (FATAL_ERROR_PATTERN.test(err.message)) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

/** Type-narrow a caught error to a message string (never echoes tokens). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Enumerate the queryable SObjects in the connected org (SObjects map to `table`). */
export async function listSalesforceOAuthObjects(
  surface: SalesforceDescribeSurface,
): Promise<DatabaseObject[]> {
  const result = await surface.describeGlobal();
  return (result.sobjects ?? [])
    .filter((s) => s.queryable === true && typeof s.name === "string")
    .map((s): DatabaseObject => ({ name: s.name as string, type: "table" }));
}

/**
 * Profile the connected Salesforce org into a {@link ProfilingResult} over the
 * OAuth session. Mirrors the plugin profiler's mapping; read-only.
 */
export async function profileSalesforceOAuth(
  surface: SalesforceDescribeSurface,
  options: LiveConnectionProfileOptions = {},
): Promise<ProfilingResult> {
  const { selectedTables, prefetchedObjects, progress, logger } = options;

  const allObjects: DatabaseObject[] = prefetchedObjects
    ? [...prefetchedObjects]
    : await listSalesforceOAuthObjects(surface);
  const objectsToProfile = selectedTables
    ? allObjects.filter((o) => selectedTables.includes(o.name))
    : allObjects;

  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  progress?.onStart(objectsToProfile.length);

  for (const [i, obj] of objectsToProfile.entries()) {
    const objectName = obj.name;
    progress?.onTableStart(objectName, i, objectsToProfile.length);
    try {
      const desc = await surface.describe(objectName);

      // Row count via a bounded aggregate SOQL query. Non-fatal failures leave
      // the count at 0 (some objects disallow COUNT).
      let rowCount = 0;
      try {
        const rows = await surface.query(`SELECT COUNT(Id) FROM ${objectName}`);
        if (rows.length > 0) {
          // jsforce aggregate records are `{ attributes: {...}, expr0: N }`. Read
          // the aliased count (`expr0`/`count`); fall back to the first NON-object
          // value so the `attributes` envelope can't be mistaken for the count
          // (which would `parseInt` to NaN → a silent 0 row-count feeding the
          // abandonment/denormalization heuristics).
          const first = rows[0];
          const fallback = Object.entries(first).find(
            ([k, v]) => k !== "attributes" && (typeof v === "number" || typeof v === "string"),
          )?.[1];
          const countVal = first.expr0 ?? first.count ?? fallback;
          rowCount = parseInt(String(countVal ?? "0"), 10);
          if (Number.isNaN(rowCount)) rowCount = 0;
        }
      } catch (countErr) {
        if (isFatalConnectionError(countErr)) throw countErr;
        logger?.warn({ object: objectName, err: errMessage(countErr) }, "Could not get row count");
      }

      const foreignKeys: ForeignKey[] = [];
      const primaryKeyColumns: string[] = [];
      const columns: ColumnProfile[] = (desc.fields ?? []).map((field): ColumnProfile => {
        const fieldName = field.name ?? "";
        const isPK = fieldName === "Id";
        if (isPK) primaryKeyColumns.push(fieldName);
        const referenceTo = field.referenceTo ?? [];
        const isFK = field.type === "reference" && referenceTo.length > 0;
        if (isFK) {
          foreignKeys.push({ from_column: fieldName, to_table: referenceTo[0], to_column: "Id", source: "constraint" });
        }
        const isEnumLike = field.type === "picklist" || field.type === "multipicklist";
        const sampleValues = isEnumLike
          ? (field.picklistValues ?? []).filter((pv) => pv.active).map((pv) => pv.value ?? "")
          : [];
        return {
          name: fieldName,
          type: field.type ?? "unknown",
          nullable: field.nillable ?? true,
          unique_count: null,
          null_count: null,
          sample_values: sampleValues,
          is_primary_key: isPK,
          is_foreign_key: isFK,
          fk_target_table: isFK ? referenceTo[0] : null,
          fk_target_column: isFK ? "Id" : null,
          is_enum_like: isEnumLike,
          profiler_notes: [],
        };
      });

      profiles.push({
        table_name: objectName,
        object_type: "table",
        row_count: rowCount,
        columns,
        primary_key_columns: primaryKeyColumns,
        foreign_keys: foreignKeys,
        inferred_foreign_keys: [],
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
      });
      progress?.onTableDone(objectName, i, objectsToProfile.length);
    } catch (err) {
      const msg = errMessage(err);
      if (isFatalConnectionError(err)) {
        // A fatal (e.g. INVALID_SESSION_ID that survived the refresh-retry)
        // aborts the whole profile — the lazy builder surfaces it as an
        // actionable reconnect-required upstream, never a silent partial layer.
        throw err instanceof Error ? err : new Error(msg);
      }
      progress?.onTableError(objectName, msg, i, objectsToProfile.length);
      errors.push({ table: objectName, error: msg });
    }
  }

  progress?.onComplete(profiles.length, 0);
  return { profiles, errors };
}
