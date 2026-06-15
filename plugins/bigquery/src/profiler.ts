/**
 * BigQuery profiler — the introspection half of the datasource contract
 * (ADR-0017). Enumerates objects (`listBigQueryObjects`) and profiles columns
 * + sample values (`profileBigQuery`) into the SDK's structural
 * `ProfilingResult` mirror, which the host's registry-resolved profiler seam
 * feeds into `SemanticGenerator` without importing this package. The CLI
 * (`atlas init` / `atlas diff`) consumes these exports directly.
 *
 * BigQuery is net-new on the contract — there is no prior CLI profiler to port.
 *
 * Cost posture (the whole point of profiling BigQuery carefully): BigQuery
 * bills by bytes SCANNED, so a naive profiler that runs `COUNT(*)`,
 * `COUNT(DISTINCT col)`, or `SELECT DISTINCT col` over a table would scan the
 * whole table and bill the operator for every profiled column. This profiler
 * NEVER does a full scan:
 *
 *   - Structure (datasets, tables, views, columns, types) comes from
 *     `INFORMATION_SCHEMA.{TABLES,COLUMNS}` — metadata queries that process
 *     ~0 bytes of table data.
 *   - Row counts come from `INFORMATION_SCHEMA.TABLE_STORAGE.total_rows` —
 *     table metadata, NOT a scanning `COUNT(*)`.
 *   - Sample values come from a single bounded read per table (one small read
 *     shared across all columns), not a per-column scan. Enum-like detection is
 *     derived from that bounded sample, never a full `COUNT(DISTINCT)`.
 *
 *     CRITICAL: a plain `SELECT * ... LIMIT n` does NOT bound BigQuery cost — a
 *     `LIMIT` is applied AFTER the scan, so BigQuery still bills for every byte
 *     of every selected column across the whole table. For base tables we use
 *     `TABLESAMPLE SYSTEM (n PERCENT)`, which reads (and bills) only the
 *     sampled storage blocks, then `LIMIT` to cap rows returned. Views can't be
 *     `TABLESAMPLE`d, so they fall back to `LIMIT` — but a view's underlying
 *     scan is bounded by its own definition, and views report 0 storage rows,
 *     so the exposure is far smaller than an unbounded base-table scan.
 *
 * Every query runs through {@link createBigQueryConnection}, whose `query()`
 * issues read-only BigQuery jobs (no DML/DDL), so profiling honors the same
 * read-only posture as the query path and never mutates the project. Caught
 * errors are type-narrowed and never echo credentials.
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
import {
  createBigQueryConnection,
  parseBigQueryUrl,
  type BigQueryConnectionConfig,
} from "./connection";

/** Connection-level errors that will fail every remaining table — abort fast. */
const FATAL_ERROR_PATTERN =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b/i;

/**
 * Detect a connection-level (vs. per-table) failure. A fatal error means the
 * whole profile should abort rather than recording N identical per-table
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

/** Backtick-escape a BigQuery identifier (doubles any embedded backtick). */
function bqIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Single-quote escape for a BigQuery string literal. */
function bqLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Build the base connection config from the host-carried tenant config
 * (#3664 — the ADR-0017 amendment that lets a multi-field-credential profiler
 * authenticate with the TENANT's own creds over the registry/MCP seam, mirroring
 * Elasticsearch's `configForOptions`).
 *
 * BigQuery is non-url-shaped: its credentials (`service_account_json`) live in a
 * SEPARATE config field, NEVER in the connection string. The Admin → Connections
 * catalog form collects `service_account_json` (raw key JSON string) + `project_id`
 * (snake_case) + the generic `schema` routing hint; map them onto the connection
 * factory's `credentials` (object) + `projectId` + `dataset` shape. A
 * programmatic caller passing camelCase `projectId`/`credentials`/`dataset`
 * directly still works.
 *
 * @throws {Error} when `service_account_json` is present but not valid JSON.
 */
function bigQueryConfigFromTenantConfig(
  raw: Readonly<Record<string, unknown>>,
): BigQueryConnectionConfig {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const projectId = str(raw.projectId) ?? str(raw.project_id);
  const dataset = str(raw.dataset) ?? str(raw.schema);
  const location = str(raw.location);
  const keyFilename = str(raw.keyFilename);

  let credentials: Record<string, unknown> | undefined;
  const serviceAccountJson = str(raw.service_account_json);
  if (serviceAccountJson) {
    try {
      credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `BigQuery service_account_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  } else if (raw.credentials && typeof raw.credentials === "object") {
    credentials = raw.credentials as Record<string, unknown>;
  }

  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(dataset !== undefined ? { dataset } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(keyFilename !== undefined ? { keyFilename } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
  };
}

/**
 * Resolve the dataset to introspect and the base connection config.
 *
 * Two credential sources, chosen by whether the host seam supplied the tenant's
 * config (registry/MCP path) or only a url (CLI / static-config path):
 *   - `options.config` present → the host carried the datasource's DECRYPTED
 *     config; build from the tenant's own service-account creds (#3664).
 *   - `options.config` absent → parse the `bigquery://` url (operator shell).
 *
 * `options.schema` (the SDK routing hint) wins over the dataset embedded in
 * either source, mirroring how the CLI passes `--schema`.
 *
 * @throws {Error} when no dataset or no project can be resolved.
 */
function resolveConfig(
  options: PluginListObjectsOptions,
): { config: BigQueryConnectionConfig; projectId: string; dataset: string } {
  const base = options.config
    ? bigQueryConfigFromTenantConfig(options.config)
    : parseBigQueryUrl(options.url);
  const dataset = options.schema ?? base.dataset;
  if (!dataset) {
    throw new Error(
      "BigQuery profiling requires a dataset. Pass it in the URL " +
        "(bigquery://project/dataset), via the schema option, or as a `schema` " +
        "field on the datasource config.",
    );
  }
  const projectId = base.projectId;
  if (!projectId) {
    throw new Error(
      "BigQuery profiling requires a project (the bigquery:// URL host or a " +
        "`project_id` datasource config field).",
    );
  }
  // Scope the connection to the resolved dataset so unqualified references
  // (e.g. INFORMATION_SCHEMA) resolve against it.
  return { config: { ...base, dataset }, projectId, dataset };
}

/** A row from INFORMATION_SCHEMA.TABLES. */
interface TablesRow {
  table_name: string;
  table_type: string;
}

function tablesRowToObject(r: TablesRow): PluginDatabaseObject {
  // BigQuery table_type: "BASE TABLE", "VIEW", "MATERIALIZED VIEW",
  // "EXTERNAL", "SNAPSHOT", "CLONE". Map views to "view", materialized views
  // to "materialized_view", everything else to "table".
  const t = r.table_type.toUpperCase();
  if (t === "VIEW") return { name: r.table_name, type: "view" };
  if (t === "MATERIALIZED VIEW") return { name: r.table_name, type: "materialized_view" };
  return { name: r.table_name, type: "table" };
}

/**
 * Build the INFORMATION_SCHEMA.TABLES query for a dataset. The
 * dataset-qualified `INFORMATION_SCHEMA.TABLES` view is a metadata read — it
 * scans no table data.
 */
function listObjectsSql(dataset: string): string {
  return `SELECT table_name, table_type
   FROM ${bqIdentifier(dataset)}.INFORMATION_SCHEMA.TABLES
   ORDER BY table_name`;
}

/**
 * Enumerate the queryable tables/views in a BigQuery dataset via
 * INFORMATION_SCHEMA.TABLES (metadata-only — no table scan).
 */
export async function listBigQueryObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const { config, dataset } = resolveConfig(options);
  const conn = createBigQueryConnection(config);
  try {
    const { rows } = await conn.query(listObjectsSql(dataset));
    return (rows as unknown as TablesRow[]).map(tablesRowToObject);
  } finally {
    await conn.close();
  }
}

/** A row from INFORMATION_SCHEMA.COLUMNS. */
interface ColumnsRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/**
 * Build the bounded sample-read SQL for one object. Cost posture (see header):
 * a `LIMIT` alone does NOT bound BigQuery bytes billed — it is applied after the
 * scan. For base tables we use `TABLESAMPLE SYSTEM`, which reads and bills only
 * the sampled storage blocks, capping cost on large tables. Views and
 * materialized views can't be `TABLESAMPLE`d (BigQuery rejects it), so they fall
 * back to a plain `LIMIT`; a view's scan is bounded by its own definition and
 * views carry no base storage of their own.
 */
function sampleSql(
  dataset: string,
  tableName: string,
  objectType: PluginDatabaseObject["type"],
): string {
  const target = `${bqIdentifier(dataset)}.${bqIdentifier(tableName)}`;
  if (objectType === "table") {
    // 1 PERCENT keeps large tables cheap; small tables return whole blocks
    // (still cheap). LIMIT then caps the rows we materialize.
    return `SELECT * FROM ${target} TABLESAMPLE SYSTEM (1 PERCENT) LIMIT 100`;
  }
  return `SELECT * FROM ${target} LIMIT 100`;
}

/** Heuristic: which BigQuery types are text-like and can be enum-like. */
function isTextType(dataType: string): boolean {
  const base = dataType.toUpperCase();
  return base === "STRING" || base.startsWith("STRING(");
}

/**
 * Profile a BigQuery dataset into a {@link PluginProfilingResult}. For each
 * object: row count (from table metadata), column types/nullability (from
 * INFORMATION_SCHEMA), and a single bounded sample read used to derive
 * per-column sample values and enum-like-ness. No full table scans — see the
 * file header.
 *
 * BigQuery has no enforced primary/foreign keys (constraints are unenforced
 * metadata, rarely populated), so PK/FK fields are left empty — the semantic
 * generator infers relationships from naming + sample values downstream.
 */
export async function profileBigQuery(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const { selectedTables, prefetchedObjects, progress } = options;
  const { config, dataset } = resolveConfig(options);
  const conn = createBigQueryConnection(config);

  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    const allObjects: PluginDatabaseObject[] = prefetchedObjects
      ? prefetchedObjects
      : ((await conn.query(listObjectsSql(dataset))).rows as unknown as TablesRow[]).map(
          tablesRowToObject,
        );

    const objectsToProfile = selectedTables
      ? allObjects.filter((o) => selectedTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    // Row counts for the whole dataset come from one metadata read of
    // INFORMATION_SCHEMA.TABLE_STORAGE (total_rows) — no per-table COUNT(*).
    const rowCounts = new Map<string, number>();
    if (objectsToProfile.length > 0) {
      try {
        const storageRows = (
          await conn.query(
            `SELECT table_name, total_rows
             FROM ${bqIdentifier(dataset)}.INFORMATION_SCHEMA.TABLE_STORAGE`,
          )
        ).rows as unknown as { table_name: string; total_rows: string | number }[];
        for (const r of storageRows) {
          rowCounts.set(r.table_name, Number(r.total_rows ?? 0));
        }
      } catch (storageErr) {
        if (isFatalConnectionError(storageErr)) throw storageErr;
        // Non-fatal: TABLE_STORAGE may be unavailable (e.g. for some view-only
        // datasets or restricted permissions). Fall back to a 0 row count per
        // table rather than failing the whole profile — views report 0 anyway.
      }
    }

    for (const [i, obj] of objectsToProfile.entries()) {
      const tableName = obj.name;
      const objectType = obj.type;
      const objectLabel = objectType === "view" ? " [view]" : "";
      progress?.onTableStart(tableName + objectLabel, i, objectsToProfile.length);

      try {
        const rowCount = rowCounts.get(tableName) ?? 0;

        const colRows = (
          await conn.query(
            `SELECT column_name, data_type, is_nullable
             FROM ${bqIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS
             WHERE table_name = '${bqLiteral(tableName)}'
             ORDER BY ordinal_position`,
          )
        ).rows as unknown as ColumnsRow[];

        // One bounded sample read shared across every column — never a full
        // scan. Base tables use TABLESAMPLE SYSTEM so BigQuery bills only the
        // sampled storage blocks (a bare LIMIT would still bill the whole
        // table); views fall back to LIMIT. See sampleSql / the file header.
        let sampleRows: Record<string, unknown>[] = [];
        try {
          sampleRows = (
            await conn.query(sampleSql(dataset, tableName, objectType))
          ).rows as Record<string, unknown>[];
        } catch (sampleErr) {
          if (isFatalConnectionError(sampleErr)) throw sampleErr;
          // Non-fatal: emit columns with metadata but no sample values rather
          // than failing the table (e.g. a view that errors on read).
        }

        const columns: PluginColumnProfile[] = colRows.map((col) => {
          const present = sampleRows
            .map((r) => r[col.column_name])
            .filter((v) => v !== null && v !== undefined);
          const distinct = Array.from(new Set(present.map((v) => String(v))));
          const nullCount = sampleRows.length - present.length;

          // Enum-like derived from the bounded sample only (no full COUNT
          // DISTINCT): a text column with few distinct sampled values where
          // repetition is observed (distinct < sampled rows). The ratio is
          // sample-scoped and intentionally lenient — the bounded sample can't
          // prove true low cardinality, so this is a hint for the generator,
          // not a guarantee.
          const isEnumLike =
            isTextType(col.data_type) &&
            present.length > 0 &&
            distinct.length > 0 &&
            distinct.length < 20 &&
            distinct.length < present.length;

          const sampleLimit = isEnumLike ? 100 : 10;
          const sampleValues = distinct.slice(0, sampleLimit);

          return {
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable.toUpperCase() === "YES",
            // Cardinality from a bounded sample is not a true table-wide count,
            // so report null rather than a misleading sample-scoped number.
            unique_count: null,
            null_count: sampleRows.length > 0 ? nullCount : null,
            sample_values: sampleValues,
            is_primary_key: false,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes:
              sampleRows.length > 0
                ? [
                    `Sampled ${sampleRows.length} row(s) (${
                      objectType === "table" ? "TABLESAMPLE-bounded" : "LIMIT-bounded"
                    }, no full scan)`,
                  ]
                : [],
          } satisfies PluginColumnProfile;
        });

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
