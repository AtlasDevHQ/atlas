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
} from "@useatlas/types";

// Also import locally for use within this module's function signatures.
import type {
  ColumnProfile,
  DatabaseObject,
  ForeignKey,
  TableProfile,
  ProfileError,
  ProfilingResult,
} from "@useatlas/types";

/** Minimal structured logger interface — compatible with pino's (obj, msg) calling convention. */
export interface ProfileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
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

export async function listPostgresObjects(connectionString: string, schema: string = "public", log: ProfileLogger = defaultLog): Promise<DatabaseObject[]> {
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

export async function listMySQLObjects(connectionString: string, log: ProfileLogger = defaultLog): Promise<DatabaseObject[]> {
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

export async function profilePostgres(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  schema: string = "public",
  progress?: ProfileProgressCallbacks,
  log: ProfileLogger = defaultLog,
): Promise<ProfilingResult> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 3 });
  try {
  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

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
          profiler_notes: [],
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

export async function profileMySQL(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
  log: ProfileLogger = defaultLog,
): Promise<ProfilingResult> {
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
            profiler_notes: [],
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
