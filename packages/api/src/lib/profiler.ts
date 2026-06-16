/**
 * Shared profiler library — used by the wizard API for database profiling.
 *
 * Contains type mapping, YAML generation, heuristics, and DB-specific
 * profiling. Canonical type definitions live in @useatlas/types and are
 * re-exported here for convenience.
 */

import { createLogger } from "@atlas/api/lib/logger";
// Re-export shared utilities so existing consumers (e.g. @atlas/cli) don't break.
export { mapSQLType, isViewLike, pluralize, singularize, entityName } from "./profiler-utils";

// Re-export canonical types so existing consumers of @atlas/api/lib/profiler
// continue to work without import path changes.
export {
  OBJECT_TYPES,
  FK_SOURCES,
  PARTITION_STRATEGIES,
  SEMANTIC_TYPES,
  INDEX_TYPES,
  INDEX_POSITIONS,
} from "@useatlas/types";
export type {
  ObjectType,
  ColumnProfile,
  DatabaseObject,
  ForeignKey,
  ForeignKeySource,
  SemanticType,
  PartitionStrategy,
  PartitionInfo,
  TableFlags,
  TableProfile,
  ProfileError,
  ProfilingResult,
  IndexProfile,
  IndexType,
  IndexPosition,
} from "@useatlas/types";

// Also import locally for use within this module's function signatures.
import type {
  ColumnProfile,
  DatabaseObject,
  ForeignKey,
  TableProfile,
  ProfileError,
  ProfilingResult,
  IndexProfile,
  IndexType,
} from "@useatlas/types";

/** Minimal structured logger interface — compatible with pino's (obj, msg) calling convention. */
export interface ProfileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  /** Optional — pino has it; a minimal injected logger may not. Called via `?.`. */
  debug?(obj: Record<string, unknown>, msg: string): void;
}

const defaultLog: ProfileLogger = createLogger("profiler");

/** Callbacks for progress reporting during profiling. */
export interface ProfileProgressCallbacks {
  onStart(total: number): void;
  onTableStart(name: string, index: number, total: number): void;
  onTableDone(name: string, index: number, total: number): void;
  onTableError(name: string, error: string, index: number, total: number): void;
  onComplete(count: number, elapsedMs: number): void;
}

// ---------------------------------------------------------------------------
// Fatal error detection
// ---------------------------------------------------------------------------

export const FATAL_ERROR_PATTERN = /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b/i;

export function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return FATAL_ERROR_PATTERN.test(String(err));
  if (FATAL_ERROR_PATTERN.test(err.message)) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

// ---------------------------------------------------------------------------
// Failure threshold
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD = 0.2;

export function checkFailureThreshold(
  result: ProfilingResult,
  force: boolean
): { shouldAbort: boolean; failureRate: number } {
  if (result.errors.length === 0) return { shouldAbort: false, failureRate: 0 };
  const total = result.profiles.length + result.errors.length;
  const failureRate = result.errors.length / total;
  return { shouldAbort: failureRate > FAILURE_THRESHOLD && !force, failureRate };
}

export function logProfilingErrors(errors: ProfileError[], total: number, log: ProfileLogger = defaultLog): void {
  if (total === 0) return;
  const pct = Math.round((errors.length / total) * 100);
  log.warn(
    { errorCount: errors.length, total, pct, tables: errors.slice(0, 5).map((e) => e.table) },
    `${errors.length}/${total} tables (${pct}%) failed to profile`,
  );
  for (const e of errors.slice(0, 5)) {
    log.warn({ table: e.table }, e.error);
  }
  if (errors.length > 5) {
    log.warn({ remaining: errors.length - 5 }, `... and ${errors.length - 5} more`);
  }
}

// ---------------------------------------------------------------------------
// Mechanical generator (relocated to ./semantic/generate, issue #3233)
// ---------------------------------------------------------------------------
//
// Profile analysis + YAML generation now live in the shared semantic engine so
// the CLI (`atlas init`) and the web wizard call one implementation. These
// re-exports preserve the historical `@atlas/api/lib/profiler` surface for
// existing consumers (cli/bin/atlas.ts, cli/lib/diff.ts, the profiler test
// suites); new callers import from `@atlas/api/lib/semantic/generate` directly.

export {
  isView,
  isMatView,
  mapSalesforceFieldType,
  inferForeignKeys,
  detectAbandonedTables,
  detectEnumInconsistency,
  detectDenormalizedTables,
  analyzeTableProfiles,
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
} from "./semantic/generate";

// ---------------------------------------------------------------------------
// Output directory helpers
// ---------------------------------------------------------------------------

import * as path from "path";
import { GROUPS_DIR } from "./semantic/scanner";

const SEMANTIC_DIR = path.resolve("semantic");

/** Root for a (possibly org-scoped) semantic layer. */
function semanticBaseDir(orgId?: string): string {
  if (!orgId) return SEMANTIC_DIR;
  // orgId becomes a path segment under `.orgs/`; a value like `../../outside`
  // (e.g. from --org / ATLAS_ORG_ID) would escape the semantic root. Same guard
  // sync.ts:getSemanticRoot already applies on the read side.
  assertSafePathSegment(orgId, "org");
  return path.join(SEMANTIC_DIR, ".orgs", orgId);
}

/**
 * @deprecated Writes the pre-ADR-0012 per-source `semantic/<id>/` layout.
 * New generation routes through {@link outputDirForGroup} (the canonical
 * `groups/<group>/` namespace). Retained for back-compat consumers.
 */
export function outputDirForDatasource(id: string, orgId?: string): string {
  const base = semanticBaseDir(orgId);
  return id === "default" ? base : path.join(base, id);
}

/**
 * Canonical ADR-0012 output base for a Connection group's semantic layer.
 *
 * - The **default group** (`undefined` / `null` / `"default"`, i.e.
 *   `connection_group_id = NULL`) stays **flat at the root** so single-DB
 *   setups gain no nesting.
 * - A **non-default group** `<g>` lives under the dedicated
 *   `groups/<g>/` namespace — exactly what the #3232 loader
 *   (`getEntityDirs` in `./semantic/scanner`) reads back as group `<g>`, so
 *   generation and loading can't drift on the layout (#3234).
 *
 * Unlike the deprecated {@link outputDirForDatasource} (a bare
 * `semantic/<id>/` dir), this writes the blessed `groups/` parent.
 *
 * @throws if `group` contains a path separator or `..` traversal — group
 *   names become a directory segment, so an unsafe value could escape the
 *   semantic root.
 */
export function outputDirForGroup(group: string | null | undefined, orgId?: string): string {
  const base = semanticBaseDir(orgId);
  if (!group || group === "default") return base;
  assertSafePathSegment(group, "group");
  return path.join(base, GROUPS_DIR, group);
}

/**
 * Reject a group/org name that would escape (or rename) its directory. The
 * value becomes a single path segment, so separators and `..` traversal are
 * not allowed.
 */
function assertSafePathSegment(value: string, kind: "group" | "org"): void {
  if (value !== path.basename(value) || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid semantic ${kind} name: "${value}". ${kind === "group" ? "Group" : "Org"} names cannot contain path separators or "..".`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL profiler — list objects and profile tables
// ---------------------------------------------------------------------------

/**
 * Options for the native PostgreSQL/MySQL profilers — the SAME single-options
 * shape the unified profiler seam ({@link DatasourceProfiler}) uses, so a native
 * profiler IS a `DatasourceProfiler` (no positional→options adapter shim at any
 * call site: MCP `resolveProfiler`, the wizard's env-var byproduct, the CLI).
 */
export interface NativeListObjectsOptions {
  url: string;
  /** PostgreSQL schema (defaults to `"public"`). Ignored by MySQL. */
  schema?: string;
  logger?: ProfileLogger;
}
export interface NativeProfileOptions extends NativeListObjectsOptions {
  selectedTables?: string[];
  prefetchedObjects?: DatabaseObject[];
  progress?: ProfileProgressCallbacks;
}

export async function listPostgresObjects({ url, schema = "public", logger: log = defaultLog }: NativeListObjectsOptions): Promise<DatabaseObject[]> {
  const connectionString = url;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`,
      [schema]
    );
    const objects: DatabaseObject[] = result.rows.map((r: { table_name: string; table_type: string }) => ({
      name: r.table_name,
      type: r.table_type === "VIEW" ? "view" as const : "table" as const,
    }));

    try {
      const matviewResult = await pool.query(
        `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'm'
         ORDER BY c.relname`,
        [schema]
      );
      for (const r of matviewResult.rows as { table_name: string }[]) {
        objects.push({ name: r.table_name, type: "materialized_view" });
      }
    } catch (mvErr) {
      if (isFatalConnectionError(mvErr)) throw mvErr;
      log.warn({ err: mvErr instanceof Error ? mvErr.message : String(mvErr) }, "Could not discover materialized views");
    }

    return objects.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await pool.end().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Postgres pool cleanup warning");
    });
  }
}

export async function listMySQLObjects({ url, logger: log = defaultLog }: NativeListObjectsOptions): Promise<DatabaseObject[]> {
  const connectionString = url;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    uri: connectionString,
    connectionLimit: 1,
    connectTimeout: 5000,
  });
  try {
    const [rows] = await pool.execute(
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_NAME`
    );
    return (rows as { TABLE_NAME: string; TABLE_TYPE: string }[]).map((r) => ({
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE === "VIEW" ? "view" as const : "table" as const,
    }));
  } finally {
    await pool.end().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "MySQL pool cleanup warning");
    });
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL profiler — full table profiling
// ---------------------------------------------------------------------------

/** Schema-qualified table reference for SQL queries. */
function pgTableRef(tableName: string, schema: string): string {
  const safeTable = tableName.replace(/"/g, '""');
  const safeSchema = schema.replace(/"/g, '""');
  return schema === "public" ? `"${safeTable}"` : `"${safeSchema}"."${safeTable}"`;
}

async function queryPrimaryKeys(
  pool: import("pg").Pool,
  tableName: string,
  schema: string = "public"
): Promise<string[]> {
  const result = await pool.query(
    `
    SELECT a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'p'
      AND c.conrelid = $1::regclass
    ORDER BY a.attnum
    `,
    [pgTableRef(tableName, schema)]
  );
  return result.rows.map((r: { column_name: string }) => r.column_name);
}

async function queryForeignKeys(
  pool: import("pg").Pool,
  tableName: string,
  schema: string = "public"
): Promise<ForeignKey[]> {
  const result = await pool.query(
    `
    SELECT
      a.attname AS from_column,
      cl.relname AS to_table,
      af.attname AS to_column,
      ns.nspname AS to_schema
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    JOIN pg_class cl ON cl.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = ANY(c.confkey)
    WHERE c.contype = 'f'
      AND c.conrelid = $1::regclass
    ORDER BY a.attnum
    `,
    [pgTableRef(tableName, schema)]
  );
  return result.rows.map((r: { from_column: string; to_table: string; to_column: string; to_schema: string }) => ({
    from_column: r.from_column,
    to_table: r.to_schema !== schema ? `${r.to_schema}.${r.to_table}` : r.to_table,
    to_column: r.to_column,
    source: "constraint" as const,
  }));
}

/** Map a PostgreSQL `pg_am.amname` (or MySQL pseudo-type) to our index vocabulary. */
function normalizeIndexType(amname: string | null | undefined): IndexType {
  switch ((amname ?? "").toLowerCase()) {
    case "btree":
      return "btree";
    case "gin":
      return "gin";
    case "gist":
    case "spgist":
      return "gist";
    case "brin":
      return "brin";
    case "hash":
      return "hash";
    default:
      return "other";
  }
}

/**
 * Harvest index metadata for one Postgres table (#3634).
 *
 * Keyed by `regclass` so it works for any schema-qualified table. Each index's
 * member columns are rendered one-by-one via `pg_get_indexdef(indexrelid, n,
 * true)` so composite ORDER survives and expression-index members (e.g.
 * `lower(email)`) come back as their definition text rather than vanishing —
 * `pg_index.indkey` would render expression members as `0`. Partial-index
 * predicates come from `pg_get_expr(indpred, indrelid)`.
 *
 * Returns ONLY the catalog facts; the leading-vs-trailing sargability marker is
 * derived later in `analyzeTableProfiles`, not here.
 *
 * `serverVersionNum` (from `SHOW server_version_num`) selects the key-column
 * count: `indnkeyatts` (PG 11+, excludes INCLUDE/covering columns so they aren't
 * mistaken for sargable members) when available, else `indnatts` — older servers
 * have no INCLUDE feature, so `indnatts` equals the key count there. A 0/unknown
 * version falls back to the portable `indnatts`, so harvest never throws on the
 * column reference (it would otherwise be lost to the fail-soft catch).
 */
// Exported for DB-free unit coverage of the version-branch column selection and
// the row→IndexProfile mapping (profiler-index-harvest-unit.test.ts); the
// live-Postgres path is covered separately by profiler-index-harvest-pg.test.ts.
export async function queryPostgresIndexes(
  pool: import("pg").Pool,
  tableName: string,
  schema: string = "public",
  serverVersionNum: number = 0
): Promise<IndexProfile[]> {
  // `indnkeyatts` only exists on PG 11+; reference it only when we know we're on
  // 11+. The value is a controlled internal constant, never user input.
  const keyCountCol = serverVersionNum >= 110000 ? "ix.indnkeyatts" : "ix.indnatts";
  const result = await pool.query(
    `
    SELECT
      ic.relname AS index_name,
      am.amname AS index_type,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      (ix.indpred IS NOT NULL) AS is_partial,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      ${keyCountCol} AS key_count,
      ARRAY(
        SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
        FROM generate_series(0, ${keyCountCol} - 1) AS k
      ) AS key_defs
    FROM pg_index ix
    JOIN pg_class ic ON ic.oid = ix.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    WHERE ix.indrelid = $1::regclass
      AND ix.indislive
    ORDER BY ic.relname
    `,
    [pgTableRef(tableName, schema)]
  );

  return result.rows.map(
    (r: {
      index_name: string;
      index_type: string | null;
      is_unique: boolean;
      is_primary: boolean;
      is_partial: boolean;
      predicate: string | null;
      key_defs: string[];
    }) => ({
      name: r.index_name,
      // key_defs is already ordered (generate_series 0..n-1); each entry is the
      // rendered column or expression text for that index position.
      columns: (r.key_defs ?? []).map((d) => d.trim()).filter((d) => d.length > 0),
      index_type: normalizeIndexType(r.index_type),
      is_unique: r.is_unique,
      is_primary: r.is_primary,
      is_partial: r.is_partial,
      predicate: r.is_partial ? r.predicate : null,
    })
  );
}

export async function profilePostgres({
  url,
  schema = "public",
  selectedTables: filterTables,
  prefetchedObjects,
  progress,
  logger: log = defaultLog,
}: NativeProfileOptions): Promise<ProfilingResult> {
  const connectionString = url;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 3 });
  try {
  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  // Detect the server version once so the per-table index harvest can pick
  // `indnkeyatts` (PG 11+) vs the portable `indnatts` (#3634). Fail-soft: an
  // unknown version (0) falls back to `indnatts`, which exists on every server.
  let pgServerVersionNum = 0;
  try {
    const verRes = await pool.query(`SHOW server_version_num`);
    const verVal = (verRes.rows[0] as { server_version_num?: string } | undefined)?.server_version_num;
    pgServerVersionNum = Number.parseInt(verVal ?? "0", 10) || 0;
  } catch (verErr) {
    if (isFatalConnectionError(verErr)) throw verErr;
    log.warn(
      { err: verErr instanceof Error ? verErr.message : String(verErr) },
      "Could not read server_version_num — index harvest falls back to indnatts"
    );
  }

  let allObjects: DatabaseObject[];
  if (prefetchedObjects) {
    allObjects = prefetchedObjects;
  } else {
    const tablesResult = await pool.query(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`,
      [schema]
    );
    allObjects = tablesResult.rows.map((r: { table_name: string; table_type: string }) => ({
      name: r.table_name,
      type: r.table_type === "VIEW" ? "view" as const : "table" as const,
    }));

    try {
      const matviewResult = await pool.query(
        `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'm'
         ORDER BY c.relname`,
        [schema]
      );
      for (const r of matviewResult.rows as { table_name: string }[]) {
        allObjects.push({ name: r.table_name, type: "materialized_view" });
      }
    } catch (mvErr) {
      if (isFatalConnectionError(mvErr)) throw mvErr;
      log.warn({ err: mvErr instanceof Error ? mvErr.message : String(mvErr) }, "Could not discover materialized views");
    }
    allObjects.sort((a, b) => a.name.localeCompare(b.name));
  }

  const objectsToProfile = filterTables
    ? allObjects.filter((o) => filterTables.includes(o.name))
    : allObjects;

  progress?.onStart(objectsToProfile.length);

  for (const [i, obj] of objectsToProfile.entries()) {
    const table_name = obj.name;
    const objectType = obj.type;
    const objectLabel = objectType === "view" ? " [view]" : objectType === "materialized_view" ? " [matview]" : "";
    if (progress) {
      progress.onTableStart(table_name + objectLabel, i, objectsToProfile.length);
    } else {
      log.info({ table: table_name, index: i + 1, total: objectsToProfile.length }, `Profiling ${table_name}${objectLabel}`);
    }

    try {
      let matview_populated: boolean | undefined;
      if (objectType === "materialized_view") {
        try {
          const mvResult = await pool.query(
            `SELECT ispopulated FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2`,
            [schema, table_name]
          );
          if (mvResult.rows.length > 0) {
            matview_populated = mvResult.rows[0].ispopulated;
          }
        } catch (mvErr) {
          if (isFatalConnectionError(mvErr)) throw mvErr;
          log.warn({ err: mvErr instanceof Error ? mvErr.message : String(mvErr), table: table_name }, "Could not read matview status");
        }
      }

      let rowCount: number;
      if (matview_populated === false) {
        rowCount = 0;
        log.info({ table: table_name }, "Materialized view is not populated — skipping data profiling");
      } else {
        const countResult = await pool.query(
          `SELECT COUNT(*) as c FROM ${pgTableRef(table_name, schema)}`
        );
        rowCount = parseInt(countResult.rows[0].c, 10);
      }

      let primaryKeyColumns: string[] = [];
      let foreignKeys: ForeignKey[] = [];
      let indexes: IndexProfile[] = [];
      if (objectType === "table") {
        try {
          primaryKeyColumns = await queryPrimaryKeys(pool, table_name, schema);
        } catch (pkErr) {
          if (isFatalConnectionError(pkErr)) throw pkErr;
          log.warn({ err: pkErr instanceof Error ? pkErr.message : String(pkErr), table: table_name }, "Could not read PK constraints");
        }
        try {
          foreignKeys = await queryForeignKeys(pool, table_name, schema);
        } catch (fkErr) {
          if (isFatalConnectionError(fkErr)) throw fkErr;
          log.warn({ err: fkErr instanceof Error ? fkErr.message : String(fkErr), table: table_name }, "Could not read FK constraints");
        }
        try {
          indexes = await queryPostgresIndexes(pool, table_name, schema, pgServerVersionNum);
        } catch (idxErr) {
          if (isFatalConnectionError(idxErr)) throw idxErr;
          // Fail soft: index metadata is an optimization hint, never required to
          // profile the table — warn and continue (#3634).
          log.warn({ err: idxErr instanceof Error ? idxErr.message : String(idxErr), table: table_name }, "Could not read index metadata");
        }
      }

      const fkLookup = new Map(
        foreignKeys.map((fk) => [fk.from_column, fk])
      );

      const colResult = objectType === "materialized_view"
        ? await pool.query(
            `
            SELECT a.attname AS column_name,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                   CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $2
              AND c.relname = $1
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum
          `,
            [table_name, schema]
          )
        : await pool.query(
            `
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = $2
            ORDER BY ordinal_position
          `,
            [table_name, schema]
          );

      const columns: ColumnProfile[] = [];

      for (const col of colResult.rows) {
        let unique_count: number | null = null;
        let null_count: number | null = null;
        let sample_values: string[] = [];
        let isEnumLike = false;
        const colNotes: string[] = [];

        const isPK = primaryKeyColumns.includes(col.column_name);
        const fkInfo = fkLookup.get(col.column_name);
        const isFK = !!fkInfo;

        if (matview_populated !== false) {
          try {
            const tableRef = pgTableRef(table_name, schema);
            const uq = await pool.query(
              `SELECT COUNT(DISTINCT "${col.column_name}") as c FROM ${tableRef}`
            );
            unique_count = parseInt(uq.rows[0].c, 10);

            const nc = await pool.query(
              `SELECT COUNT(*) as c FROM ${tableRef} WHERE "${col.column_name}" IS NULL`
            );
            null_count = parseInt(nc.rows[0].c, 10);

            const isTextType =
              col.data_type === "text" ||
              col.data_type === "character varying" ||
              col.data_type === "character";
            isEnumLike =
              isTextType &&
              unique_count !== null &&
              unique_count < 20 &&
              rowCount > 0 &&
              unique_count / rowCount <= 0.05;

            const sampleLimit = isEnumLike ? 100 : 10;
            const sv = await pool.query(
              `SELECT DISTINCT "${col.column_name}" as v FROM ${tableRef} WHERE "${col.column_name}" IS NOT NULL ORDER BY "${col.column_name}" LIMIT ${sampleLimit}`
            );
            sample_values = sv.rows.map((r: { v: unknown }) => String(r.v));
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            log.warn({ err: colErr instanceof Error ? colErr.message : String(colErr), table: table_name, column: col.column_name }, "Could not profile column");
            // Mark the degraded column so a missing stats/samples set reads as
            // "introspection failed" rather than a genuinely empty column —
            // matches the plugin-profiler discipline restored in #3676.
            colNotes.push("Column statistics unavailable (introspection query failed).");
          }
        }

        columns.push({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === "YES",
          unique_count,
          null_count,
          sample_values,
          is_primary_key: isPK,
          is_foreign_key: isFK,
          fk_target_table: fkInfo?.to_table ?? null,
          fk_target_column: fkInfo?.to_column ?? null,
          is_enum_like: isEnumLike,
          profiler_notes: colNotes,
        });
      }

      profiles.push({
        table_name,
        object_type: objectType,
        row_count: rowCount,
        columns,
        primary_key_columns: primaryKeyColumns,
        foreign_keys: foreignKeys,
        inferred_foreign_keys: [],
        indexes,
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        ...(matview_populated !== undefined ? { matview_populated } : {}),
      });
      progress?.onTableDone(table_name, i, objectsToProfile.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isFatalConnectionError(err)) {
        throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
      }
      if (progress) {
        progress.onTableError(table_name, msg, i, objectsToProfile.length);
      } else {
        log.warn({ err: msg, table: table_name }, "Failed to profile table");
      }
      errors.push({ table: table_name, error: msg });
      continue;
    }
  }

  // Batch-query partition metadata
  const partitionMap = new Map<string, { strategy: "range" | "list" | "hash"; key: string }>();
  try {
    const partResult = await pool.query(
      `SELECT c.relname,
              CASE pt.partstrat WHEN 'r' THEN 'range' WHEN 'l' THEN 'list' WHEN 'h' THEN 'hash' ELSE pt.partstrat END as strategy,
              pg_get_partkeydef(c.oid) as partition_key
       FROM pg_partitioned_table pt
       JOIN pg_class c ON c.oid = pt.partrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1`,
      [schema]
    );

    for (const r of partResult.rows as { relname: string; strategy: string; partition_key: string }[]) {
      if (r.strategy !== "range" && r.strategy !== "list" && r.strategy !== "hash") {
        log.warn({ table: r.relname, strategy: r.strategy }, "Unrecognized partition strategy — skipping");
        continue;
      }
      partitionMap.set(r.relname, { strategy: r.strategy, key: r.partition_key });
    }
  } catch (partErr) {
    if (isFatalConnectionError(partErr)) throw partErr;
    log.warn({ err: partErr instanceof Error ? partErr.message : String(partErr) }, "Could not read partition metadata");
  }

  const childrenMap = new Map<string, string[]>();
  try {
    const childResult = await pool.query(
      `SELECT p.relname as parent, c.relname as child
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = $1
       ORDER BY p.relname, c.relname`,
      [schema]
    );
    for (const r of childResult.rows as { parent: string; child: string }[]) {
      const children = childrenMap.get(r.parent) ?? [];
      children.push(r.child);
      childrenMap.set(r.parent, children);
    }
  } catch (childErr) {
    if (isFatalConnectionError(childErr)) throw childErr;
    log.warn({ err: childErr instanceof Error ? childErr.message : String(childErr) }, "Could not read partition children");
  }

  for (const profile of profiles) {
    const partInfo = partitionMap.get(profile.table_name);
    if (partInfo) {
      profile.partition_info = {
        strategy: partInfo.strategy,
        key: partInfo.key,
        children: childrenMap.get(profile.table_name) ?? [],
      };
    }
  }

  return { profiles, errors };
  } finally {
    await pool.end().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Postgres pool cleanup warning");
    });
  }
}

// ---------------------------------------------------------------------------
// MySQL profiler — full table profiling
// ---------------------------------------------------------------------------

/** Backtick-quoted MySQL identifier with embedded backticks escaped. */
export function mysqlQuoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

async function queryMySQLPrimaryKeys(
  pool: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  tableName: string,
): Promise<string[]> {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return (rows as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME);
}

async function queryMySQLForeignKeys(
  pool: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  tableName: string,
): Promise<ForeignKey[]> {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return (rows as { COLUMN_NAME: string; REFERENCED_TABLE_NAME: string; REFERENCED_COLUMN_NAME: string }[]).map((r) => ({
    from_column: r.COLUMN_NAME,
    to_table: r.REFERENCED_TABLE_NAME,
    to_column: r.REFERENCED_COLUMN_NAME,
    source: "constraint" as const,
  }));
}

/**
 * Map a MySQL `information_schema.STATISTICS.INDEX_TYPE` to our vocabulary
 * (#3634). MySQL has no partial indexes, so harvested indexes never carry a
 * predicate. FULLTEXT/SPATIAL map onto gin/gist so the agent sees a consistent
 * "non-btree, position-independent" signal.
 */
function mysqlIndexType(indexType: string | null | undefined): IndexType {
  switch ((indexType ?? "").toUpperCase()) {
    case "BTREE":
      return "btree";
    case "HASH":
      return "hash";
    case "FULLTEXT":
      return "gin";
    case "SPATIAL":
      return "gist";
    default:
      return "other";
  }
}

/**
 * Harvest index metadata for one MySQL table (#3634).
 *
 * `information_schema.STATISTICS` returns one row per (index, column); we group
 * by `INDEX_NAME` and order members by `SEQ_IN_INDEX` so composite order
 * survives. `NON_UNIQUE = 0` means unique; the implicit `PRIMARY` index is
 * flagged `is_primary`. MySQL has no partial indexes (`is_partial: false`,
 * `predicate: null`).
 */
// Exported for DB-free unit coverage of functional/expression key-part skipping
// and the row-grouping logic (profiler-index-harvest-unit.test.ts); the
// live-MySQL path is covered separately by profiler-index-harvest-mysql.test.ts.
export async function queryMySQLIndexes(
  pool: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  tableName: string,
  log: ProfileLogger = defaultLog,
): Promise<IndexProfile[]> {
  const [rows] = await pool.execute(
    `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [tableName]
  );

  // Group ordered rows into one IndexProfile per INDEX_NAME, preserving the
  // first-seen index order (rows already ordered by INDEX_NAME, SEQ_IN_INDEX).
  const grouped = new Map<string, IndexProfile>();
  let skippedExpressionParts = 0;
  for (const r of rows as {
    INDEX_NAME: string;
    COLUMN_NAME: string | null;
    NON_UNIQUE: number;
    INDEX_TYPE: string | null;
  }[]) {
    // Expression/functional index parts report a null COLUMN_NAME (MySQL 8.0.13+
    // functional key parts); skip them rather than emit an empty member. A wholly
    // functional index thus drops out of indexes[] — trace the count so the
    // omission is visible rather than silent.
    if (r.COLUMN_NAME == null) {
      skippedExpressionParts++;
      continue;
    }
    let idx = grouped.get(r.INDEX_NAME);
    if (!idx) {
      idx = {
        name: r.INDEX_NAME,
        columns: [],
        index_type: mysqlIndexType(r.INDEX_TYPE),
        is_unique: Number(r.NON_UNIQUE) === 0,
        is_primary: r.INDEX_NAME === "PRIMARY",
        is_partial: false,
        predicate: null,
      };
      grouped.set(r.INDEX_NAME, idx);
    }
    idx.columns.push(r.COLUMN_NAME);
  }
  if (skippedExpressionParts > 0) {
    log.debug?.(
      { table: tableName, skippedExpressionParts },
      "Skipped functional/expression index key parts (null COLUMN_NAME) during MySQL index harvest"
    );
  }
  return [...grouped.values()];
}

export async function profileMySQL({
  url,
  selectedTables: filterTables,
  prefetchedObjects,
  progress,
  logger: log = defaultLog,
}: NativeProfileOptions): Promise<ProfilingResult> {
  const connectionString = url;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    uri: connectionString,
    connectionLimit: 3,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      const [tablesRows] = await pool.execute(
        `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
         ORDER BY TABLE_NAME`
      );
      allObjects = (tablesRows as { TABLE_NAME: string; TABLE_TYPE: string }[]).map((r) => ({
        name: r.TABLE_NAME,
        type: r.TABLE_TYPE === "VIEW" ? "view" as const : "table" as const,
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
        progress.onTableStart(table_name + objectLabel, i, objectsToProfile.length);
      } else {
        log.info({ table: table_name, index: i + 1, total: objectsToProfile.length }, `Profiling ${table_name}${objectLabel}`);
      }

      try {
        const [countRows] = await pool.execute(
          `SELECT COUNT(*) as c FROM ${mysqlQuoteIdent(table_name)}`
        );
        const rowCount = parseInt(String((countRows as { c: number }[])[0].c), 10);

        let primaryKeyColumns: string[] = [];
        let foreignKeys: ForeignKey[] = [];
        let indexes: IndexProfile[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await queryMySQLPrimaryKeys(pool, table_name);
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            log.warn({ err: pkErr instanceof Error ? pkErr.message : String(pkErr), table: table_name }, "Could not read PK constraints");
          }
          try {
            foreignKeys = await queryMySQLForeignKeys(pool, table_name);
          } catch (fkErr) {
            if (isFatalConnectionError(fkErr)) throw fkErr;
            log.warn({ err: fkErr instanceof Error ? fkErr.message : String(fkErr), table: table_name }, "Could not read FK constraints");
          }
          try {
            indexes = await queryMySQLIndexes(pool, table_name, log);
          } catch (idxErr) {
            if (isFatalConnectionError(idxErr)) throw idxErr;
            // Fail soft: index metadata is an optimization hint (#3634).
            log.warn({ err: idxErr instanceof Error ? idxErr.message : String(idxErr), table: table_name }, "Could not read index metadata");
          }
        }

        const fkLookup = new Map(
          foreignKeys.map((fk) => [fk.from_column, fk])
        );

        const [colRows] = await pool.execute(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_TYPE
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [table_name]
        );

        const columns: ColumnProfile[] = [];

        for (const col of colRows as { COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string; COLUMN_TYPE: string }[]) {
          let unique_count: number | null = null;
          let null_count: number | null = null;
          let sample_values: string[] = [];
          let isEnumLike = false;
          const colNotes: string[] = [];

          const isPK = primaryKeyColumns.includes(col.COLUMN_NAME);
          const fkInfo = fkLookup.get(col.COLUMN_NAME);
          const isFK = !!fkInfo;

          try {
            const [uqRows] = await pool.execute(
              `SELECT COUNT(DISTINCT ${mysqlQuoteIdent(col.COLUMN_NAME)}) as c FROM ${mysqlQuoteIdent(table_name)}`
            );
            unique_count = parseInt(String((uqRows as { c: number }[])[0].c), 10);

            const [ncRows] = await pool.execute(
              `SELECT COUNT(*) as c FROM ${mysqlQuoteIdent(table_name)} WHERE ${mysqlQuoteIdent(col.COLUMN_NAME)} IS NULL`
            );
            null_count = parseInt(String((ncRows as { c: number }[])[0].c), 10);

            const dataType = col.DATA_TYPE.toLowerCase();
            const isTextType =
              dataType === "varchar" ||
              dataType === "char" ||
              dataType === "text" ||
              dataType === "tinytext" ||
              dataType === "mediumtext" ||
              dataType === "longtext" ||
              dataType === "enum" ||
              dataType === "set";
            isEnumLike =
              isTextType &&
              unique_count !== null &&
              unique_count < 20 &&
              rowCount > 0 &&
              unique_count / rowCount <= 0.05;

            const sampleLimit = isEnumLike ? 100 : 10;
            const [svRows] = await pool.execute(
              `SELECT DISTINCT ${mysqlQuoteIdent(col.COLUMN_NAME)} as v FROM ${mysqlQuoteIdent(table_name)} WHERE ${mysqlQuoteIdent(col.COLUMN_NAME)} IS NOT NULL ORDER BY ${mysqlQuoteIdent(col.COLUMN_NAME)} LIMIT ${sampleLimit}`
            );
            sample_values = (svRows as { v: unknown }[]).map((r) => String(r.v));
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            log.warn({ err: colErr instanceof Error ? colErr.message : String(colErr), table: table_name, column: col.COLUMN_NAME }, "Could not profile column");
            // Mark the degraded column so a missing stats/samples set reads as
            // "introspection failed" rather than a genuinely empty column —
            // matches the plugin-profiler discipline restored in #3676.
            colNotes.push("Column statistics unavailable (introspection query failed).");
          }

          columns.push({
            name: col.COLUMN_NAME,
            type: col.DATA_TYPE,
            nullable: col.IS_NULLABLE === "YES",
            unique_count,
            null_count,
            sample_values,
            is_primary_key: isPK,
            is_foreign_key: isFK,
            fk_target_table: fkInfo?.to_table ?? null,
            fk_target_column: fkInfo?.to_column ?? null,
            is_enum_like: isEnumLike,
            profiler_notes: colNotes,
          });
        }

        profiles.push({
          table_name,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: primaryKeyColumns,
          foreign_keys: foreignKeys,
          inferred_foreign_keys: [],
          indexes,
          profiler_notes: [],
          table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        });
        progress?.onTableDone(table_name, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isFatalConnectionError(err) || /PROTOCOL_CONNECTION_LOST|ER_SERVER_SHUTDOWN|ER_NET_READ_ERROR|ER_NET_WRITE_ERROR/i.test(msg)) {
          throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
        }
        if (progress) {
          progress.onTableError(table_name, msg, i, objectsToProfile.length);
        } else {
          log.warn({ err: msg, table: table_name }, "Failed to profile table");
        }
        errors.push({ table: table_name, error: msg });
        continue;
      }
    }
  } finally {
    await pool.end().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "MySQL pool cleanup warning");
    });
  }

  return { profiles, errors };
}
