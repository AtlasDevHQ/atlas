#!/usr/bin/env tsx
/**
 * Atlas CLI — auto-generate semantic layer, detect schema drift, and query your data.
 *
 * Discovers and profiles tables, views, and materialized views. Views and materialized
 * views get object_type "view"/"materialized_view" in their profiles, skip
 * PK/FK/measures/query_patterns generation, and are excluded from heuristics
 * (abandoned, denormalized) and FK inference.
 *
 * Usage:
 *   bun run atlas -- init                        # Profile DB tables & views, generate semantic layer
 *   bun run atlas -- init --tables t1,t2         # Only specific tables/views (skip interactive picker)
 *   bun run atlas -- init --schema analytics     # Profile a non-public PostgreSQL schema
 *   bun run atlas -- init --enrich               # Profile + LLM enrichment (needs API key)
 *   bun run atlas -- init --no-enrich            # Explicitly skip LLM enrichment
 *   bun run atlas -- init --source warehouse      # Write to semantic/warehouse/ (per-source layout)
 *   bun run atlas -- init --csv data.csv          # Load CSV via DuckDB, auto-profile
 *   bun run atlas -- init --parquet file.parquet  # Load Parquet via DuckDB, auto-profile
 *   bun run atlas -- init --csv a.csv,b.csv      # Multiple CSV files
 *   bun run atlas -- init --demo                 # Load simple demo dataset then profile
 *   bun run atlas -- init --demo cybersec        # Load cybersec demo (62 tables) then profile
 *   bun run atlas -- query "top 5 customers"      # Ask a question via the API
 *   bun run atlas -- query "active alerts" --json # Raw JSON output
 *   bun run atlas -- query "count of users" --csv # CSV output (pipe-friendly)
 *   bun run atlas -- query "alerts" --connection cybersec  # Query a specific datasource
 *   bun run atlas -- query "count of users" --quiet        # Data only, no narrative
 *   bun run atlas -- diff                        # Compare DB against semantic layer
 *   bun run atlas -- diff --tables t1,t2         # Diff only specific tables/views
 *   bun run atlas -- diff --schema analytics     # Diff a non-public PostgreSQL schema
 *   bun run atlas -- diff --source warehouse     # Diff from semantic/warehouse/ subdirectory
 *   bun run atlas -- doctor                      # Validate environment and connectivity
 *
 * When run in a TTY without --tables or --demo, an interactive multiselect picker
 * lets you choose which tables and views to profile. --demo skips the picker since
 * the demo dataset defines its own tables. In non-TTY environments (CI/piped), all
 * tables and views are profiled automatically.
 *
 * Requires ATLAS_DATASOURCE_URL in environment.
 * Supports PostgreSQL (postgresql://...) and MySQL (mysql://...).
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { type DBType } from "@atlas/api/lib/db/connection";
import { checkEnvFile } from "../src/env-check";
import { type ProfileProgressCallbacks, createProgressTracker, formatDuration } from "../src/progress";

/** CLI-local DB type detection — supports all URL schemes (core + plugin databases). */
function detectDBType(url: string): DBType {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "postgres";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "mysql";
  if (url.startsWith("clickhouse://") || url.startsWith("clickhouses://")) return "clickhouse";
  if (url.startsWith("snowflake://")) return "snowflake";
  if (url.startsWith("duckdb://")) return "duckdb";
  if (url.startsWith("salesforce://")) return "salesforce";
  const scheme = url.split("://")[0] || "(empty)";
  throw new Error(
    `Unsupported database URL scheme "${scheme}://". ` +
    "Supported: postgresql://, mysql://, clickhouse://, snowflake://, duckdb://, salesforce://."
  );
}
// Lazy-loaded to avoid requiring native bindings at type-check time
async function loadDuckDB() {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  return DuckDBInstance;
}

/** Network/socket error codes indicating the database connection is down or broken — re-throw immediately to abort profiling. */
export const FATAL_ERROR_PATTERN = /\bECONNRESET\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEPIPE\b|\bETIMEDOUT\b/i;

/** Check whether an error is a fatal connection error by inspecting message, code, and cause chain. */
export function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return FATAL_ERROR_PATTERN.test(String(err));
  if (FATAL_ERROR_PATTERN.test(err.message)) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && FATAL_ERROR_PATTERN.test(code)) return true;
  if (err.cause) return isFatalConnectionError(err.cause);
  return false;
}

const SEMANTIC_DIR = path.resolve("semantic");
const ENTITIES_DIR = path.join(SEMANTIC_DIR, "entities");

// --- Interfaces ---

export type ObjectType = "table" | "view" | "materialized_view";

export interface DatabaseObject {
  name: string;
  type: ObjectType;
}

export interface ColumnProfile {
  name: string;
  type: string;
  nullable: boolean;
  unique_count: number | null;
  null_count: number | null;
  sample_values: string[];
  is_primary_key: boolean;
  is_foreign_key: boolean;
  fk_target_table: string | null;
  fk_target_column: string | null;
  is_enum_like: boolean;
  profiler_notes: string[];
}

export interface ForeignKey {
  from_column: string;
  to_table: string;
  to_column: string;
  source: "constraint" | "inferred";
}

export interface TableProfile {
  table_name: string;
  object_type: ObjectType;
  row_count: number;
  columns: ColumnProfile[];
  primary_key_columns: string[];
  foreign_keys: ForeignKey[];
  inferred_foreign_keys: ForeignKey[];
  profiler_notes: string[];
  table_flags: {
    possibly_abandoned: boolean;
    possibly_denormalized: boolean;
  };
  matview_populated?: boolean;
  partition_info?: { strategy: "range" | "list" | "hash"; key: string; children: string[] };
}

/** A table/view/object that failed to profile. */
export interface ProfileError {
  /** Name of the table, view, or object that failed to profile. */
  table: string;
  error: string;
}

/** Outcome of profiling a datasource: successful profiles + per-table errors. Each table appears in exactly one array. */
export interface ProfilingResult {
  profiles: TableProfile[];
  errors: ProfileError[];
}

const FAILURE_THRESHOLD = 0.2;

/**
 * Check whether profiling errors exceed the failure threshold.
 * Returns `{ shouldAbort, failureRate }`. Always `false` when force is set or there are no errors.
 */
export function checkFailureThreshold(
  result: ProfilingResult,
  force: boolean
): { shouldAbort: boolean; failureRate: number } {
  if (result.errors.length === 0) return { shouldAbort: false, failureRate: 0 };
  const total = result.profiles.length + result.errors.length;
  const failureRate = result.errors.length / total;
  return { shouldAbort: failureRate > FAILURE_THRESHOLD && !force, failureRate };
}

/** Log a warning summary for profiling errors (first 5 + overflow). */
export function logProfilingErrors(errors: ProfileError[], total: number): void {
  const pct = Math.round((errors.length / total) * 100);
  console.warn(
    `\nWarning: ${errors.length}/${total} tables (${pct}%) failed to profile:`
  );
  const preview = errors.slice(0, 5);
  for (const e of preview) {
    console.warn(`  - ${e.table}: ${e.error}`);
  }
  if (errors.length > 5) {
    console.warn(`  ... and ${errors.length - 5} more`);
  }
}

/** Check whether a profile represents a database view. */
export function isView(profile: TableProfile): boolean {
  return profile.object_type === "view";
}

/** Check whether a profile represents a materialized view. */
export function isMatView(profile: TableProfile): boolean {
  return profile.object_type === "materialized_view";
}

/** Check whether a profile is view-like (view or materialized view) — skip PK/FK/measures/patterns. */
export function isViewLike(profile: TableProfile): boolean {
  return profile.object_type === "view" || profile.object_type === "materialized_view";
}

// --- Shared helpers ---

const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(value: string, label: string): void {
  if (!VALID_SQL_IDENTIFIER.test(value)) {
    console.error(`Error: Invalid ${label} "${value}". Must contain only letters, digits, and underscores, and start with a letter or underscore.`);
    process.exit(1);
  }
}

function validateSchemaName(schema: string): void {
  validateIdentifier(schema, "schema name");
}

/**
 * Parse a --flag that requires a value and validate it as a safe identifier.
 * Returns the value if present, undefined if the flag was not used at all.
 * Exits with an error if the flag was used without a value or with an invalid one.
 */
function requireFlagIdentifier(args: string[], flag: string, label: string): string | undefined {
  const value = getFlag(args, flag);
  if (!value && args.includes(flag)) {
    console.error(`Error: ${flag} requires a value (e.g., ${flag} warehouse).`);
    process.exit(1);
  }
  if (value) validateIdentifier(value, label);
  return value;
}

// --- PostgreSQL profiler ---

/** Schema-qualified table reference for SQL queries. */
function pgTableRef(tableName: string, schema: string): string {
  const safeTable = tableName.replace(/"/g, '""');
  const safeSchema = schema.replace(/"/g, '""');
  return schema === "public" ? `"${safeTable}"` : `"${safeSchema}"."${safeTable}"`;
}

async function queryPrimaryKeys(
  pool: Pool,
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
  pool: Pool,
  tableName: string,
  schema: string = "public"
): Promise<ForeignKey[]> {
  const result = await pool.query(
    `
    SELECT
      a_from.attname AS from_column,
      cl_to.relname AS to_table,
      a_to.attname AS to_column,
      ns_to.nspname AS to_schema
    FROM pg_constraint c
    JOIN pg_attribute a_from
      ON a_from.attrelid = c.conrelid AND a_from.attnum = ANY(c.conkey)
    JOIN pg_class cl_to
      ON cl_to.oid = c.confrelid
    JOIN pg_namespace ns_to
      ON ns_to.oid = cl_to.relnamespace
    JOIN pg_attribute a_to
      ON a_to.attrelid = c.confrelid AND a_to.attnum = ANY(c.confkey)
    WHERE c.contype = 'f'
      AND c.conrelid = $1::regclass
    ORDER BY a_from.attname
    `,
    [pgTableRef(tableName, schema)]
  );
  return result.rows.map(
    (r: { from_column: string; to_table: string; to_column: string; to_schema: string }) => ({
      from_column: r.from_column,
      // Qualify FK target with schema when it differs from the profiled schema
      to_table: r.to_schema !== schema ? `${r.to_schema}.${r.to_table}` : r.to_table,
      to_column: r.to_column,
      source: "constraint" as const,
    })
  );
}

export async function listPostgresObjects(connectionString: string, schema: string = "public"): Promise<DatabaseObject[]> {
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

    // Materialized views are not in information_schema.tables — query pg_class directly
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
      console.warn(`  Warning: Could not discover materialized views: ${mvErr instanceof Error ? mvErr.message : String(mvErr)}`);
    }

    return objects.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await pool.end();
  }
}

export async function listMySQLObjects(connectionString: string): Promise<DatabaseObject[]> {
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
    await pool.end();
  }
}

export async function profilePostgres(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  schema: string = "public",
  progress?: ProfileProgressCallbacks
): Promise<ProfilingResult> {
  const pool = new Pool({ connectionString, max: 3 });
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

    // Materialized views are not in information_schema.tables — query pg_class directly
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
      console.warn(`  Warning: Could not discover materialized views: ${mvErr instanceof Error ? mvErr.message : String(mvErr)}`);
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
      console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${table_name}${objectLabel}...`);
    }

    try {
      // Check matview populated status BEFORE COUNT(*) — unpopulated matviews throw on scan
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
          console.warn(`    Warning: Could not read matview status for ${table_name}: ${mvErr instanceof Error ? mvErr.message : String(mvErr)}`);
        }
      }

      // Skip COUNT(*) for unpopulated matviews — they error on table scan
      let rowCount: number;
      if (matview_populated === false) {
        rowCount = 0;
        console.log(`    Materialized view ${table_name} is not populated — skipping data profiling`);
      } else {
        const countResult = await pool.query(
          `SELECT COUNT(*) as c FROM ${pgTableRef(table_name, schema)}`
        );
        rowCount = parseInt(countResult.rows[0].c, 10);
      }

      // Get primary keys and foreign keys from system catalogs (skip for views and matviews)
      let primaryKeyColumns: string[] = [];
      let foreignKeys: ForeignKey[] = [];
      if (objectType === "table") {
        try {
          primaryKeyColumns = await queryPrimaryKeys(pool, table_name, schema);
        } catch (pkErr) {
          if (isFatalConnectionError(pkErr)) throw pkErr;
          console.warn(`    Warning: Could not read PK constraints for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`);
        }
        try {
          foreignKeys = await queryForeignKeys(pool, table_name, schema);
        } catch (fkErr) {
          if (isFatalConnectionError(fkErr)) throw fkErr;
          console.warn(`    Warning: Could not read FK constraints for ${table_name}: ${fkErr instanceof Error ? fkErr.message : String(fkErr)}`);
        }
      }

      const fkLookup = new Map(
        foreignKeys.map((fk) => [fk.from_column, fk])
      );

      // information_schema.columns excludes materialized views in PostgreSQL,
      // so use pg_attribute + pg_type for matviews (#255)
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

        // Skip data profiling for unpopulated matviews — no data to scan
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

            // For enum-like columns, get ALL distinct values; otherwise sample 10
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
            console.warn(`    Warning: Could not profile column ${table_name}.${col.column_name}: ${colErr instanceof Error ? colErr.message : String(colErr)}`);
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
      // Fail fast on connection-level errors that will affect all remaining tables
      if (isFatalConnectionError(err)) {
        throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
      }
      if (progress) {
        progress.onTableError(table_name, msg, i, objectsToProfile.length);
      } else {
        console.error(`  Warning: Failed to profile ${table_name}: ${msg}`);
      }
      errors.push({ table: table_name, error: msg });
      continue;
    }
  }

  // Batch-query partition metadata and attach to profiled tables
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
        console.warn(`  Warning: Unrecognized partition strategy '${r.strategy}' for ${r.relname} — skipping`);
        continue;
      }
      partitionMap.set(r.relname, { strategy: r.strategy, key: r.partition_key });
    }
  } catch (partErr) {
    if (isFatalConnectionError(partErr)) throw partErr;
    console.warn(`  Warning: Could not read partition metadata: ${partErr instanceof Error ? partErr.message : String(partErr)}`);
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
    console.warn(`  Warning: Could not read partition children: ${childErr instanceof Error ? childErr.message : String(childErr)}`);
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

  await pool.end();

  return { profiles, errors };
}

// --- MySQL profiler ---

async function queryMySQLPrimaryKeys(
  pool: import("mysql2/promise").Pool,
  tableName: string
): Promise<string[]> {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return (rows as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME);
}

async function queryMySQLForeignKeys(
  pool: import("mysql2/promise").Pool,
  tableName: string
): Promise<ForeignKey[]> {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY COLUMN_NAME`,
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
  progress?: ProfileProgressCallbacks
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
      console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${table_name}${objectLabel}...`);
    }

    try {
      const [countRows] = await pool.execute(
        `SELECT COUNT(*) as c FROM \`${table_name}\``
      );
      const rowCount = parseInt(String((countRows as { c: number }[])[0].c), 10);

      let primaryKeyColumns: string[] = [];
      let foreignKeys: ForeignKey[] = [];
      if (objectType === "table") {
        try {
          primaryKeyColumns = await queryMySQLPrimaryKeys(pool, table_name);
        } catch (pkErr) {
          if (isFatalConnectionError(pkErr)) throw pkErr;
          console.warn(`    Warning: Could not read PK constraints for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`);
        }
        try {
          foreignKeys = await queryMySQLForeignKeys(pool, table_name);
        } catch (fkErr) {
          if (isFatalConnectionError(fkErr)) throw fkErr;
          console.warn(`    Warning: Could not read FK constraints for ${table_name}: ${fkErr instanceof Error ? fkErr.message : String(fkErr)}`);
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
            `SELECT COUNT(DISTINCT \`${col.COLUMN_NAME}\`) as c FROM \`${table_name}\``
          );
          unique_count = parseInt(String((uqRows as { c: number }[])[0].c), 10);

          const [ncRows] = await pool.execute(
            `SELECT COUNT(*) as c FROM \`${table_name}\` WHERE \`${col.COLUMN_NAME}\` IS NULL`
          );
          null_count = parseInt(String((ncRows as { c: number }[])[0].c), 10);

          // Enum-like detection: text/enum/set columns with <20 distinct values and <=5% cardinality
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
            `SELECT DISTINCT \`${col.COLUMN_NAME}\` as v FROM \`${table_name}\` WHERE \`${col.COLUMN_NAME}\` IS NOT NULL ORDER BY \`${col.COLUMN_NAME}\` LIMIT ${sampleLimit}`
          );
          sample_values = (svRows as { v: unknown }[]).map((r) => String(r.v));
        } catch (colErr) {
          if (isFatalConnectionError(colErr)) throw colErr;
          console.warn(`    Warning: Could not profile column ${table_name}.${col.COLUMN_NAME}: ${colErr instanceof Error ? colErr.message : String(colErr)}`);
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
      // Fail fast on connection-level errors that will affect all remaining tables
      if (isFatalConnectionError(err) || /PROTOCOL_CONNECTION_LOST|ER_SERVER_SHUTDOWN|ER_NET_READ_ERROR|ER_NET_WRITE_ERROR/i.test(msg)) {
        throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
      }
      if (progress) {
        progress.onTableError(table_name, msg, i, objectsToProfile.length);
      } else {
        console.error(`  Warning: Failed to profile ${table_name}: ${msg}`);
      }
      errors.push({ table: table_name, error: msg });
      continue;
    }
  }

  } finally {
    await pool.end().catch((err: unknown) => {
      console.warn(`[atlas] MySQL pool cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return { profiles, errors };
}

// --- ClickHouse profiler ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClickHouseClient = { query: (opts: { query: string; format: string }) => Promise<{ json: () => Promise<any> }>; close: () => Promise<void> };

/** Run a single query against ClickHouse and return rows. */
async function clickhouseQuery<T = Record<string, unknown>>(
  client: ClickHouseClient,
  sql: string
): Promise<T[]> {
  const result = await client.query({ query: sql, format: "JSON" });
  const json = await result.json();
  return json.data as T[];
}

/** Escape a ClickHouse identifier with backticks (doubles any embedded backticks). */
function chIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Rewrite clickhouse:// or clickhouses:// URLs to http:// or https:// for the HTTP client. */
function rewriteClickHouseUrl(url: string): string {
  return url.replace(/^clickhouses:\/\//, "https://").replace(/^clickhouse:\/\//, "http://");
}

export async function listClickHouseObjects(connectionString: string): Promise<DatabaseObject[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@clickhouse/client");
  const client = createClient({ url: rewriteClickHouseUrl(connectionString) });
  try {
    const rows = await clickhouseQuery<{ name: string; engine: string }>(
      client,
      `SELECT name, engine FROM system.tables
       WHERE database = currentDatabase()
         AND engine NOT IN ('System', 'MaterializedView')
       ORDER BY name`
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.engine === "View" ? "view" as const : "table" as const,
    }));
  } finally {
    await client.close();
  }
}

async function queryClickHousePrimaryKeys(
  client: ClickHouseClient,
  tableName: string
): Promise<string[]> {
  const rows = await clickhouseQuery<{ name: string }>(
    client,
    `SELECT name FROM system.columns
     WHERE database = currentDatabase()
       AND table = '${tableName.replace(/'/g, "''")}'
       AND is_in_primary_key = 1
     ORDER BY position`
  );
  return rows.map((r) => r.name);
}

/** Map ClickHouse native types to Atlas semantic types. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- scaffolding for ClickHouse profiler
function mapClickHouseType(chType: string): string {
  const t = chType.replace(/Nullable\((.+)\)/, "$1").replace(/LowCardinality\((.+)\)/, "$1").toLowerCase();
  if (/^(u?int\d+|float\d+|decimal|numeric)/.test(t)) return "number";
  if (/^(date|datetime)/.test(t)) return "date";
  if (t.startsWith("bool")) return "boolean";
  return "string";
}

export async function profileClickHouse(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks
): Promise<ProfilingResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@clickhouse/client");
  const client = createClient({ url: rewriteClickHouseUrl(connectionString) });

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
         ORDER BY name`
      );
      allObjects = rows.map((r) => ({
        name: r.name,
        type: r.engine === "View" ? "view" as const : "table" as const,
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
        progress.onTableStart(table_name + objectLabel, i, objectsToProfile.length);
      } else {
        console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${table_name}${objectLabel}...`);
      }

      try {
        const countRows = await clickhouseQuery<{ c: string }>(
          client,
          `SELECT count() as c FROM ${chIdentifier(table_name)}`
        );
        const rowCount = parseInt(countRows[0].c, 10);

        // ClickHouse primary keys are sorting keys, not uniqueness constraints.
        // No foreign keys in ClickHouse (OLAP, no referential integrity).
        let primaryKeyColumns: string[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await queryClickHousePrimaryKeys(client, table_name);
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            console.warn(`    Warning: Could not read PK columns for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`);
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
           ORDER BY position`
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
              `SELECT uniqExact(${chIdentifier(col.name)}) as c FROM ${chIdentifier(table_name)}`
            );
            unique_count = parseInt(uqRows[0].c, 10);

            const ncRows = await clickhouseQuery<{ c: string }>(
              client,
              `SELECT count() as c FROM ${chIdentifier(table_name)} WHERE ${chIdentifier(col.name)} IS NULL`
            );
            null_count = parseInt(ncRows[0].c, 10);

            // Enum-like detection for String/LowCardinality(String) columns
            const baseType = col.type
              .replace(/Nullable\((.+)\)/, "$1")
              .replace(/LowCardinality\((.+)\)/, "$1");
            const isTextType = baseType === "String" || baseType.startsWith("FixedString") || baseType.startsWith("Enum");
            isEnumLike =
              isTextType &&
              unique_count !== null &&
              unique_count < 20 &&
              rowCount > 0 &&
              unique_count / rowCount <= 0.05;

            const sampleLimit = isEnumLike ? 100 : 10;
            const svRows = await clickhouseQuery<{ v: unknown }>(
              client,
              `SELECT DISTINCT ${chIdentifier(col.name)} as v FROM ${chIdentifier(table_name)} WHERE ${chIdentifier(col.name)} IS NOT NULL ORDER BY v LIMIT ${sampleLimit}`
            );
            sample_values = svRows.map((r) => String(r.v));
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            console.warn(`    Warning: Could not profile column ${table_name}.${col.name}: ${colErr instanceof Error ? colErr.message : String(colErr)}`);
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
            profiler_notes: col.comment ? [`Column comment: ${col.comment}`] : [],
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
          table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        });
        progress?.onTableDone(table_name, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining tables
        if (isFatalConnectionError(err)) {
          throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
        }
        if (progress) {
          progress.onTableError(table_name, msg, i, objectsToProfile.length);
        } else {
          console.error(`  Warning: Failed to profile ${table_name}: ${msg}`);
        }
        errors.push({ table: table_name, error: msg });
        continue;
      }
    }
  } finally {
    await client.close().catch((err: unknown) => {
      console.warn(`[atlas] ClickHouse client cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return { profiles, errors };
}

// --- Snowflake profiler ---

/**
 * Promisified Snowflake query helper. The snowflake-sdk uses a callback-based
 * API, so we wrap execute() in a Promise.
 *
 * Pool type is `generic-pool.Pool<snowflake-sdk.Connection>` — we use `any` to
 * avoid requiring `@types/generic-pool` in the CLI package.
 */
type SnowflakePool = ReturnType<typeof import("snowflake-sdk").createPool>;

async function snowflakeQuery(
  pool: SnowflakePool,
  sql: string,
  binds?: (string | number)[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  return pool.use(async (conn) => {
    return new Promise<{ columns: string[]; rows: Record<string, unknown>[] }>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds ?? [],
        complete: (err, stmt, rows) => {
          if (err) return reject(err);
          const columns = (stmt?.getColumns() ?? []).map((c) => c.getName());
          resolve({ columns, rows: (rows ?? []) as Record<string, unknown>[] });
        },
      });
    });
  });
}

/** Create a Snowflake connection pool from a URL string. Shared by listSnowflakeObjects, profileSnowflake, and handleDiff. */
async function createSnowflakePool(connectionString: string, max = 1) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const snowflake = require("snowflake-sdk") as typeof import("snowflake-sdk");
  snowflake.configure({ logLevel: "ERROR" });

  const { parseSnowflakeURL } = await import("../../../plugins/snowflake/src/connection");
  const opts = parseSnowflakeURL(connectionString);

  const pool = snowflake.createPool(
    {
      account: opts.account,
      username: opts.username,
      password: opts.password,
      database: opts.database,
      schema: opts.schema,
      warehouse: opts.warehouse,
      role: opts.role,
      application: "Atlas",
    },
    { max, min: 0 },
  );

  return { pool, opts };
}

export async function listSnowflakeObjects(connectionString: string): Promise<DatabaseObject[]> {
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
      type: String(r.TABLE_TYPE) === "VIEW" ? "view" as const : "table" as const,
    }));
  } finally {
    await pool.drain().catch((err: unknown) => {
      console.warn(`[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`);
    });
    try { await pool.clear(); } catch (err: unknown) {
      console.warn(`[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`);
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
  return result.rows.map((r) =>
    String(r.column_name ?? r.COLUMN_NAME ?? ""),
  ).filter(Boolean);
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
  return result.rows.map((r) => ({
    from_column: String(r.fk_column_name ?? r.FK_COLUMN_NAME ?? ""),
    to_table: String(r.pk_table_name ?? r.PK_TABLE_NAME ?? ""),
    to_column: String(r.pk_column_name ?? r.PK_COLUMN_NAME ?? ""),
    source: "constraint" as const,
  })).filter((fk) => fk.from_column && fk.to_table && fk.to_column);
}

/** Map Snowflake data types to semantic layer type names. */
function mapSnowflakeType(sfType: string): string {
  const upper = sfType.toUpperCase();
  if (upper.startsWith("VARCHAR") || upper.startsWith("CHAR") || upper === "STRING" || upper === "TEXT") return "text";
  if (upper === "NUMBER" || upper.startsWith("DECIMAL") || upper.startsWith("NUMERIC")) return "numeric";
  if (upper === "INT" || upper === "INTEGER" || upper === "BIGINT" || upper === "SMALLINT" || upper === "TINYINT" || upper === "BYTEINT") return "integer";
  if (upper === "FLOAT" || upper === "FLOAT4" || upper === "FLOAT8" || upper === "DOUBLE" || upper.startsWith("DOUBLE") || upper === "REAL") return "real";
  if (upper === "BOOLEAN") return "boolean";
  if (upper === "DATE") return "date";
  if (upper.startsWith("TIMESTAMP") || upper === "DATETIME") return "date";
  if (upper === "TIME") return "text";
  if (upper === "VARIANT" || upper === "OBJECT" || upper === "ARRAY") return "text";
  if (upper === "BINARY" || upper === "VARBINARY") return "text";
  if (upper === "GEOGRAPHY" || upper === "GEOMETRY") return "text";
  return "text";
}

export async function profileSnowflake(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks
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
        type: String(r.TABLE_TYPE) === "VIEW" ? "view" as const : "table" as const,
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
        console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${table_name}${objectLabel}...`);
      }

      try {
        let primaryKeyColumns: string[] = [];
        let foreignKeys: ForeignKey[] = [];
        if (objectType === "table") {
          try {
            primaryKeyColumns = await querySnowflakePrimaryKeys(pool, table_name, opts.database, opts.schema);
          } catch (pkErr) {
            if (isFatalConnectionError(pkErr)) throw pkErr;
            console.warn(`    Warning: Could not read PK constraints for ${table_name}: ${pkErr instanceof Error ? pkErr.message : String(pkErr)}`);
          }
          try {
            foreignKeys = await querySnowflakeForeignKeys(pool, table_name, opts.database, opts.schema);
          } catch (fkErr) {
            if (isFatalConnectionError(fkErr)) throw fkErr;
            console.warn(`    Warning: Could not read FK constraints for ${table_name}: ${fkErr instanceof Error ? fkErr.message : String(fkErr)}`);
          }
        }

        const fkLookup = new Map(foreignKeys.map((fk) => [fk.from_column, fk]));

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
            const statsAggregates = colNames.map((name, i) =>
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
            console.warn(`    Warning: Bulk stats query failed for ${table_name}, falling back to row count only: ${bulkErr instanceof Error ? bulkErr.message : String(bulkErr)}`);
            try {
              const countResult = await snowflakeQuery(pool, `SELECT COUNT(*) as "RC" FROM "${escId(table_name)}"`);
              rowCount = parseInt(String(countResult.rows[0]?.RC ?? "0"), 10);
            } catch (countErr) {
              if (isFatalConnectionError(countErr)) throw countErr;
              console.warn(`    Warning: Row count query also failed for ${table_name}: ${countErr instanceof Error ? countErr.message : String(countErr)}`);
            }
          }
        } else {
          try {
            const countResult = await snowflakeQuery(pool, `SELECT COUNT(*) as "RC" FROM "${escId(table_name)}"`);
            rowCount = parseInt(String(countResult.rows[0]?.RC ?? "0"), 10);
          } catch (countErr) {
            if (isFatalConnectionError(countErr)) throw countErr;
            console.warn(`    Warning: Row count query failed for ${table_name}: ${countErr instanceof Error ? countErr.message : String(countErr)}`);
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
          return { name, dataType, isEnumLike, sampleLimit: isEnumLike ? 100 : 10 };
        });

        // Batched sample values: 1 UNION ALL query for all columns
        const samplesMap = new Map<string, string[]>();
        if (colMeta.length > 0) {
          const sampleParts = colMeta.map(({ name, sampleLimit }) =>
            `SELECT '${name.replace(/'/g, "''")}' as "CN", CAST("${escId(name)}" AS VARCHAR) as "V" FROM (SELECT DISTINCT "${escId(name)}" FROM "${escId(table_name)}" WHERE "${escId(name)}" IS NOT NULL ORDER BY "${escId(name)}" LIMIT ${sampleLimit})`,
          );
          try {
            const samplesResult = await snowflakeQuery(pool, sampleParts.join(" UNION ALL "));
            for (const row of samplesResult.rows) {
              const cn = String(row.CN);
              if (!samplesMap.has(cn)) samplesMap.set(cn, []);
              samplesMap.get(cn)!.push(String(row.V));
            }
          } catch (sampleErr) {
            if (isFatalConnectionError(sampleErr)) throw sampleErr;
            console.warn(`    Warning: Batched sample values query failed for ${table_name} (${colMeta.length} columns affected): ${sampleErr instanceof Error ? sampleErr.message : String(sampleErr)}`);
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
          table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        });
        progress?.onTableDone(table_name, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining tables
        // Snowflake-specific: 390100 = auth token expired, 390114 = auth token invalid, 250001 = connection failure
        if (isFatalConnectionError(err) || /390100|390114|250001/.test(msg)) {
          throw new Error(`Fatal database error while profiling ${table_name}: ${msg}`, { cause: err });
        }
        if (progress) {
          progress.onTableError(table_name, msg, i, objectsToProfile.length);
        } else {
          console.error(`  Warning: Failed to profile ${table_name}: ${msg}`);
        }
        errors.push({ table: table_name, error: msg });
        continue;
      }
    }
  } finally {
    await pool.drain().catch((err: unknown) => {
      console.warn(`[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`);
    });
    try { await pool.clear(); } catch (err: unknown) {
      console.warn(`[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { profiles, errors };
}

// --- Salesforce profiler ---

/** Map Salesforce field types to semantic layer types. */
function mapSalesforceFieldType(sfType: string): string {
  const lower = sfType.toLowerCase();
  switch (lower) {
    case "int":
    case "long":
      return "integer";
    case "double":
    case "currency":
    case "percent":
      return "real";
    case "boolean":
      return "boolean";
    case "date":
    case "datetime":
    case "time":
      return "date";
    case "string":
    case "id":
    case "reference":
    case "textarea":
    case "url":
    case "email":
    case "phone":
    case "picklist":
    case "multipicklist":
    case "combobox":
    case "encryptedstring":
    case "base64":
      return "text";
    default:
      return "text";
  }
}

export async function listSalesforceObjects(connectionString: string): Promise<DatabaseObject[]> {
  const { parseSalesforceURL, createSalesforceConnection } = await import("../../../plugins/salesforce/src/connection");
  const config = parseSalesforceURL(connectionString);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source: any = createSalesforceConnection(config);
  try {
    const objects = await source.listObjects();
    return objects.map((obj: { name: string }) => ({
      name: obj.name,
      type: "table" as const,
    }));
  } finally {
    await source.close();
  }
}

export async function profileSalesforce(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks
): Promise<ProfilingResult> {
  const { parseSalesforceURL, createSalesforceConnection } = await import("../../../plugins/salesforce/src/connection");
  const config = parseSalesforceURL(connectionString);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source: any = createSalesforceConnection(config);

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
        console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${objectName}...`);
      }

      try {
        const desc = await source.describe(objectName);

        // Get row count via SOQL
        let rowCount = 0;
        try {
          const countResult = await source.query(`SELECT COUNT(Id) FROM ${objectName}`);
          // Salesforce COUNT(Id) returns { records: [{ expr0: N }] }
          if (countResult.rows.length > 0) {
            const firstRow = countResult.rows[0];
            const countVal = firstRow.expr0 ?? firstRow.count ?? Object.values(firstRow)[0];
            rowCount = parseInt(String(countVal ?? "0"), 10);
          }
        } catch (countErr) {
          if (isFatalConnectionError(countErr)) throw countErr;
          console.warn(`    Warning: Could not get row count for ${objectName}: ${countErr instanceof Error ? countErr.message : String(countErr)}`);
        }

        const foreignKeys: ForeignKey[] = [];
        const primaryKeyColumns: string[] = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const columns: ColumnProfile[] = desc.fields.map((field: any) => {
          const isPK = field.name === "Id";
          if (isPK) primaryKeyColumns.push(field.name);

          const isFK = field.type === "reference" && field.referenceTo.length > 0;
          if (isFK) {
            foreignKeys.push({
              from_column: field.name,
              to_table: field.referenceTo[0],
              to_column: "Id",
              source: "constraint",
            });
          }

          const isEnumLike = field.type === "picklist" || field.type === "multipicklist";

          // For picklist fields, extract active values as sample_values
          const sampleValues = isEnumLike
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? field.picklistValues.filter((pv: any) => pv.active).map((pv: any) => pv.value)
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
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining objects
        if (isFatalConnectionError(err)) {
          throw new Error(`Fatal Salesforce error while profiling ${objectName}: ${msg}`, { cause: err });
        }
        if (progress) {
          progress.onTableError(objectName, msg, i, objectsToProfile.length);
        } else {
          console.error(`  Warning: Failed to profile ${objectName}: ${msg}`);
        }
        errors.push({ table: objectName, error: msg });
        continue;
      }
    }
  } finally {
    await source.close();
  }

  return { profiles, errors };
}

// --- Pluralization / singularization (shared by heuristics + YAML generation) ---

/**
 * Plural → singular lookup for irregular English words.
 * Also used by YAML generation (singularize) and heuristics (inferForeignKeys).
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  people: "person",
  children: "child",
  men: "man",
  women: "woman",
  mice: "mouse",
  data: "datum",
  criteria: "criterion",
  analyses: "analysis",
};

/** Derived inverse: singular → plural, built once from IRREGULAR_PLURALS. */
const IRREGULAR_SINGULARS_TO_PLURALS: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURALS).map(([plural, singular]) => [singular, plural])
);

export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_SINGULARS_TO_PLURALS[lower]) return IRREGULAR_SINGULARS_TO_PLURALS[lower];
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower))
    return word.slice(0, -1) + "ies";
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("sh") || lower.endsWith("ch"))
    return word + "es";
  return word + "s";
}

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (lower.endsWith("ies")) return word.slice(0, -3) + "y";
  if (lower.endsWith("ses") || lower.endsWith("xes") || lower.endsWith("zes"))
    return word.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss") && !lower.endsWith("us") && !lower.endsWith("is")) return word.slice(0, -1);
  return word;
}

// --- Profiler heuristics (pure functions on TableProfile[]) ---

/**
 * For each `*_id` column without an existing FK constraint, try to match
 * the prefix to a table name (singular or plural). Only infer when the
 * target table has a PK column named `id`.
 */
export function inferForeignKeys(profiles: TableProfile[]): void {
  // Only tables (not views/matviews) can be FK targets — views have no PKs
  const tableMap = new Map(
    profiles.filter((p) => !isViewLike(p)).map((p) => [p.table_name, p])
  );

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const constrainedCols = new Set(profile.foreign_keys.map((fk) => fk.from_column));

    for (const col of profile.columns) {
      if (!col.name.endsWith("_id")) continue;
      if (constrainedCols.has(col.name)) continue;
      if (col.is_primary_key) continue;

      const prefix = col.name.slice(0, -3); // strip "_id"
      if (!prefix) continue;

      // Try direct match, plural, singular
      const candidates = [prefix, pluralize(prefix), singularize(prefix)];
      let targetTable: TableProfile | undefined;
      for (const candidate of candidates) {
        targetTable = tableMap.get(candidate);
        if (targetTable) break;
      }

      if (!targetTable) continue;

      // Only infer when target has PK column named "id"
      const hasPkId = targetTable.primary_key_columns.includes("id");
      if (!hasPkId) continue;

      const inferredFK: ForeignKey = {
        from_column: col.name,
        to_table: targetTable.table_name,
        to_column: "id",
        source: "inferred",
      };

      profile.inferred_foreign_keys.push(inferredFK);

      col.profiler_notes.push(
        `Likely FK to ${targetTable.table_name}.id (inferred from column name, no constraint exists)`
      );
    }
  }
}

const ABANDONED_NAME_PATTERNS = [
  /^old_/,
  /^temp_/,
  /^legacy_/,
  /_legacy$/,
  /_backup$/,
  /_archive$/,
  /_v\d+$/,
];

/**
 * Flag tables whose names match legacy/temp patterns AND have zero inbound FKs
 * (both constraint and inferred). Views and matviews are excluded — they cannot be abandoned.
 */
export function detectAbandonedTables(profiles: TableProfile[]): void {
  // Build set of tables referenced by any FK (constraint or inferred)
  const referencedTables = new Set<string>();
  for (const p of profiles) {
    for (const fk of p.foreign_keys) referencedTables.add(fk.to_table);
    for (const fk of p.inferred_foreign_keys) referencedTables.add(fk.to_table);
  }

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = ABANDONED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    const hasInboundFKs = referencedTables.has(profile.table_name);
    if (hasInboundFKs) continue;

    profile.table_flags.possibly_abandoned = true;
    profile.profiler_notes.push(
      `Possibly abandoned: name matches legacy/temp pattern and no other tables reference it`
    );
  }
}

/**
 * For enum-like columns, detect case-inconsistent values
 * (e.g., 'Technology', 'tech', 'TECHNOLOGY' all map to the same lowercase form).
 */
export function detectEnumInconsistency(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    for (const col of profile.columns) {
      if (!col.is_enum_like) continue;
      if (col.sample_values.length === 0) continue;

      // Group by lowercase form
      const groups = new Map<string, string[]>();
      for (const val of col.sample_values) {
        const lower = val.toLowerCase();
        const existing = groups.get(lower) ?? [];
        existing.push(val);
        groups.set(lower, existing);
      }

      // Find groups with multiple original forms
      const inconsistencies: string[] = [];
      for (const [, originals] of groups) {
        if (originals.length > 1) {
          inconsistencies.push(originals.join(", "));
        }
      }

      if (inconsistencies.length > 0) {
        col.profiler_notes.push(
          `Case-inconsistent enum values: [${inconsistencies.join("; ")}]. Consider using LOWER() for grouping`
        );
      }
    }
  }
}

const DENORMALIZED_NAME_PATTERNS = [
  /_denormalized$/,
  /_cache$/,
  /_summary$/,
  /_stats$/,
  /_rollup$/,
];

/**
 * Flag tables whose names match denormalization patterns. Views and matviews are excluded.
 */
export function detectDenormalizedTables(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = DENORMALIZED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    profile.table_flags.possibly_denormalized = true;
    profile.profiler_notes.push(
      `Possibly denormalized/materialized table: name matches reporting pattern. Data may duplicate other tables`
    );
  }
}

/**
 * Orchestrate all profiler heuristics. Initializes empty arrays/flags,
 * then runs all detectors in sequence.
 */
export function analyzeTableProfiles(profiles: TableProfile[]): void {
  // Reset containers on all profiles (clear any prior run)
  for (const p of profiles) {
    p.inferred_foreign_keys = [];
    p.profiler_notes = [];
    p.table_flags = { possibly_abandoned: false, possibly_denormalized: false };
    for (const col of p.columns) {
      col.profiler_notes = [];
    }
  }

  inferForeignKeys(profiles);
  detectAbandonedTables(profiles);
  detectEnumInconsistency(profiles);
  detectDenormalizedTables(profiles);
}

// --- Generate YAML from profile ---

function entityName(tableName: string): string {
  return tableName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function generateEntityYAML(
  profile: TableProfile,
  allProfiles: TableProfile[],
  dbType: DBType,
  schema: string = "public",
  source?: string,
): string {
  const name = entityName(profile.table_name);
  // DuckDB's default schema is "main" — don't qualify with it (same as Postgres "public")
  const qualifiedTable = schema !== "public" && schema !== "main" ? `${schema}.${profile.table_name}` : profile.table_name;

  // Build dimensions
  const dimensions: Record<string, unknown>[] = profile.columns.map((col) => {
    const dim: Record<string, unknown> = {
      name: col.name,
      sql: col.name,
      type: dbType === "salesforce" ? mapSalesforceFieldType(col.type) : mapSQLType(col.type),
    };

    // Description
    if (col.is_primary_key) {
      dim.description = `Primary key`;
      dim.primary_key = true;
    } else if (col.is_foreign_key) {
      dim.description = `Foreign key to ${col.fk_target_table}`;
    }

    if (col.unique_count !== null) dim.unique_count = col.unique_count;
    if (col.null_count !== null && col.null_count > 0)
      dim.null_count = col.null_count;
    if (col.sample_values.length > 0) {
      dim.sample_values = col.is_enum_like
        ? col.sample_values
        : col.sample_values.slice(0, 8);
    }

    return dim;
  });

  // Build virtual dimensions — dialect-aware CASE bucketing and date extractions
  const virtualDims: Record<string, unknown>[] = [];
  for (const col of profile.columns) {
    if (col.is_primary_key || col.is_foreign_key) continue;
    const mappedType = dbType === "salesforce" ? mapSalesforceFieldType(col.type) : mapSQLType(col.type);

    if (mappedType === "number" && !col.name.endsWith("_id") && dbType !== "salesforce") {
      const label = col.name.replace(/_/g, " ");
      if (dbType === "mysql") {
        // MySQL: simple fixed-boundary bucketing (no PERCENTILE_CONT)
        virtualDims.push({
          name: `${col.name}_bucket`,
          sql: `CASE\n  WHEN ${col.name} IS NULL THEN 'Unknown'\n  WHEN ${col.name} < (SELECT AVG(${col.name}) * 0.5 FROM ${qualifiedTable}) THEN 'Low'\n  WHEN ${col.name} < (SELECT AVG(${col.name}) * 1.5 FROM ${qualifiedTable}) THEN 'Medium'\n  ELSE 'High'\nEND`,
          type: "string",
          description: `${label} bucketed into Low/Medium/High`,
          virtual: true,
          sample_values: ["Low", "Medium", "High"],
        });
      } else if (dbType === "clickhouse") {
        // ClickHouse: quantile function for tercile bucketing
        virtualDims.push({
          name: `${col.name}_bucket`,
          sql: `CASE\n  WHEN ${col.name} < (SELECT quantile(0.33)(${col.name}) FROM ${qualifiedTable}) THEN 'Low'\n  WHEN ${col.name} < (SELECT quantile(0.66)(${col.name}) FROM ${qualifiedTable}) THEN 'Medium'\n  ELSE 'High'\nEND`,
          type: "string",
          description: `${label} bucketed into Low/Medium/High terciles`,
          virtual: true,
          sample_values: ["Low", "Medium", "High"],
        });
      } else {
        virtualDims.push({
          name: `${col.name}_bucket`,
          sql: `CASE\n  WHEN ${col.name} < (SELECT PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY ${col.name}) FROM ${qualifiedTable}) THEN 'Low'\n  WHEN ${col.name} < (SELECT PERCENTILE_CONT(0.66) WITHIN GROUP (ORDER BY ${col.name}) FROM ${qualifiedTable}) THEN 'Medium'\n  ELSE 'High'\nEND`,
          type: "string",
          description: `${label} bucketed into Low/Medium/High terciles`,
          virtual: true,
          sample_values: ["Low", "Medium", "High"],
        });
      }
    }

    if (mappedType === "date") {
      if (dbType === "mysql") {
        virtualDims.push({
          name: `${col.name}_year`,
          sql: `YEAR(${col.name})`,
          type: "number",
          description: `Year extracted from ${col.name}`,
          virtual: true,
        });
        virtualDims.push({
          name: `${col.name}_month`,
          sql: `DATE_FORMAT(${col.name}, '%Y-%m')`,
          type: "string",
          description: `Year-month extracted from ${col.name}`,
          virtual: true,
        });
      } else if (dbType === "clickhouse") {
        virtualDims.push({
          name: `${col.name}_year`,
          sql: `toYear(${col.name})`,
          type: "number",
          description: `Year extracted from ${col.name}`,
          virtual: true,
        });
        virtualDims.push({
          name: `${col.name}_month`,
          sql: `formatDateTime(${col.name}, '%Y-%m')`,
          type: "string",
          description: `Year-month extracted from ${col.name}`,
          virtual: true,
        });
      } else if (dbType === "salesforce") {
        virtualDims.push({
          name: `${col.name}_year`,
          sql: `CALENDAR_YEAR(${col.name})`,
          type: "number",
          description: `Year extracted from ${col.name}`,
          virtual: true,
        });
        virtualDims.push({
          name: `${col.name}_month`,
          sql: `CALENDAR_MONTH(${col.name})`,
          type: "number",
          description: `Month extracted from ${col.name}`,
          virtual: true,
        });
      } else {
        virtualDims.push({
          name: `${col.name}_year`,
          sql: `EXTRACT(YEAR FROM ${col.name})`,
          type: "number",
          description: `Year extracted from ${col.name}`,
          virtual: true,
        });
        virtualDims.push({
          name: `${col.name}_month`,
          sql: `TO_CHAR(${col.name}, 'YYYY-MM')`,
          type: "string",
          description: `Year-month extracted from ${col.name}`,
          virtual: true,
        });
      }
    }
  }

  // Emit profiler_notes on dimensions
  for (const dim of dimensions) {
    const col = profile.columns.find((c) => c.name === dim.name);
    if (col?.profiler_notes && col.profiler_notes.length > 0) {
      dim.profiler_notes = col.profiler_notes;
    }
  }

  // Build joins from constraint FKs
  const joins: Record<string, unknown>[] = profile.foreign_keys.map((fk) => ({
    target_entity: entityName(fk.to_table),
    relationship: "many_to_one",
    join_columns: {
      from: fk.from_column,
      to: fk.to_column,
    },
    description: `Each ${singularize(profile.table_name)} belongs to one ${singularize(fk.to_table)}`,
  }));

  // Add inferred joins
  for (const fk of profile.inferred_foreign_keys) {
    joins.push({
      target_entity: entityName(fk.to_table),
      relationship: "many_to_one",
      join_columns: {
        from: fk.from_column,
        to: fk.to_column,
      },
      inferred: true,
      note: `No FK constraint exists — inferred from column name ${fk.from_column}`,
      description: `Each ${singularize(profile.table_name)} likely belongs to one ${singularize(fk.to_table)}`,
    });
  }

  // Build measures (skip for views/matviews — they are pre-aggregated or derived; measures should reference source tables instead)
  const measures: Record<string, unknown>[] = [];

  if (!isViewLike(profile)) {
    // count_distinct on PK
    const pkCol = profile.columns.find((c) => c.is_primary_key);
    if (pkCol) {
      measures.push({
        name: `${singularize(profile.table_name)}_count`,
        sql: pkCol.name,
        type: "count_distinct",
      });
    }

    // sum/avg on numeric non-FK non-PK columns
    for (const col of profile.columns) {
      if (col.is_primary_key || col.is_foreign_key) continue;
      if (col.name.endsWith("_id")) continue;
      const mappedType = mapSQLType(col.type);
      if (mappedType !== "number") continue;

      measures.push({
        name: `total_${col.name}`,
        sql: col.name,
        type: "sum",
        description: `Sum of ${col.name.replace(/_/g, " ")}`,
      });
      measures.push({
        name: `avg_${col.name}`,
        sql: col.name,
        type: "avg",
        description: `Average ${col.name.replace(/_/g, " ")}`,
      });
    }
  }

  // Build use_cases
  const useCases: string[] = [];

  // Note for views
  if (isView(profile)) {
    useCases.push(`This is a database view — it may encapsulate complex joins or aggregations. Query it directly rather than recreating its logic`);
  }

  // Notes for materialized views
  if (isMatView(profile)) {
    useCases.push(`WARNING: This is a materialized view — data may be stale. Check with the user about refresh frequency before relying on real-time accuracy`);
    if (profile.matview_populated === false) {
      useCases.push(`WARNING: This materialized view has never been refreshed and contains no data`);
    }
  }

  // Note for partitioned tables
  if (profile.partition_info) {
    useCases.push(`This table is partitioned by ${profile.partition_info.strategy} on (${profile.partition_info.key}). Always include ${profile.partition_info.key} in WHERE clauses for optimal query performance`);
  }

  // Prepend warnings for flagged tables
  if (profile.table_flags.possibly_abandoned) {
    useCases.push(`WARNING: This table appears to be abandoned/legacy. Verify with the user before querying`);
  }
  if (profile.table_flags.possibly_denormalized) {
    useCases.push(`WARNING: This is a denormalized/materialized table. Data may be stale or duplicate other tables`);
  }

  const enumCols = profile.columns.filter((c) => c.is_enum_like);
  const numericCols = profile.columns.filter(
    (c) =>
      mapSQLType(c.type) === "number" && !c.is_primary_key && !c.is_foreign_key && !c.name.endsWith("_id")
  );
  const dateCols = profile.columns.filter(
    (c) => mapSQLType(c.type) === "date"
  );

  if (enumCols.length > 0)
    useCases.push(
      `Use for segmentation analysis by ${enumCols.map((c) => c.name).join(", ")}`
    );
  if (numericCols.length > 0)
    useCases.push(
      `Use for aggregation and trends on ${numericCols.map((c) => c.name).join(", ")}`
    );
  if (dateCols.length > 0)
    useCases.push(`Use for time-series analysis using ${dateCols.map((c) => c.name).join(", ")}`);

  // Combined FK list for use_cases
  const allFKs = [...profile.foreign_keys, ...profile.inferred_foreign_keys];
  if (joins.length > 0) {
    const targets = allFKs.map((fk) => fk.to_table);
    const uniqueTargets = [...new Set(targets)];
    useCases.push(
      `Join with ${uniqueTargets.join(", ")} for cross-entity analysis`
    );
  }
  // Add "avoid" guidance for related tables (constraint + inferred)
  const tablesPointingHere = allProfiles.filter((p) =>
    [...p.foreign_keys, ...p.inferred_foreign_keys].some((fk) => fk.to_table === profile.table_name)
  );
  if (tablesPointingHere.length > 0) {
    useCases.push(
      `Avoid for row-level ${tablesPointingHere.map((p) => p.table_name).join("/")} queries — use those entities directly`
    );
  }
  if (useCases.length === 0) {
    useCases.push(`Use for querying ${profile.table_name} data`);
  }

  // Build query patterns (skip for views/matviews — the view IS the pattern)
  const queryPatterns: Record<string, unknown>[] = [];

  if (!isViewLike(profile)) {
    // Pattern: count by enum column
    for (const col of enumCols.slice(0, 2)) {
      queryPatterns.push({
        description: `${entityName(profile.table_name)} by ${col.name}`,
        sql: `SELECT ${col.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${col.name}\nORDER BY count DESC`,
      });
    }

    // Pattern: aggregate numeric by enum
    if (numericCols.length > 0 && enumCols.length > 0) {
      const numCol = numericCols[0];
      const enumCol = enumCols[0];
      queryPatterns.push({
        description: `Total ${numCol.name} by ${enumCol.name}`,
        sql: `SELECT ${enumCol.name}, SUM(${numCol.name}) as total_${numCol.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${enumCol.name}\nORDER BY total_${numCol.name} DESC`,
      });
    }
  }

  // Build description with optional suffix for flagged tables
  const profileIsViewLike = isViewLike(profile);
  const profileIsMatView = isMatView(profile);
  let description: string;
  if (profileIsMatView) {
    description = `Materialized view: ${profile.table_name} (${profile.row_count.toLocaleString()} rows). Contains ${profile.columns.length} columns.`;
  } else if (isView(profile)) {
    description = `Database view: ${profile.table_name} (${profile.row_count.toLocaleString()} rows). Contains ${profile.columns.length} columns.`;
  } else {
    description = `Auto-profiled schema for ${profile.table_name} (${profile.row_count.toLocaleString()} rows). Contains ${profile.columns.length} columns${allFKs.length > 0 ? `, linked to ${[...new Set(allFKs.map((fk) => fk.to_table))].join(", ")}` : ""}.`;
  }
  if (profile.table_flags.possibly_abandoned) {
    description += ` POSSIBLY ABANDONED — name matches legacy/temp pattern and no tables reference it.`;
  }
  if (profile.table_flags.possibly_denormalized) {
    description += ` DENORMALIZED — data may duplicate other tables.`;
  }

  // Determine entity type
  let entityType: string;
  if (profileIsMatView) {
    entityType = "materialized_view";
  } else if (isView(profile)) {
    entityType = "view";
  } else {
    entityType = "fact_table";
  }

  // Assemble entity
  const entity: Record<string, unknown> = {
    name,
    type: entityType,
    table: qualifiedTable,
    ...(source ? { connection: source } : {}),
    grain: profileIsMatView
      ? `one row per result from ${profile.table_name} materialized view`
      : profileIsViewLike
        ? `one row per result from ${profile.table_name} view`
        : `one row per ${singularize(profile.table_name).replace(/_/g, " ")} record`,
    description,
    dimensions: [...dimensions, ...virtualDims],
  };

  // Partition metadata
  if (profile.partition_info) {
    entity.partitioned = true;
    entity.partition_strategy = profile.partition_info.strategy;
    entity.partition_key = profile.partition_info.key;
  }

  if (measures.length > 0) entity.measures = measures;
  if (joins.length > 0) entity.joins = joins;
  entity.use_cases = useCases;
  if (queryPatterns.length > 0) entity.query_patterns = queryPatterns;

  // Emit table-level profiler notes
  if (profile.profiler_notes.length > 0) {
    entity.profiler_notes = profile.profiler_notes;
  }

  return yaml.dump(entity, { lineWidth: 120, noRefs: true });
}

export function generateCatalogYAML(profiles: TableProfile[]): string {
  const catalog: Record<string, unknown> = {
    version: "1.0",
    entities: profiles.map((p) => {
      const enumCols = p.columns.filter((c) => c.is_enum_like);
      const numericCols = p.columns.filter(
        (c) =>
          mapSQLType(c.type) === "number" && !c.is_primary_key && !c.is_foreign_key && !c.name.endsWith("_id")
      );

      // Generate use_for from table characteristics
      const useFor: string[] = [];
      if (enumCols.length > 0) {
        useFor.push(
          `Segmentation by ${enumCols.map((c) => c.name).join(", ")}`
        );
      }
      if (numericCols.length > 0) {
        useFor.push(
          `Aggregation on ${numericCols.map((c) => c.name).join(", ")}`
        );
      }
      const allFKs = [...p.foreign_keys, ...p.inferred_foreign_keys];
      if (allFKs.length > 0) {
        useFor.push(
          `Cross-entity analysis via ${[...new Set(allFKs.map((fk) => fk.to_table))].join(", ")}`
        );
      }
      if (useFor.length === 0) {
        useFor.push(`General queries on ${p.table_name}`);
      }

      // Generate common_questions from column types
      const questions: string[] = [];
      for (const col of enumCols.slice(0, 2)) {
        questions.push(
          `How many ${p.table_name} by ${col.name}?`
        );
      }
      if (numericCols.length > 0) {
        questions.push(
          `What is the average ${numericCols[0].name} across ${p.table_name}?`
        );
      }
      if (allFKs.length > 0) {
        const fk = allFKs[0];
        questions.push(
          `How are ${p.table_name} distributed across ${fk.to_table}?`
        );
      }
      if (questions.length === 0) {
        questions.push(`What data is in ${p.table_name}?`);
      }

      const entryIsMatView = isMatView(p);
      const entryIsViewLike = isViewLike(p);

      let catalogDesc: string;
      if (entryIsMatView) {
        catalogDesc = `${p.table_name} [materialized view] (${p.row_count.toLocaleString()} rows, ${p.columns.length} columns)`;
      } else if (isView(p)) {
        catalogDesc = `${p.table_name} [view] (${p.row_count.toLocaleString()} rows, ${p.columns.length} columns)`;
      } else {
        catalogDesc = `${p.table_name} (${p.row_count.toLocaleString()} rows, ${p.columns.length} columns)`;
      }
      if (p.partition_info) {
        catalogDesc += ` [partitioned by ${p.partition_info.strategy}]`;
      }

      return {
        name: entityName(p.table_name),
        file: `entities/${p.table_name}.yml`,
        grain: entryIsMatView
          ? `one row per result from ${p.table_name} materialized view`
          : entryIsViewLike
            ? `one row per result from ${p.table_name} view`
            : `one row per ${singularize(p.table_name).replace(/_/g, " ")} record`,
        description: catalogDesc,
        use_for: useFor,
        common_questions: questions,
      };
    }),
    glossary: "glossary.yml",
  };

  // Add metrics section if we'll be generating metric files (exclude views/matviews)
  const tablesWithNumericCols = profiles.filter((p) =>
    !isViewLike(p) &&
    p.columns.some(
      (c) =>
        mapSQLType(c.type) === "number" && !c.is_primary_key && !c.is_foreign_key && !c.name.endsWith("_id")
    )
  );
  if (tablesWithNumericCols.length > 0) {
    catalog.metrics = tablesWithNumericCols.map((p) => ({
      file: `metrics/${p.table_name}.yml`,
      description: `Auto-generated metrics for ${p.table_name}`,
    }));
  }

  // Add tech_debt section for flagged tables
  const flaggedTables: { table: string; issues: string[] }[] = [];
  for (const p of profiles) {
    const issues: string[] = [];
    if (p.table_flags.possibly_abandoned) issues.push("possibly_abandoned");
    if (p.table_flags.possibly_denormalized) issues.push("possibly_denormalized");
    if (p.inferred_foreign_keys.length > 0) issues.push("missing_fk_constraints");
    const hasEnumIssues = p.columns.some((c) =>
      c.profiler_notes.some((n) => n.startsWith("Case-inconsistent"))
    );
    if (hasEnumIssues) issues.push("inconsistent_enums");
    if (issues.length > 0) flaggedTables.push({ table: p.table_name, issues });
  }
  if (flaggedTables.length > 0) {
    catalog.tech_debt = flaggedTables;
  }

  return yaml.dump(catalog, { lineWidth: 120, noRefs: true });
}

export function generateMetricYAML(profile: TableProfile, schema: string = "public"): string | null {
  if (isViewLike(profile)) return null;

  const numericCols = profile.columns.filter(
    (c) =>
      mapSQLType(c.type) === "number" &&
      !c.is_primary_key &&
      !c.is_foreign_key &&
      !c.name.endsWith("_id")
  );

  if (numericCols.length === 0) return null;

  const pkCol = profile.columns.find((c) => c.is_primary_key);
  const enumCols = profile.columns.filter((c) => c.is_enum_like);
  const qualifiedTable = schema !== "public" ? `${schema}.${profile.table_name}` : profile.table_name;

  const metrics: Record<string, unknown>[] = [];

  // Count metric
  if (pkCol) {
    metrics.push({
      id: `${profile.table_name}_count`,
      label: `Total ${entityName(profile.table_name)}`,
      description: `Count of distinct ${profile.table_name} records.`,
      type: "atomic",
      sql: `SELECT COUNT(DISTINCT ${pkCol.name}) as count\nFROM ${qualifiedTable}`,
      aggregation: "count_distinct",
    });
  }

  // Sum and average for each numeric column
  for (const col of numericCols) {
    metrics.push({
      id: `total_${col.name}`,
      label: `Total ${col.name.replace(/_/g, " ")}`,
      description: `Sum of ${col.name} across all ${profile.table_name}.`,
      type: "atomic",
      source: {
        entity: entityName(profile.table_name),
        measure: `total_${col.name}`,
      },
      sql: `SELECT SUM(${col.name}) as total_${col.name}\nFROM ${qualifiedTable}`,
      aggregation: "sum",
      objective: "maximize",
    });

    metrics.push({
      id: `avg_${col.name}`,
      label: `Average ${col.name.replace(/_/g, " ")}`,
      description: `Average ${col.name} per ${singularize(profile.table_name)}.`,
      type: "atomic",
      sql: `SELECT AVG(${col.name}) as avg_${col.name}\nFROM ${qualifiedTable}`,
      aggregation: "avg",
    });

    // Breakdown by first enum column if available
    if (enumCols.length > 0) {
      const enumCol = enumCols[0];
      metrics.push({
        id: `${col.name}_by_${enumCol.name}`,
        label: `${col.name.replace(/_/g, " ")} by ${enumCol.name}`,
        description: `${col.name} broken down by ${enumCol.name}.`,
        type: "atomic",
        sql: `SELECT ${enumCol.name}, SUM(${col.name}) as total_${col.name}, AVG(${col.name}) as avg_${col.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${enumCol.name}\nORDER BY total_${col.name} DESC`,
      });
    }
  }

  return yaml.dump({ metrics }, { lineWidth: 120, noRefs: true });
}

export function generateGlossaryYAML(profiles: TableProfile[]): string {
  const terms: Record<string, unknown> = {};

  // Find columns that appear in multiple tables (ambiguous terms)
  const columnToTables = new Map<string, string[]>();
  for (const p of profiles) {
    for (const col of p.columns) {
      if (col.is_primary_key || col.is_foreign_key) continue;
      const existing = columnToTables.get(col.name) ?? [];
      existing.push(p.table_name);
      columnToTables.set(col.name, existing);
    }
  }

  for (const [colName, tables] of columnToTables) {
    if (tables.length > 1) {
      terms[colName] = {
        status: "ambiguous",
        note: `"${colName}" appears in multiple tables: ${tables.join(", ")}. ASK the user which table they mean.`,
        possible_mappings: tables.map((t) => `${t}.${colName}`),
      };
    }
  }

  // Add FK relationship terms
  for (const p of profiles) {
    for (const fk of p.foreign_keys) {
      const termName = fk.from_column.replace(/_id$/, "");
      if (!terms[termName]) {
        terms[termName] = {
          status: "defined",
          definition: `Refers to the ${fk.to_table} entity. Linked via ${p.table_name}.${fk.from_column} → ${fk.to_table}.${fk.to_column}.`,
        };
      }
    }
  }

  // Add enum-like column terms
  for (const p of profiles) {
    for (const col of p.columns) {
      if (col.is_enum_like && !terms[col.name]) {
        terms[col.name] = {
          status: "defined",
          definition: `Categorical field on ${p.table_name}. Possible values: ${col.sample_values.join(", ")}.`,
        };
      }
    }
  }

  // Add ambiguous terms for columns with case-inconsistent enums
  for (const p of profiles) {
    for (const col of p.columns) {
      if (!col.is_enum_like) continue;
      const inconsistencyNote = col.profiler_notes.find((n) =>
        n.startsWith("Case-inconsistent")
      );
      if (!inconsistencyNote) continue;

      const termKey = `${p.table_name}.${col.name}`;
      terms[termKey] = {
        status: "ambiguous",
        note: `${col.name} on ${p.table_name} has case-inconsistent values. Use LOWER(${col.name}) when grouping or filtering.`,
        guidance: `Always wrap in LOWER() for reliable aggregation: GROUP BY LOWER(${col.name})`,
      };
    }
  }

  if (Object.keys(terms).length === 0) {
    terms["example_term"] = {
      status: "defined",
      definition: "Replace this with your own business terms",
    };
  }

  return yaml.dump({ terms }, { lineWidth: 120, noRefs: true });
}

export function mapSQLType(sqlType: string): string {
  // Strip ClickHouse wrappers (Nullable, LowCardinality) before matching
  const unwrapped = sqlType.replace(/Nullable\((.+)\)/g, "$1").replace(/LowCardinality\((.+)\)/g, "$1");
  const t = unwrapped.toLowerCase();
  // interval and money look like they contain "int" — handle before the numeric check
  if (t.includes("interval") || t.includes("money")) return "string";
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("real") ||
    t.includes("numeric") ||
    t.includes("decimal") ||
    t.includes("double") ||
    t === "currency" ||
    t === "percent" ||
    t === "long"
  )
    return "number";
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp"))
    return "date";
  return "string";
}

// --- DuckDB profiler (CSV/Parquet files) ---

/** Helper to run a DuckDB query and return typed rows. */
async function duckdbQuery<T = Record<string, unknown>>(
  conn: unknown,
  sql: string,
): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = await (conn as any).runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}

/**
 * Ingest CSV/Parquet files into a DuckDB database file.
 *
 * Each file becomes a table named after the file stem (e.g. `sales.csv` → `sales`).
 * Returns the list of created table names.
 */
export async function ingestIntoDuckDB(
  dbPath: string,
  files: { path: string; format: "csv" | "parquet" }[],
): Promise<string[]> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const tableNames: string[] = [];
  const usedNames = new Set<string>();

  try {
    for (const file of files) {
      const absPath = path.resolve(file.path);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${absPath}`);
      }
      // Table name from file stem (lowercase, replace non-identifier chars with _)
      const stem = path.basename(absPath, path.extname(absPath))
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^(\d)/, "_$1"); // prefix digit-leading names

      if (usedNames.has(stem)) {
        throw new Error(`Table name collision: multiple files map to "${stem}". Rename files or pass one at a time.`);
      }
      usedNames.add(stem);

      const readFn = file.format === "csv"
        ? `read_csv_auto('${absPath.replace(/'/g, "''")}')`
        : `read_parquet('${absPath.replace(/'/g, "''")}')`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (conn as any).run(`CREATE TABLE "${stem}" AS SELECT * FROM ${readFn}`);
      tableNames.push(stem);
      console.log(`  Loaded ${file.format.toUpperCase()} → table "${stem}" from ${file.path}`);
    }
    return tableNames;
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).disconnectSync();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).closeSync();
  }
}

/** List tables in a DuckDB database. */
export async function listDuckDBObjects(dbPath: string): Promise<DatabaseObject[]> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  try {
    const rows = await duckdbQuery<{ name: string; type: string }>(
      conn,
      `SELECT table_name as name,
              CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END as type
       FROM information_schema.tables
       WHERE table_schema = 'main'
       ORDER BY table_name`,
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type === "view" ? "view" as const : "table" as const,
    }));
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).disconnectSync();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).closeSync();
  }
}

/** Map DuckDB types to the common type system. */
function mapDuckDBType(duckType: string): string {
  const t = duckType.toLowerCase();
  if (t.includes("int") || t.includes("float") || t.includes("double") ||
      t.includes("decimal") || t.includes("numeric") || t.includes("real") ||
      t === "hugeint" || t === "uhugeint") {
    return "number";
  }
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp")) return "date";
  return "string";
}

/** Profile tables in a DuckDB database. */
export async function profileDuckDB(
  dbPath: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks
): Promise<ProfilingResult> {
  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  const profiles: TableProfile[] = [];
  const errors: ProfileError[] = [];

  try {
    let allObjects: DatabaseObject[];
    if (prefetchedObjects) {
      allObjects = prefetchedObjects;
    } else {
      allObjects = await listDuckDBObjects(dbPath);
    }

    const objectsToProfile = filterTables
      ? allObjects.filter((o) => filterTables.includes(o.name))
      : allObjects;

    progress?.onStart(objectsToProfile.length);

    for (const [i, obj] of objectsToProfile.entries()) {
      const tableName = obj.name;
      const objectType = obj.type;
      const objectLabel = objectType === "view" ? " [view]" : "";
      if (progress) {
        progress.onTableStart(tableName + objectLabel, i, objectsToProfile.length);
      } else {
        console.log(`  [${i + 1}/${objectsToProfile.length}] Profiling ${tableName}${objectLabel}...`);
      }

      try {
        const countRows = await duckdbQuery<{ c: number | bigint }>(conn, `SELECT COUNT(*) as c FROM "${tableName}"`);
        const rowCount = Number(countRows[0].c);

        // Get column info
        const colRows = await duckdbQuery<{ column_name: string; data_type: string; is_nullable: string }>(
          conn,
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_name = '${tableName.replace(/'/g, "''")}' AND table_schema = 'main'
           ORDER BY ordinal_position`,
        );

        const columns: ColumnProfile[] = [];
        for (const col of colRows) {
          let uniqueCount: number | null = null;
          let nullCount: number | null = null;
          let sampleValues: string[] = [];
          let isEnumLike = false;

          try {
            const stats = await duckdbQuery<{ u: number | bigint; n: number | bigint }>(
              conn,
              `SELECT COUNT(DISTINCT "${col.column_name}") as u, COUNT(*) - COUNT("${col.column_name}") as n FROM "${tableName}"`,
            );
            uniqueCount = Number(stats[0].u);
            nullCount = Number(stats[0].n);

            // Enum-like detection: text columns with <20 unique values and <5% cardinality
            const mappedType = mapDuckDBType(col.data_type);
            if (mappedType === "string" && uniqueCount !== null && uniqueCount > 0 && uniqueCount <= 20 && rowCount > 0) {
              const cardinality = uniqueCount / rowCount;
              if (cardinality < 0.05 || uniqueCount <= 10) {
                isEnumLike = true;
                const enumRows = await duckdbQuery<{ v: string }>(
                  conn,
                  `SELECT DISTINCT CAST("${col.column_name}" AS VARCHAR) as v FROM "${tableName}" WHERE "${col.column_name}" IS NOT NULL ORDER BY v LIMIT 20`,
                );
                sampleValues = enumRows.map((r) => String(r.v));
              }
            }

            // Sample values for non-enum columns
            if (!isEnumLike) {
              const sampleRows = await duckdbQuery<{ v: string }>(
                conn,
                `SELECT DISTINCT CAST("${col.column_name}" AS VARCHAR) as v FROM "${tableName}" WHERE "${col.column_name}" IS NOT NULL LIMIT 5`,
              );
              sampleValues = sampleRows.map((r) => String(r.v));
            }
          } catch (colErr) {
            if (isFatalConnectionError(colErr)) throw colErr;
            console.warn(
              `    Warning: Could not profile column ${tableName}.${col.column_name}: ${colErr instanceof Error ? colErr.message : String(colErr)}`
            );
          }

          columns.push({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            unique_count: uniqueCount,
            null_count: nullCount,
            sample_values: sampleValues,
            is_primary_key: false, // DuckDB doesn't enforce PKs on loaded data
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: isEnumLike,
            profiler_notes: [],
          });
        }

        profiles.push({
          table_name: tableName,
          object_type: objectType,
          row_count: rowCount,
          columns,
          primary_key_columns: [],
          foreign_keys: [],
          inferred_foreign_keys: [],
          profiler_notes: [],
          table_flags: {
            possibly_abandoned: false,
            possibly_denormalized: false,
          },
        });
        progress?.onTableDone(tableName, i, objectsToProfile.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail fast on connection-level errors that will affect all remaining tables
        if (isFatalConnectionError(err)) {
          throw new Error(`Fatal database error while profiling ${tableName}: ${msg}`, { cause: err });
        }
        if (progress) {
          progress.onTableError(tableName, msg, i, objectsToProfile.length);
        } else {
          console.error(`  Warning: Failed to profile ${tableName}: ${msg}`);
        }
        errors.push({ table: tableName, error: msg });
      }
    }
  } finally {
    // DuckDB Neo API uses synchronous cleanup methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).disconnectSync();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).closeSync();
  }

  return { profiles, errors };
}

// --- Demo datasets ---

export type DemoDataset = "simple" | "cybersec" | "ecommerce";

export const DEMO_DATASETS: Record<
  DemoDataset,
  { pg: string; label: string }
> = {
  simple: {
    pg: "demo.sql",
    label: "Demo data loaded: 50 companies, ~200 people, 80 accounts",
  },
  cybersec: {
    pg: "cybersec.sql",
    label:
      "Cybersec demo loaded: 62 tables, ~500K rows (Sentinel Security SaaS)",
  },
  ecommerce: {
    pg: "ecommerce.sql",
    label:
      "E-commerce demo loaded: 52 tables, ~480K rows (NovaMart DTC brand)",
  },
};

function parseDemoArg(args: string[]): DemoDataset | null {
  if (!args.includes("--demo")) return null;
  const next = getFlag(args, "--demo");
  if (!next || next.startsWith("--")) return "simple"; // bare --demo → backward compatible default
  if (next in DEMO_DATASETS) return next as DemoDataset;
  throw new Error(`Unknown demo dataset "${next}". Available: ${Object.keys(DEMO_DATASETS).join(", ")}`);
}

/** Recursively copy a directory, overwriting existing files. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  wrote ${destPath}`);
    }
  }
}

// --- Demo data seeding ---

export async function seedDemoPostgres(
  connectionString: string,
  dataset: DemoDataset
): Promise<void> {
  const meta = DEMO_DATASETS[dataset];
  const sqlFile = path.resolve(import.meta.dir, "..", "data", meta.pg);
  if (!fs.existsSync(sqlFile)) {
    throw new Error(`Demo SQL file not found: ${sqlFile}`);
  }
  const sql = fs.readFileSync(sqlFile, "utf-8");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(sql);
    console.log(meta.label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to seed ${dataset} demo data into Postgres: ${msg}`, { cause: err });
  } finally {
    await pool.end();
  }
}

// --- Schema diff types ---

export interface EntitySnapshot {
  table: string;
  columns: Map<string, string>; // column name → normalized type
  foreignKeys: Set<string>;     // "from_col→target_table.target_col"
  objectType?: string;          // "fact_table", "view", "materialized_view"
  partitionStrategy?: string;
  partitionKey?: string;
}

export interface TableDiff {
  table: string;
  addedColumns: { name: string; type: string }[];
  removedColumns: { name: string; type: string }[];
  typeChanges: { name: string; yamlType: string; dbType: string }[];
  addedFKs: string[];
  removedFKs: string[];
  metadataChanges: string[];
}

export interface DiffResult {
  newTables: string[];
  removedTables: string[];
  tableDiffs: TableDiff[];
}

// --- Schema diff logic ---

/**
 * Parse an entity YAML object into a normalized EntitySnapshot.
 * Skips virtual dimensions. Extracts FKs from joins array.
 */
export function parseEntityYAML(doc: Record<string, unknown>): EntitySnapshot {
  const table = doc.table as string;
  const columns = new Map<string, string>();
  const foreignKeys = new Set<string>();

  // Extract columns from dimensions (skip virtual)
  const rawDimensions = doc.dimensions ?? [];
  if (!Array.isArray(rawDimensions)) {
    console.warn(`[atlas diff] Skipping ${table}: 'dimensions' field is not an array`);
    return { table, columns, foreignKeys };
  }
  const dimensions = rawDimensions as Record<string, unknown>[];
  for (const dim of dimensions) {
    if (dim.virtual) continue;
    if (typeof dim.name !== "string" || typeof dim.type !== "string") {
      console.warn(`[atlas diff] Skipping malformed dimension in ${table}: name=${String(dim.name)}, type=${String(dim.type)}`);
      continue;
    }
    columns.set(dim.name, dim.type);
  }

  // Extract FKs from joins
  const rawJoins = doc.joins ?? [];
  if (!Array.isArray(rawJoins)) {
    console.warn(`[atlas diff] Skipping joins for ${table}: 'joins' field is not an array`);
    return { table, columns, foreignKeys };
  }
  const joins = rawJoins as Record<string, unknown>[];
  for (const join of joins) {
    const joinCols = join.join_columns as { from: string; to: string } | undefined;
    const targetEntity = join.target_entity as string | undefined;
    if (!joinCols || !targetEntity) {
      console.warn(`[atlas diff] Skipping malformed join in ${table}: missing join_columns or target_entity`);
      continue;
    }
    if (typeof joinCols.from !== "string" || typeof joinCols.to !== "string") {
      console.warn(`[atlas diff] Skipping malformed join in ${table}: join_columns.from/to must be strings`);
      continue;
    }

    // target_entity is PascalCase entity name — we need the table name.
    // Approximate inverse of entityName(): splits on lowercase→uppercase boundaries.
    // Works for segments >= 2 chars (e.g. "UserAccount" → "user_account").
    const targetTable = targetEntity
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
    foreignKeys.add(`${joinCols.from}→${targetTable}.${joinCols.to}`);
  }

  // Extract metadata
  const objectType = typeof doc.type === "string" ? doc.type : undefined;
  const partitionStrategy = typeof doc.partition_strategy === "string" ? doc.partition_strategy : undefined;
  const partitionKey = typeof doc.partition_key === "string" ? doc.partition_key : undefined;

  return { table, columns, foreignKeys, objectType, partitionStrategy, partitionKey };
}

/**
 * Build EntitySnapshot from a live DB profile.
 * Must be called after analyzeTableProfiles() — that step populates
 * inferred_foreign_keys which are included alongside declared FKs.
 */
export function profileToSnapshot(profile: TableProfile): EntitySnapshot {
  const columns = new Map<string, string>();
  for (const col of profile.columns) {
    columns.set(col.name, mapSQLType(col.type));
  }

  const foreignKeys = new Set<string>();
  for (const fk of [...profile.foreign_keys, ...profile.inferred_foreign_keys]) {
    foreignKeys.add(`${fk.from_column}→${fk.to_table}.${fk.to_column}`);
  }

  // Map object_type to entity type string used in YAML
  let objectType: string | undefined;
  if (isMatView(profile)) {
    objectType = "materialized_view";
  } else if (isView(profile)) {
    objectType = "view";
  } else {
    objectType = "fact_table";
  }

  return {
    table: profile.table_name,
    columns,
    foreignKeys,
    objectType,
    partitionStrategy: profile.partition_info?.strategy,
    partitionKey: profile.partition_info?.key,
  };
}

/**
 * Compute the diff between DB snapshots and YAML snapshots.
 * Pure function — no I/O.
 */
export function computeDiff(
  dbSnapshots: Map<string, EntitySnapshot>,
  yamlSnapshots: Map<string, EntitySnapshot>,
): DiffResult {
  const dbTables = new Set(dbSnapshots.keys());
  const yamlTables = new Set(yamlSnapshots.keys());

  const newTables = [...dbTables].filter((t) => !yamlTables.has(t)).sort();
  const removedTables = [...yamlTables].filter((t) => !dbTables.has(t)).sort();

  const tableDiffs: TableDiff[] = [];

  // Compare shared tables
  for (const table of [...dbTables].filter((t) => yamlTables.has(t)).sort()) {
    const db = dbSnapshots.get(table)!;
    const yml = yamlSnapshots.get(table)!;

    const addedColumns: { name: string; type: string }[] = [];
    const removedColumns: { name: string; type: string }[] = [];
    const typeChanges: { name: string; yamlType: string; dbType: string }[] = [];

    // Columns in DB but not YAML
    for (const [name, type] of db.columns) {
      if (!yml.columns.has(name)) {
        addedColumns.push({ name, type });
      } else if (yml.columns.get(name) !== type) {
        typeChanges.push({ name, yamlType: yml.columns.get(name)!, dbType: type });
      }
    }

    // Columns in YAML but not DB
    for (const [name, type] of yml.columns) {
      if (!db.columns.has(name)) {
        removedColumns.push({ name, type });
      }
    }

    // FK differences
    const addedFKs = [...db.foreignKeys].filter((fk) => !yml.foreignKeys.has(fk)).sort();
    const removedFKs = [...yml.foreignKeys].filter((fk) => !db.foreignKeys.has(fk)).sort();

    // Metadata differences
    const metadataChanges: string[] = [];
    // Only flag type changes that indicate real schema drift (e.g. table↔view).
    // Semantic classifications like dimension_table vs fact_table are enrichment
    // metadata — the profiler always assigns "fact_table" to non-views, so comparing
    // it against enriched YAML produces false positives.
    const semanticTypes = new Set(["fact_table", "dimension_table"]);
    if (db.objectType && yml.objectType && db.objectType !== yml.objectType
      && !(semanticTypes.has(db.objectType) && semanticTypes.has(yml.objectType))) {
      metadataChanges.push(`type changed: ${yml.objectType} → ${db.objectType}`);
    }
    if (db.partitionStrategy !== yml.partitionStrategy) {
      if (db.partitionStrategy && !yml.partitionStrategy) {
        metadataChanges.push(`partition strategy added: ${db.partitionStrategy}`);
      } else if (!db.partitionStrategy && yml.partitionStrategy) {
        metadataChanges.push(`partition strategy removed (was: ${yml.partitionStrategy})`);
      } else if (db.partitionStrategy && yml.partitionStrategy) {
        metadataChanges.push(`partition strategy changed: ${yml.partitionStrategy} → ${db.partitionStrategy}`);
      }
    }
    if (db.partitionKey !== yml.partitionKey) {
      if (db.partitionKey && !yml.partitionKey) {
        metadataChanges.push(`partition key added: ${db.partitionKey}`);
      } else if (!db.partitionKey && yml.partitionKey) {
        metadataChanges.push(`partition key removed (was: ${yml.partitionKey})`);
      } else if (db.partitionKey && yml.partitionKey) {
        metadataChanges.push(`partition key changed: ${yml.partitionKey} → ${db.partitionKey}`);
      }
    }

    if (
      addedColumns.length > 0 ||
      removedColumns.length > 0 ||
      typeChanges.length > 0 ||
      addedFKs.length > 0 ||
      removedFKs.length > 0 ||
      metadataChanges.length > 0
    ) {
      tableDiffs.push({
        table,
        addedColumns,
        removedColumns,
        typeChanges,
        addedFKs,
        removedFKs,
        metadataChanges,
      });
    }
  }

  return { newTables, removedTables, tableDiffs };
}

/**
 * Format a DiffResult as a human-readable string.
 * @param dbSnapshots — when provided, new-table summaries include column counts
 *   and foreign key details from the live DB profile.
 */
export function formatDiff(
  diff: DiffResult,
  dbSnapshots?: Map<string, EntitySnapshot>,
): string {
  const lines: string[] = [];
  lines.push("Atlas Diff — comparing database against semantic/entities/\n");

  const hasDrift =
    diff.newTables.length > 0 ||
    diff.removedTables.length > 0 ||
    diff.tableDiffs.length > 0;

  if (!hasDrift) {
    lines.push("No drift detected — semantic layer is in sync with the database.");
    return lines.join("\n");
  }

  if (diff.newTables.length > 0) {
    lines.push("New tables (in DB, not in semantic layer):");
    for (const t of diff.newTables) {
      const snap = dbSnapshots?.get(t);
      const detail = snap ? ` (${snap.columns.size} columns)` : "";
      lines.push(`  + ${t}${detail}`);
    }
    lines.push("");
  }

  if (diff.removedTables.length > 0) {
    lines.push("Removed tables (in semantic layer, not in DB):");
    for (const t of diff.removedTables) {
      lines.push(`  - ${t}`);
    }
    lines.push("");
  }

  if (diff.tableDiffs.length > 0) {
    lines.push("Changed tables:");
    for (const td of diff.tableDiffs) {
      lines.push(`  ${td.table}`);
      for (const col of td.addedColumns) {
        lines.push(`    + added column: ${col.name} (${col.type})`);
      }
      for (const col of td.removedColumns) {
        lines.push(`    - removed column: ${col.name} (${col.type})`);
      }
      for (const tc of td.typeChanges) {
        lines.push(`    ~ type changed: ${tc.name} — YAML: ${tc.yamlType}, DB: ${tc.dbType}`);
      }
      for (const fk of td.addedFKs) {
        lines.push(`    + added FK: ${fk}`);
      }
      for (const fk of td.removedFKs) {
        lines.push(`    - removed FK: ${fk}`);
      }
      for (const mc of td.metadataChanges) {
        lines.push(`    ~ ${mc}`);
      }
      lines.push("");
    }
  }

  // Summary line
  const totalAdded = diff.tableDiffs.reduce((n, td) => n + td.addedColumns.length, 0);
  const totalRemoved = diff.tableDiffs.reduce((n, td) => n + td.removedColumns.length, 0);
  const totalTypeChanges = diff.tableDiffs.reduce((n, td) => n + td.typeChanges.length, 0);
  const totalAddedFKs = diff.tableDiffs.reduce((n, td) => n + td.addedFKs.length, 0);
  const totalRemovedFKs = diff.tableDiffs.reduce((n, td) => n + td.removedFKs.length, 0);
  const totalMetadata = diff.tableDiffs.reduce((n, td) => n + td.metadataChanges.length, 0);

  const parts: string[] = [];
  if (diff.newTables.length > 0) parts.push(`${diff.newTables.length} new table${diff.newTables.length === 1 ? "" : "s"}`);
  if (diff.removedTables.length > 0) parts.push(`${diff.removedTables.length} removed`);
  if (diff.tableDiffs.length > 0) {
    const details: string[] = [];
    if (totalAdded > 0) details.push(`${totalAdded} column${totalAdded === 1 ? "" : "s"} added`);
    if (totalRemoved > 0) details.push(`${totalRemoved} removed`);
    if (totalTypeChanges > 0) details.push(`${totalTypeChanges} type change${totalTypeChanges === 1 ? "" : "s"}`);
    if (totalAddedFKs > 0) details.push(`${totalAddedFKs} FK${totalAddedFKs === 1 ? "" : "s"} added`);
    if (totalRemovedFKs > 0) details.push(`${totalRemovedFKs} FK${totalRemovedFKs === 1 ? "" : "s"} removed`);
    if (totalMetadata > 0) details.push(`${totalMetadata} metadata change${totalMetadata === 1 ? "" : "s"}`);
    parts.push(`${diff.tableDiffs.length} changed (${details.join(", ")})`);
  }
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}

// --- Query CLI handler ---

/** Response shape from POST /api/v1/query */
interface QueryAPIResponse {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingActions?: {
    id: string;
    type: string;
    target: string;
    summary: string;
    approveUrl: string;
    denyUrl: string;
  }[];
}

/** Response shape for API errors */
interface QueryAPIError {
  error: string;
  message: string;
}

/**
 * Format a value for display in table cells.
 * Numbers get locale formatting; nulls display as "(null)".
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "(null)";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Quote a CSV field value per RFC 4180: wrap in double-quotes if it contains commas, quotes, or newlines. */
export function quoteCsvField(val: string): string {
  if (/[,"\n]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
  return val;
}

/**
 * Render a data table with box-drawing characters.
 * Adapts column widths to content.
 */
export function renderTable(columns: string[], rows: Record<string, unknown>[]): string {
  // Compute display values
  const displayRows = rows.map((row) =>
    columns.map((col) => formatCellValue(row[col])),
  );

  // Column widths: max of header and all row values
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...displayRows.map((r) => r[i].length)),
  );

  const top    = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid    = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const formatRow = (cells: string[]) =>
    "│" + cells.map((cell, i) => " " + cell.padEnd(widths[i]) + " ").join("│") + "│";

  const lines: string[] = [top, formatRow(columns), mid];
  for (const row of displayRows) {
    lines.push(formatRow(row));
  }
  lines.push(bottom);
  return lines.join("\n");
}

/**
 * Call the approve or deny endpoint for a pending action.
 * Returns { ok: true, status } on success, { ok: false, error } on failure.
 */
export async function handleActionApproval(
  url: string,
  apiKey?: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: false, error: (body.message as string) ?? `HTTP ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, status: body.status as string };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return {
        ok: false,
        error: "Request timed out after 30s. The action may still be processing — check its status.",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// atlas plugin subcommands
// ---------------------------------------------------------------------------

interface PluginInfo {
  id: string;
  types: string[];
  version: string;
  name?: string;
  healthy?: boolean;
  healthMessage?: string;
}

export async function handlePluginList(): Promise<void> {
  let loadConfig: Awaited<typeof import("@atlas/api/lib/config")>["loadConfig"];
  try {
    ({ loadConfig } = await import("@atlas/api/lib/config"));
  } catch (err) {
    console.error(`Error: Could not load Atlas config module: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Ensure @atlas/api is installed (run 'bun install' from the project root).");
    process.exit(1);
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const plugins = config.plugins as Array<Record<string, unknown>> | undefined;
  if (!plugins?.length) {
    console.log("No plugins configured in atlas.config.ts.");
    return;
  }

  const infos: PluginInfo[] = [];
  for (const p of plugins) {
    const info: PluginInfo = {
      id: String(p.id ?? "unknown"),
      types: Array.isArray(p.types) ? (p.types as string[]).map(String) : ["unknown"],
      version: String(p.version ?? "unknown"),
      name: p.name ? String(p.name) : undefined,
    };

    if (typeof p.healthCheck === "function") {
      try {
        const result = await (p.healthCheck as () => Promise<{ healthy: boolean; message?: string }>)();
        info.healthy = result.healthy;
        info.healthMessage = result.message;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: Health check failed for plugin "${info.id}": ${message}`);
        info.healthy = false;
        info.healthMessage = message;
      }
    }

    infos.push(info);
  }

  const columns = ["Name", "ID", "Type", "Version", "Health"];
  const rows = infos.map((info) => ({
    Name: info.name ?? info.id,
    ID: info.id,
    Type: info.types.join(", "),
    Version: info.version,
    Health:
      info.healthy === undefined
        ? "no check"
        : info.healthy
          ? "healthy"
          : `unhealthy${info.healthMessage ? `: ${info.healthMessage}` : ""}`,
  }));

  console.log(renderTable(columns, rows));
  console.log(`${infos.length} plugin(s) registered.`);
}

const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;
type ScaffoldPluginType = (typeof PLUGIN_TYPES)[number];

function isValidPluginType(t: string): t is ScaffoldPluginType {
  return (PLUGIN_TYPES as readonly string[]).includes(t);
}

/** Generate src/index.ts template for a scaffolded plugin, varying by plugin type. */
export function pluginTemplate(name: string, pluginType: ScaffoldPluginType): string {
  const id = name;
  const pascalName = name
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  switch (pluginType) {
    case "datasource":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["datasource"],
  version: "0.1.0",
  name: "${pascalName}",

  connection: {
    create(): PluginDBConnection {
      // TODO: Return a PluginDBConnection that wraps your database driver
      throw new Error("Not implemented — replace with your connection factory");
    },
    dbType: "postgres",
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} datasource plugin initialized");
  },

  async healthCheck() {
    // TODO: Implement a real health check (e.g. run SELECT 1)
    return { healthy: true };
  },
} satisfies AtlasDatasourcePlugin);
`;

    case "context":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasContextPlugin } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["context"],
  version: "0.1.0",
  name: "${pascalName}",

  contextProvider: {
    async load(): Promise<string> {
      // TODO: Return additional context (system prompt fragments, entity YAML, etc.)
      return "Additional context from ${pascalName} plugin.";
    },
    async refresh(): Promise<void> {
      // TODO: Implement cache invalidation if needed
    },
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} context plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasContextPlugin);
`;

    case "interaction":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasInteractionPlugin } from "@useatlas/plugin-sdk";
import type { Hono } from "hono";

export default definePlugin({
  id: "${id}",
  types: ["interaction"],
  version: "0.1.0",
  name: "${pascalName}",

  routes(app: Hono) {
    // TODO: Add your routes
    app.get("/api/${id}/status", (c) => c.json({ status: "ok" }));
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} interaction plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasInteractionPlugin);
`;

    case "action":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin } from "@useatlas/plugin-sdk";
import { tool } from "ai";
import { z } from "zod";

export default definePlugin({
  id: "${id}",
  types: ["action"],
  version: "0.1.0",
  name: "${pascalName}",

  actions: [
    {
      name: "${id}Action",
      description: "TODO: Describe what this action does",
      tool: tool({
        description: "TODO: Describe the tool",
        parameters: z.object({
          input: z.string().describe("The input for this action"),
        }),
        execute: async ({ input }) => {
          // TODO: Implement the action
          return { success: true, input };
        },
      }),
      actionType: "${id}:execute",
      reversible: false,
      defaultApproval: "manual",
      requiredCredentials: [],
    },
  ],

  async initialize(ctx) {
    ctx.logger.info("${pascalName} action plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasActionPlugin);
`;

    case "sandbox":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasSandboxPlugin, PluginExploreBackend, PluginExecResult } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["sandbox"],
  version: "0.1.0",
  name: "${pascalName}",

  sandbox: {
    create(semanticRoot: string): PluginExploreBackend {
      // TODO: Return a PluginExploreBackend that runs commands in your sandbox
      throw new Error("Not implemented — replace with your sandbox backend");
    },
    priority: 60,
  },

  security: {
    networkIsolation: false,
    filesystemIsolation: false,
    unprivilegedExecution: false,
    description: "TODO: Describe the isolation guarantees of this sandbox",
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} sandbox plugin initialized");
  },

  async healthCheck() {
    // TODO: Implement a real health check (e.g. verify sandbox runtime is available)
    return { healthy: true };
  },
} satisfies AtlasSandboxPlugin);
`;
  }
}

/** Generate test template for a scaffolded plugin, with assertions for the given plugin type. */
export function pluginTestTemplate(name: string, pluginType: ScaffoldPluginType): string {
  return `import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("${name} plugin", () => {
  test("has correct id and type", () => {
    expect(plugin.id).toBe("${name}");
    expect(plugin.types).toContain("${pluginType}");
  });

  test("has a version string", () => {
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.length).toBeGreaterThan(0);
  });

  test("healthCheck returns healthy", async () => {
    const result = await plugin.healthCheck?.();
    expect(result?.healthy).toBe(true);
  });
});
`;
}

/** Generate package.json for a scaffolded plugin. Package is named "atlas-plugin-{name}". */
export function pluginPackageJsonTemplate(name: string): string {
  return JSON.stringify(
    {
      name: `atlas-plugin-${name}`,
      version: "0.1.0",
      private: true,
      main: "src/index.ts",
      scripts: {
        test: "bun test src/index.test.ts",
      },
      peerDependencies: {
        "@useatlas/plugin-sdk": "workspace:*",
      },
      devDependencies: {
        "@useatlas/plugin-sdk": "workspace:*",
      },
    },
    null,
    2,
  ) + "\n";
}

/** Generate tsconfig.json for a scaffolded plugin at plugins/{name}/. Extends root tsconfig three levels up. */
export function pluginTsconfigTemplate(): string {
  return JSON.stringify(
    {
      extends: "../../../tsconfig.json",
      compilerOptions: {
        outDir: "./dist",
        rootDir: "./src",
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n";
}

export async function handlePluginCreate(args: string[]): Promise<void> {
  // Expected args: ["create", "<name>", "--type", "<type>"]
  const createIdx = args.indexOf("create");
  const name = args[createIdx + 1];
  if (!name || name.startsWith("--")) {
    console.error("Usage: atlas plugin create <name> --type <datasource|context|interaction|action|sandbox>");
    process.exit(1);
  }

  const typeArg = getFlag(args, "--type");
  if (!typeArg || !isValidPluginType(typeArg)) {
    console.error(`Error: --type is required and must be one of: ${PLUGIN_TYPES.join(", ")}`);
    process.exit(1);
  }

  if (!/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(name)) {
    console.error('Error: Plugin name must start with a letter and contain only letters, digits, hyphens, and underscores.');
    process.exit(1);
  }

  const pluginDir = path.resolve("plugins", name);
  const srcDir = path.join(pluginDir, "src");

  if (fs.existsSync(pluginDir)) {
    console.error(`Error: Directory already exists: ${pluginDir}`);
    process.exit(1);
  }

  fs.mkdirSync(srcDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(srcDir, "index.ts"), pluginTemplate(name, typeArg));
    fs.writeFileSync(path.join(srcDir, "index.test.ts"), pluginTestTemplate(name, typeArg));
    fs.writeFileSync(path.join(pluginDir, "package.json"), pluginPackageJsonTemplate(name));
    fs.writeFileSync(path.join(pluginDir, "tsconfig.json"), pluginTsconfigTemplate());
  } catch (err) {
    try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    console.error(`Error: Failed to write plugin files: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`Created ${typeArg} plugin scaffold at ${path.relative(process.cwd(), pluginDir)}/`);
  console.log("");
  console.log("Files:");
  console.log(`  src/index.ts       — Plugin implementation (definePlugin)`);
  console.log(`  src/index.test.ts  — Basic lifecycle tests`);
  console.log(`  package.json       — Package manifest`);
  console.log(`  tsconfig.json      — TypeScript config`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Implement your plugin in src/index.ts`);
  console.log(`  2. Add to atlas.config.ts:`);
  console.log(`     import plugin from "./plugins/${name}/src/index";`);
  console.log(`     export default defineConfig({ plugins: [plugin] });`);
  console.log(`  3. Run tests: cd plugins/${name} && bun test`);
}

export async function handlePluginAdd(args: string[]): Promise<void> {
  // Expected args: ["add", "<package-name>"]
  const addIdx = args.indexOf("add");
  const packageName = args[addIdx + 1];
  if (!packageName || packageName.startsWith("--")) {
    console.error("Usage: atlas plugin add <package-name>");
    process.exit(1);
  }

  console.log(`Installing ${packageName}...`);

  let exitCode: number;
  try {
    const proc = Bun.spawn(["bun", "add", packageName], {
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch (err) {
    console.error(`Error: Failed to run "bun add ${packageName}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (exitCode !== 0) {
    console.error(`\nFailed to install ${packageName} (exit code ${exitCode}).`);
    process.exit(1);
  }

  console.log("");
  console.log(`Installed ${packageName}. Now add it to your atlas.config.ts:`);
  console.log("");
  console.log(`  import { defineConfig } from "@atlas/api/lib/config";`);
  console.log(`  import myPlugin from "${packageName}";`);
  console.log("");
  console.log(`  export default defineConfig({`);
  console.log(`    plugins: [`);
  console.log(`      myPlugin, // or myPlugin() if it exports a factory`);
  console.log(`    ],`);
  console.log(`  });`);
}

async function handlePlugin(args: string[]): Promise<void> {
  // args: ["plugin", <subcommand>, ...]
  const subcommand = args[1];

  if (subcommand === "list") {
    return handlePluginList();
  }

  if (subcommand === "create") {
    return handlePluginCreate(args.slice(1));
  }

  if (subcommand === "add") {
    return handlePluginAdd(args.slice(1));
  }

  console.error(
    "Usage: atlas plugin <list|create|add>\n\n" +
    "Subcommands:\n" +
    "  list                          List installed plugins from atlas.config.ts\n" +
    "  create <name> --type <type>   Scaffold a new plugin (datasource|context|interaction|action|sandbox)\n" +
    "  add <package-name>            Install a plugin package via bun\n"
  );
  process.exit(1);
}

async function handleQuery(args: string[]): Promise<void> {
  // Parse the question — first positional arg after "query"
  const question = args.find((a, i) => i > 0 && !a.startsWith("--") && (i === 1 || args[i - 1] !== "--connection"));

  if (!question) {
    console.error(
      'Usage: atlas query "your question" [options]\n\n' +
      "Options:\n" +
      "  --json               Raw JSON output (pipe-friendly)\n" +
      "  --csv                CSV output (headers + rows only)\n" +
      "  --quiet              Data only — no narrative, SQL, or stats\n" +
      "  --auto-approve       Auto-approve any pending actions\n" +
      "  --connection <id>    Query a specific datasource\n\n" +
      "Environment:\n" +
      "  ATLAS_API_URL        API server URL (default: http://localhost:3001)\n" +
      "  ATLAS_API_KEY        API key for authentication\n\n" +
      "Examples:\n" +
      '  atlas query "top 5 customers by revenue"\n' +
      '  atlas query "active alerts" --json\n' +
      '  atlas query "count of users" --csv\n' +
      '  atlas query "alerts" --connection cybersec',
    );
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");
  const csvOutput = args.includes("--csv");
  const quietOutput = args.includes("--quiet");
  const autoApprove = args.includes("--auto-approve");
  const connectionId = getFlag(args, "--connection");

  if (jsonOutput && csvOutput) {
    console.error("Error: --json and --csv are mutually exclusive.");
    process.exit(1);
  }

  const apiUrl = (process.env.ATLAS_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const apiKey = process.env.ATLAS_API_KEY;

  // Build request
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = { question, ...(connectionId && { connectionId }) };

  // Call the API
  if (!jsonOutput && !csvOutput) process.stderr.write("Thinking...\n");

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/v1/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) {
      console.error("Error: Request timed out after 120 seconds.");
      console.error("  The query may be too complex, or the server may be overloaded.");
    } else if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      console.error(`Error: Cannot connect to Atlas API at ${apiUrl}`);
      console.error("  Is the server running? Start it with: bun run dev:api");
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  // Handle HTTP errors
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let errorCode: string | undefined;
    try {
      const errorBody = (await res.json()) as QueryAPIError;
      if (errorBody.message) message = errorBody.message;
      errorCode = errorBody.error;
    } catch {
      try {
        const text = await res.text();
        if (text.length > 0 && text.length < 500) message = `HTTP ${res.status}: ${text.trim()}`;
      } catch {
        // Body unreadable — use HTTP status fallback
      }
    }

    if (res.status === 401 || res.status === 403) {
      console.error(`Error: Authentication failed — ${message}`);
      console.error("  Set ATLAS_API_KEY to a valid API key.");
    } else if (res.status === 429) {
      console.error(`Error: Rate limit exceeded — ${message}`);
    } else if (errorCode === "no_datasource") {
      console.error(`Error: ${message}`);
      console.error("  The API server has no datasource configured. Set ATLAS_DATASOURCE_URL on the server.");
    } else if (errorCode === "configuration_error") {
      console.error(`Error: Server configuration problem — ${message}`);
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }

  let data: QueryAPIResponse;
  try {
    data = (await res.json()) as QueryAPIResponse;
  } catch {
    console.error("Error: Failed to parse API response as JSON.");
    console.error(`  The server at ${apiUrl} returned a 200 status but the body was not valid JSON.`);
    process.exit(1);
  }

  // Runtime validation of response shape
  if (!Array.isArray(data.data)) {
    console.error("Error: Unexpected API response — the server may be running a different version.");
    if (data.answer) console.log(`\n${data.answer}`);
    process.exit(1);
  }
  if (!Array.isArray(data.sql)) data.sql = [];
  if (!data.usage || typeof data.usage.totalTokens !== "number") {
    data.usage = { totalTokens: 0 };
  }

  // --- JSON output: print raw response and exit ---
  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // --- CSV output: headers + rows, no narrative ---
  if (csvOutput) {
    for (const dataset of data.data) {
      console.log(dataset.columns.map(quoteCsvField).join(","));
      for (const row of dataset.rows) {
        const cells = dataset.columns.map((col) => quoteCsvField(formatCsvValue(row[col])));
        console.log(cells.join(","));
      }
    }
    return;
  }

  // --- Table output (default) ---

  // Narrative answer
  if (!quietOutput && data.answer) {
    console.log(`\n${data.answer}\n`);
  }

  // Data tables
  for (const dataset of data.data) {
    if (dataset.columns.length > 0 && dataset.rows.length > 0) {
      console.log(renderTable(dataset.columns, dataset.rows));
      console.log();
    }
  }

  // Footer: SQL + stats
  if (!quietOutput) {
    if (data.sql.length > 0) {
      console.log(pc.dim(`SQL: ${data.sql[data.sql.length - 1]}`));
    }
    const tokens = typeof data.usage?.totalTokens === "number" ? data.usage.totalTokens.toLocaleString() : "n/a";
    console.log(pc.dim(`Steps: ${data.steps ?? "?"} | Tokens: ${tokens}`));
  }

  // --- Handle pending actions ---
  if (data.pendingActions?.length) {
    console.log();
    console.log(pc.yellow(`${data.pendingActions.length} action(s) require approval:`));

    if (autoApprove) {
      // Auto-approve all pending actions
      for (const action of data.pendingActions) {
        process.stderr.write(`  Approving: ${action.summary}... `);
        const result = await handleActionApproval(action.approveUrl, apiKey);
        if (result.ok) {
          console.error(pc.green(`${result.status ?? "approved"}`));
        } else {
          console.error(pc.red(`failed: ${result.error}`));
        }
      }
    } else if (process.stdout.isTTY) {
      // Interactive TTY mode — prompt per action
      for (const action of data.pendingActions) {
        console.log(`\n  ${pc.bold(action.type)}: ${action.summary}`);
        if (action.target) console.log(`  Target: ${action.target}`);

        const choice = await p.select({
          message: "What would you like to do?",
          options: [
            { value: "approve", label: "Approve" },
            { value: "deny", label: "Deny" },
            { value: "skip", label: "Skip (decide later)" },
          ],
        });

        if (p.isCancel(choice) || choice === "skip") {
          console.log(pc.dim(`  Skipped. Approve/deny later:`));
          console.log(pc.dim(`    Approve: curl -X POST ${action.approveUrl}`));
          console.log(pc.dim(`    Deny:    curl -X POST ${action.denyUrl}`));
          continue;
        }

        const url = choice === "approve" ? action.approveUrl : action.denyUrl;
        const result = await handleActionApproval(url, apiKey);
        if (result.ok) {
          console.log(pc.green(`  Action ${result.status ?? choice}d.`));
        } else {
          console.log(pc.red(`  Failed: ${result.error}`));
        }
      }
    } else {
      // Non-TTY, no --auto-approve — print URLs and exit
      for (const action of data.pendingActions) {
        console.log(`\n  ${action.type}: ${action.summary}`);
        console.log(`    Approve: ${action.approveUrl}`);
        console.log(`    Deny:    ${action.denyUrl}`);
      }
    }
  }
}

// --- Index CLI handler ---

async function handleIndex(args: string[]): Promise<void> {
  const statsOnly = args.includes("--stats");

  if (!fs.existsSync(SEMANTIC_DIR)) {
    console.error(pc.red("No semantic/ directory found. Run 'atlas init' first."));
    process.exit(1);
  }

  try {
    const { getSemanticIndexStats, buildSemanticIndex } = await import("@atlas/api/lib/semantic-index");

    // Use stats-based validation — works for both default and per-source layouts
    const stats = getSemanticIndexStats(SEMANTIC_DIR);

    if (stats.entities === 0) {
      console.error(pc.red("No valid entity YAML files found in semantic/. Run 'atlas init' first."));
      process.exit(1);
    }

    if (statsOnly) {
      console.log(
        `${pc.bold("Semantic index stats:")} ` +
        `${stats.entities} entities, ${stats.dimensions} dimensions, ` +
        `${stats.measures} measures, ${stats.metrics} metrics, ` +
        `${stats.glossaryTerms} glossary terms (${stats.keywords} keywords)`
      );
      return;
    }

    // Full rebuild — buildSemanticIndex does its own loading; stats above are for validation + display
    const start = Date.now();
    buildSemanticIndex(SEMANTIC_DIR);
    const elapsed = Date.now() - start;

    console.log(
      pc.green("✓") + ` Indexed ${stats.entities} entities, ` +
      `${stats.dimensions} dimensions, ${stats.measures} measures ` +
      `(${stats.keywords} keywords) in ${elapsed}ms`
    );
  } catch (err) {
    console.error(pc.red("Failed to build semantic index."));
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// --- Learn CLI handler ---

async function handleLearn(args: string[]): Promise<void> {
  const applyMode = args.includes("--apply");
  const limitArg = getFlag(args, "--limit");
  const sinceArg = getFlag(args, "--since");
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");

  // Resolve semantic directories
  const semanticRoot = sourceArg
    ? path.join(SEMANTIC_DIR, sourceArg)
    : SEMANTIC_DIR;
  const entitiesDir = sourceArg
    ? path.join(semanticRoot, "entities")
    : ENTITIES_DIR;

  // Validate semantic layer exists
  if (!fs.existsSync(entitiesDir)) {
    console.error(pc.red(`No entities found at ${entitiesDir}. Run 'atlas init' first.`));
    process.exit(1);
  }

  // Validate internal DB is configured
  if (!process.env.DATABASE_URL) {
    console.error(pc.red("DATABASE_URL is required for atlas learn."));
    console.error("  The audit log is stored in the internal database.");
    console.error("  Set DATABASE_URL=postgresql://... to enable audit log analysis.");
    process.exit(1);
  }

  // Validate --limit
  const limit = limitArg ? parseInt(limitArg, 10) : 1000;
  if (Number.isNaN(limit) || limit <= 0) {
    console.error(pc.red(`Invalid value for --limit: "${limitArg}". Expected a positive integer.`));
    process.exit(1);
  }

  // Validate --since
  if (sinceArg) {
    const sinceDate = new Date(sinceArg);
    if (Number.isNaN(sinceDate.getTime())) {
      console.error(pc.red(`Invalid value for --since: "${sinceArg}". Expected ISO 8601 format (e.g., 2026-03-01).`));
      process.exit(1);
    }
  }

  console.log(`\nAtlas Learn — analyzing audit log for YAML improvements...\n`);

  const { getInternalDB, closeInternalDB } = await import("@atlas/api/lib/db/internal");
  try {
    const { fetchAuditLog, analyzeQueries } = await import("../lib/learn/analyze");
    const { loadEntities, loadGlossary, generateProposals, applyProposals } = await import("../lib/learn/propose");
    const { formatDiff, formatSummary } = await import("../lib/learn/diff");

    // 1. Fetch audit log
    const pool = getInternalDB();
    const rows = await fetchAuditLog(pool, { limit, since: sinceArg });

    if (rows.length === 0) {
      console.log(pc.yellow("No successful queries found in the audit log."));
      console.log("  Run some queries first, then try again.");
      return;
    }

    console.log(`  Analyzed ${pc.bold(String(rows.length))} successful queries`);

    // 2. Analyze patterns
    const analysis = analyzeQueries(rows);
    console.log(`  Found ${pc.bold(String(analysis.patterns.length))} recurring patterns, ` +
      `${pc.bold(String(analysis.joins.size))} join pairs, ` +
      `${pc.bold(String(analysis.aliases.length))} column aliases`);

    // 3. Load existing YAML
    const entities = loadEntities(entitiesDir);
    const glossaryData = loadGlossary(semanticRoot);

    if (entities.size === 0) {
      console.error(pc.red(`No valid entity YAML files found in ${entitiesDir}.`));
      process.exit(1);
    }

    console.log(`  Comparing against ${pc.bold(String(entities.size))} entities\n`);

    // 4. Generate proposals
    const proposalSet = generateProposals(analysis, entities, glossaryData);

    // 5. Output results
    console.log(formatSummary(proposalSet));

    if (proposalSet.proposals.length > 0) {
      console.log(formatDiff(proposalSet));

      if (applyMode) {
        const { written, failed } = applyProposals(proposalSet);
        if (written.length > 0) {
          console.log(pc.green(`\n✓ Applied changes to ${written.length} file(s):`));
          for (const f of written) {
            console.log(`  ${f.replace(process.cwd() + "/", "")}`);
          }
        }
        if (failed.length > 0) {
          console.error(pc.red(`\n✗ Failed to write ${failed.length} file(s):`));
          for (const f of failed) {
            console.error(`  ${f.path.replace(process.cwd() + "/", "")}: ${f.error}`);
          }
          process.exit(1);
        }
      } else {
        console.log(pc.dim("\nDry run — no files modified. Use --apply to write changes."));
      }
    }
  } catch (err) {
    console.error(pc.red("Failed to analyze audit log."));
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await closeInternalDB();
  }
}

// --- Diff CLI handler ---

async function handleDiff(args: string[]): Promise<void> {
  const connStr = process.env.ATLAS_DATASOURCE_URL;
  if (!connStr) {
    console.error("Error: ATLAS_DATASOURCE_URL is required for atlas diff.");
    console.error("  PostgreSQL:  ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname");
    console.error("  MySQL:       ATLAS_DATASOURCE_URL=mysql://user:pass@host:3306/dbname");
    console.error("  Snowflake:   ATLAS_DATASOURCE_URL=snowflake://user:pass@account/database/schema?warehouse=WH");
    console.error("  Salesforce:  ATLAS_DATASOURCE_URL=salesforce://user:pass@login.salesforce.com?token=TOKEN");
    process.exit(1);
  }

  // Determine entities directory — per-source layout if --source is provided
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");
  const entitiesDir = sourceArg
    ? path.join(SEMANTIC_DIR, sourceArg, "entities")
    : ENTITIES_DIR;

  // Check semantic layer exists
  if (!fs.existsSync(entitiesDir)) {
    console.error(`Error: ${entitiesDir} not found. Run \`bun run atlas -- init${sourceArg ? ` --source ${sourceArg}` : ""}\` first.`);
    process.exit(1);
  }
  const yamlFiles = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
  if (yamlFiles.length === 0) {
    console.error(`Error: No entity YAMLs found in ${entitiesDir}. Run \`bun run atlas -- init${sourceArg ? ` --source ${sourceArg}` : ""}\` first.`);
    process.exit(1);
  }

  let dbType: DBType;
  try {
    dbType = detectDBType(connStr);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Test connection
  console.log("Testing database connection...");
  if (dbType === "mysql") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = require("mysql2/promise");
    const testPool = mysql.createPool({ uri: connStr, connectionLimit: 1, connectTimeout: 5000 });
    try {
      const [rows] = await testPool.execute("SELECT VERSION() as v");
      console.log(`Connected: MySQL ${(rows as { v: string }[])[0].v}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and the MySQL server is running.`);
      process.exit(1);
    } finally {
      await testPool.end();
    }
  } else if (dbType === "clickhouse") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@clickhouse/client");
    const testClient = createClient({ url: rewriteClickHouseUrl(connStr) });
    try {
      const rows = await clickhouseQuery<{ v: string }>(testClient, "SELECT version() as v");
      console.log(`Connected: ClickHouse ${rows[0].v}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and the ClickHouse server is running.`);
      process.exit(1);
    } finally {
      await testClient.close().catch((closeErr: unknown) => {
        console.warn(`[atlas] ClickHouse client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      });
    }
  } else if (dbType === "snowflake") {
    const { pool: testPool } = await createSnowflakePool(connStr, 1);
    try {
      const result = await snowflakeQuery(testPool, "SELECT CURRENT_VERSION() as V");
      console.log(`Connected: Snowflake ${result.rows[0]?.V ?? "unknown"}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and the Snowflake account is accessible.`);
      process.exit(1);
    } finally {
      await testPool.drain().catch((err: unknown) => {
        console.warn(`[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`);
      });
      try { await testPool.clear(); } catch (err: unknown) {
        console.warn(`[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (dbType === "salesforce") {
    const { parseSalesforceURL, createSalesforceConnection } = await import("../../../plugins/salesforce/src/connection");
    const config = parseSalesforceURL(connStr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source: any = createSalesforceConnection(config);
    try {
      const objects = await source.listObjects();
      console.log(`Connected: Salesforce (${objects.length} queryable objects)`);
    } catch (err) {
      console.error(`\nError: Cannot connect to Salesforce.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and your Salesforce credentials are valid.`);
      process.exit(1);
    } finally {
      await source.close();
    }
  } else {
    const testPool = new Pool({ connectionString: connStr, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const client = await testPool.connect();
      const versionResult = await client.query("SELECT version()");
      console.log(`Connected: ${versionResult.rows[0]?.version?.split(",")[0] ?? "unknown"}`);
      client.release();
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and the server is running.`);
      process.exit(1);
    } finally {
      await testPool.end();
    }
  }

  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;
  let schemaArg = getFlag(args, "--schema") ?? process.env.ATLAS_SCHEMA ?? "public";

  validateSchemaName(schemaArg);
  if (schemaArg !== "public" && dbType !== "postgres") {
    console.warn(`Warning: --schema is only supported for PostgreSQL. Ignoring "${schemaArg}" for ${dbType}.`);
    schemaArg = "public";
  }

  // Profile live DB
  console.log(`\nProfiling ${dbType} database...\n`);
  let profiles: TableProfile[];
  try {
    let result: ProfilingResult;
    switch (dbType) {
      case "mysql":
        result = await profileMySQL(connStr, filterTables);
        break;
      case "postgres":
        result = await profilePostgres(connStr, filterTables, undefined, schemaArg);
        break;
      case "clickhouse":
        result = await profileClickHouse(connStr, filterTables);
        break;
      case "snowflake":
        result = await profileSnowflake(connStr, filterTables);
        break;
      case "duckdb": {
        const { parseDuckDBUrl } = await import("../../../plugins/duckdb/src/connection");
        const duckConfig = parseDuckDBUrl(connStr);
        result = await profileDuckDB(duckConfig.path, filterTables);
        break;
      }
      case "salesforce":
        result = await profileSalesforce(connStr, filterTables);
        break;
      default: {
        throw new Error(`Unknown database type: ${dbType}`);
      }
    }
    profiles = result.profiles;
    if (result.errors.length > 0) {
      const total = result.profiles.length + result.errors.length;
      logProfilingErrors(result.errors, total);
      console.warn(`Continuing diff with ${profiles.length} successfully profiled tables.\n`);
    }
  } catch (err) {
    console.error(`\nError: Failed to profile database.`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (profiles.length === 0) {
    console.error("Error: No tables were profiled from the database.");
    process.exit(1);
  }

  // Run FK inference so inferred FKs are comparable
  analyzeTableProfiles(profiles);

  // Build DB snapshots
  const dbSnapshots = new Map<string, EntitySnapshot>();
  for (const profile of profiles) {
    dbSnapshots.set(profile.table_name, profileToSnapshot(profile));
  }

  // Parse YAML snapshots
  const yamlSnapshots = new Map<string, EntitySnapshot>();
  const yamlErrors: string[] = [];
  for (const file of yamlFiles) {
    try {
      const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
      const doc = yaml.load(content) as Record<string, unknown>;
      if (!doc || typeof doc.table !== "string") {
        console.warn(`[atlas diff] Skipping ${file}: missing or non-string 'table' field`);
        continue;
      }
      const tableName = doc.table as string;
      // If --tables filter is set, only include matching YAML entities
      if (filterTables && !filterTables.includes(tableName)) continue;
      yamlSnapshots.set(tableName, parseEntityYAML(doc));
    } catch (err) {
      yamlErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (yamlErrors.length > 0) {
    console.warn(`\nWarning: Failed to parse ${yamlErrors.length} YAML file(s):`);
    for (const e of yamlErrors) console.warn(`  - ${e}`);
  }
  if (yamlSnapshots.size === 0 && yamlFiles.length > 0) {
    console.warn(`\nWarning: No valid entity YAML files found despite files existing in ${entitiesDir}.`);
  }

  // Compute and display diff
  const diff = computeDiff(dbSnapshots, yamlSnapshots);
  console.log(formatDiff(diff, dbSnapshots));

  const hasDrift =
    diff.newTables.length > 0 ||
    diff.removedTables.length > 0 ||
    diff.tableDiffs.length > 0;

  process.exit(hasDrift ? 1 : 0);
}

// --- Profile a single datasource ---

export interface ProfileDatasourceOpts {
  id: string;              // "default", "warehouse", etc.
  url: string;
  dbType: DBType;
  schema: string;          // resolved schema for this datasource
  filterTables?: string[];
  shouldEnrich: boolean;
  explicitEnrich: boolean;
  demoDataset: DemoDataset | null;  // null for multi-source runs (--demo is single-datasource only)
  force: boolean;          // skip failure threshold check
  orgId?: string;          // org-scoped mode: write to semantic/.orgs/{orgId}/
}

/**
 * Compute the output base directory for a datasource.
 * "default" → `semantic/`, anything else → `semantic/{id}/`.
 * When orgId is provided: `semantic/.orgs/{orgId}/` (or `.orgs/{orgId}/{id}/`).
 * Returns an absolute path resolved from the process working directory.
 */
export function outputDirForDatasource(id: string, orgId?: string): string {
  const base = orgId ? path.join(SEMANTIC_DIR, ".orgs", orgId) : SEMANTIC_DIR;
  return id === "default" ? base : path.join(base, id);
}

export interface DatasourceEntry {
  id: string;
  url: string;
  schema: string;
}

async function profileDatasource(opts: ProfileDatasourceOpts): Promise<void> {
  const { id, url: connStr, dbType, filterTables, shouldEnrich, explicitEnrich, demoDataset, force, orgId } = opts;
  let { schema: schemaArg } = opts;

  validateSchemaName(schemaArg);

  // The source name for YAML connection: field — "default" omits it
  const sourceId = id === "default" ? undefined : id;

  // --schema is PostgreSQL-only
  if (schemaArg !== "public" && dbType !== "postgres") {
    console.warn(`Warning: --schema is only supported for PostgreSQL. Ignoring "${schemaArg}" for ${dbType}.`);
    schemaArg = "public";
  }

  // Seed demo data if requested
  if (demoDataset) {
    if (dbType !== "postgres") {
      console.error(
        `Error: --demo is not supported for ${dbType}. Demo SQL files use PostgreSQL-specific syntax.` +
        (dbType === "duckdb" ? " For DuckDB, use --csv or --parquet instead." : "")
      );
      throw new Error(`--demo is not supported for ${dbType}.`);
    }
    console.log(`Seeding ${demoDataset} demo data (${dbType})...`);
    await seedDemoPostgres(connStr, demoDataset);
    console.log("");
  }

  // Test connection before profiling
  console.log("Testing database connection...");
  if (dbType === "mysql") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = require("mysql2/promise");
    const testPool = mysql.createPool({
      uri: connStr,
      connectionLimit: 1,
      connectTimeout: 5000,
    });
    try {
      const [rows] = await testPool.execute("SELECT VERSION() as v");
      console.log(`Connected: MySQL ${(rows as { v: string }[])[0].v}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that the datasource URL is correct and the MySQL server is running.`);
      throw err;
    } finally {
      await testPool.end();
    }
  } else if (dbType === "clickhouse") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@clickhouse/client");
    const testClient = createClient({ url: rewriteClickHouseUrl(connStr) });
    try {
      const rows = await clickhouseQuery<{ v: string }>(testClient, "SELECT version() as v");
      console.log(`Connected: ClickHouse ${rows[0].v}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that the datasource URL is correct and the ClickHouse server is running.`);
      throw err;
    } finally {
      await testClient.close().catch((closeErr: unknown) => {
        console.warn(`[atlas] ClickHouse client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      });
    }
  } else if (dbType === "snowflake") {
    const { pool: testPool } = await createSnowflakePool(connStr, 1);
    try {
      const result = await snowflakeQuery(testPool, "SELECT CURRENT_VERSION() as V");
      console.log(`Connected: Snowflake ${result.rows[0]?.V ?? "unknown"}`);
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that the datasource URL is correct and the Snowflake account is accessible.`);
      throw err;
    } finally {
      await testPool.drain().catch((err: unknown) => {
        console.warn(`[atlas] Snowflake pool drain warning: ${err instanceof Error ? err.message : String(err)}`);
      });
      try { await testPool.clear(); } catch (err: unknown) {
        console.warn(`[atlas] Snowflake pool clear warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (dbType === "duckdb") {
    try {
      const { parseDuckDBUrl } = await import("../../../plugins/duckdb/src/connection");
      const duckConfig = parseDuckDBUrl(connStr);
      const DuckDBInstance = await loadDuckDB();
      const testInstance = await DuckDBInstance.create(duckConfig.path, { access_mode: "READ_ONLY" });
      const testConn = await testInstance.connect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reader = await (testConn as any).runAndReadAll("SELECT version() as v");
      const version = reader.getRowObjects()[0]?.v ?? "unknown";
      console.log(`Connected: DuckDB ${version}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (testConn as any).disconnectSync();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (testInstance as any).closeSync();
    } catch (err) {
      console.error(`\nError: Cannot open DuckDB database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL points to a valid DuckDB file.`);
      process.exit(1);
    }
  } else if (dbType === "salesforce") {
    const { parseSalesforceURL, createSalesforceConnection } = await import("../../../plugins/salesforce/src/connection");
    const config = parseSalesforceURL(connStr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source: any = createSalesforceConnection(config);
    try {
      const objects = await source.listObjects();
      console.log(`Connected: Salesforce (${objects.length} queryable objects)`);
    } catch (err) {
      console.error(`\nError: Cannot connect to Salesforce.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that ATLAS_DATASOURCE_URL is correct and your Salesforce credentials are valid.`);
      process.exit(1);
    } finally {
      await source.close();
    }
  } else {
    const testPool = new Pool({ connectionString: connStr, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const client = await testPool.connect();
      const versionResult = await client.query("SELECT version()");
      console.log(`Connected: ${versionResult.rows[0]?.version?.split(",")[0] ?? "unknown"}`);
      client.release();
    } catch (err) {
      console.error(`\nError: Cannot connect to database.`);
      console.error(err instanceof Error ? err.message : String(err));
      console.error(`\nCheck that the datasource URL is correct and the server is running.`);
      throw err;
    } finally {
      await testPool.end();
    }
  }

  // Interactive table/view selection (TTY only, when --tables and --demo not provided)
  let selectedTables = filterTables;
  let prefetchedObjects: DatabaseObject[] | undefined;

  if (!selectedTables && !demoDataset && process.stdin.isTTY) {
    let allObjects: DatabaseObject[];
    try {
      switch (dbType) {
        case "mysql":
          allObjects = await listMySQLObjects(connStr);
          break;
        case "postgres":
          allObjects = await listPostgresObjects(connStr, schemaArg);
          break;
        case "clickhouse":
          allObjects = await listClickHouseObjects(connStr);
          break;
        case "snowflake":
          allObjects = await listSnowflakeObjects(connStr);
          break;
        case "duckdb": {
          const { parseDuckDBUrl } = await import("../../../plugins/duckdb/src/connection");
          const duckConfig = parseDuckDBUrl(connStr);
          allObjects = await listDuckDBObjects(duckConfig.path);
          break;
        }
        case "salesforce":
          allObjects = await listSalesforceObjects(connStr);
          break;
        default: {
          throw new Error(`Unknown database type: ${dbType}`);
        }
      }
    } catch (err) {
      console.error(`\nError: Failed to list tables from ${dbType} database.`);
      console.error(err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (allObjects.length === 0) {
      throw new Error("No tables or views found in the database.");
    }

    const selected = await p.multiselect({
      message: `Select tables/views to profile (${allObjects.length} found)`,
      options: allObjects.map((obj) => ({
        value: obj.name,
        label: obj.type === "view" ? `${obj.name} (view)` : obj.name,
      })),
      initialValues: allObjects.map((obj) => obj.name),
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel("Selection cancelled.");
      throw new Error("Selection cancelled.");
    }

    selectedTables = selected as string[];

    if (selectedTables.length === 0) {
      p.cancel("No tables or views selected.");
      throw new Error("No tables or views selected.");
    }

    prefetchedObjects = allObjects;
    p.log.info(`Selected ${pc.cyan(String(selectedTables.length))} of ${allObjects.length} tables/views.`);
  } else if (!selectedTables && demoDataset) {
    console.log("Demo mode: profiling all tables and views.");
  } else if (!selectedTables) {
    console.log("Non-interactive mode: profiling all tables and views. Use --tables to select specific ones.");
  }

  console.log(`\nAtlas Init — profiling ${dbType} database...\n`);

  const progress = createProgressTracker();
  const profilingStart = Date.now();

  let result: ProfilingResult;
  switch (dbType) {
    case "mysql":
      result = await profileMySQL(connStr, selectedTables, prefetchedObjects, progress);
      break;
    case "postgres":
      result = await profilePostgres(connStr, selectedTables, prefetchedObjects, schemaArg, progress);
      break;
    case "clickhouse":
      result = await profileClickHouse(connStr, selectedTables, prefetchedObjects, progress);
      break;
    case "snowflake":
      result = await profileSnowflake(connStr, selectedTables, prefetchedObjects, progress);
      break;
    case "duckdb": {
      const { parseDuckDBUrl } = await import("../../../plugins/duckdb/src/connection");
      const duckConfig = parseDuckDBUrl(connStr);
      result = await profileDuckDB(duckConfig.path, selectedTables, prefetchedObjects, progress);
      break;
    }
    case "salesforce":
      result = await profileSalesforce(connStr, selectedTables, prefetchedObjects, progress);
      break;
    default: {
      throw new Error(`Unknown database type: ${dbType}`);
    }
  }

  const { profiles, errors: profilingErrors } = result;
  const profilingElapsed = Date.now() - profilingStart;
  progress.onComplete(profiles.length, profilingElapsed);

  if (profiles.length === 0) {
    throw new Error("No tables or views were successfully profiled. Check the warnings above and verify your database permissions.");
  }

  // Always warn about profiling errors
  if (profilingErrors.length > 0) {
    const totalAttempted = profiles.length + profilingErrors.length;
    logProfilingErrors(profilingErrors, totalAttempted);

    const { shouldAbort } = checkFailureThreshold(result, force);
    if (shouldAbort) {
      console.error(`\nThis usually indicates a connection or permission issue.`);
      console.error(`Run \`atlas doctor\` to diagnose. Use \`--force\` to continue anyway.`);
      throw new Error(
        `Profiling failed for ${profilingErrors.length}/${totalAttempted} tables ` +
        `(${Math.round((profilingErrors.length / totalAttempted) * 100)}%). ` +
        `Use --force to continue anyway.`
      );
    }
    console.warn(`Continuing with ${profiles.length} successfully profiled tables.\n`);
  }

  // Run profiler heuristics
  analyzeTableProfiles(profiles);

  const tableCount = profiles.filter((p) => !isViewLike(p)).length;
  const viewCount = profiles.filter((p) => isView(p)).length;
  const matviewCount = profiles.filter((p) => isMatView(p)).length;
  const countParts: string[] = [];
  countParts.push(`${tableCount} table${tableCount !== 1 ? "s" : ""}`);
  if (viewCount > 0) countParts.push(`${viewCount} view${viewCount !== 1 ? "s" : ""}`);
  if (matviewCount > 0) countParts.push(`${matviewCount} materialized view${matviewCount !== 1 ? "s" : ""}`);
  console.log(`Found ${countParts.join(", ")}:\n`);
  for (const p of profiles) {
    const fkCount = p.foreign_keys.length;
    const inferredFkCount = p.inferred_foreign_keys.length;
    const pkInfo = p.primary_key_columns.length > 0 ? ` PK: ${p.primary_key_columns.join(",")}` : "";
    const fkInfo = fkCount > 0 ? ` FKs: ${fkCount}` : "";
    const inferredFkInfo = inferredFkCount > 0 ? ` +${inferredFkCount} inferred` : "";
    const flags: string[] = [];
    if (isView(p)) flags.push("[view]");
    if (isMatView(p)) flags.push("[matview]");
    if (p.partition_info) flags.push(`[partitioned:${p.partition_info.strategy}]`);
    if (p.table_flags.possibly_abandoned) flags.push("[possibly-abandoned]");
    if (p.table_flags.possibly_denormalized) flags.push("[denormalized]");
    const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
    console.log(
      `  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} cols${pkInfo}${fkInfo}${inferredFkInfo}${flagStr}`
    );
  }

  // Tech debt summary
  const totalInferredFKs = profiles.reduce((n, p) => n + p.inferred_foreign_keys.length, 0);
  const totalAbandoned = profiles.filter((p) => p.table_flags.possibly_abandoned).length;
  const totalEnumIssues = profiles.reduce((n, p) =>
    n + p.columns.filter((c) => c.profiler_notes.some((note) => note.startsWith("Case-inconsistent"))).length, 0);
  const totalDenormalized = profiles.filter((p) => p.table_flags.possibly_denormalized).length;

  if (totalInferredFKs + totalAbandoned + totalEnumIssues + totalDenormalized > 0) {
    console.log(`\nTech debt detected: ${totalInferredFKs} inferred FKs, ${totalAbandoned} abandoned tables, ${totalEnumIssues} enum issues, ${totalDenormalized} denormalized tables`);
  }

  // Compute output directories
  const outputBase = outputDirForDatasource(id, orgId);
  const entitiesOutDir = path.join(outputBase, "entities");
  const metricsOutDir = path.join(outputBase, "metrics");

  // Write files
  fs.mkdirSync(entitiesOutDir, { recursive: true });
  fs.mkdirSync(metricsOutDir, { recursive: true });

  // Clean stale entity/metric files from previous runs
  for (const dir of [entitiesOutDir, metricsOutDir]) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".yml") || file.endsWith(".yaml")) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  }

  // Generate entity YAMLs
  console.log(`\nGenerating semantic layer...\n`);

  for (const profile of profiles) {
    const filePath = path.join(entitiesOutDir, `${profile.table_name}.yml`);
    fs.writeFileSync(filePath, generateEntityYAML(profile, profiles, dbType, schemaArg, sourceId));
    console.log(`  wrote ${filePath}`);
  }

  // Generate catalog
  const catalogPath = path.join(outputBase, "catalog.yml");
  fs.writeFileSync(catalogPath, generateCatalogYAML(profiles));
  console.log(`  wrote ${catalogPath}`);

  // Generate glossary
  const glossaryPath = path.join(outputBase, "glossary.yml");
  fs.writeFileSync(glossaryPath, generateGlossaryYAML(profiles));
  console.log(`  wrote ${glossaryPath}`);

  // Generate metric files per table
  for (const profile of profiles) {
    const metricYaml = generateMetricYAML(profile, schemaArg);
    if (metricYaml) {
      const filePath = path.join(metricsOutDir, `${profile.table_name}.yml`);
      fs.writeFileSync(filePath, metricYaml);
      console.log(`  wrote ${filePath}`);
    }
  }

  // For --demo simple, overlay hand-crafted semantic files with richer descriptions
  if (demoDataset === "simple") {
    const demoSemanticDir = path.resolve(import.meta.dir, "..", "data", "demo-semantic");
    if (fs.existsSync(demoSemanticDir)) {
      console.log(`\nApplying curated demo semantic layer...\n`);
      copyDirRecursive(demoSemanticDir, outputBase);
    }
  }

  // LLM enrichment (optional)
  let enrichmentSucceeded = false;
  if (shouldEnrich) {
    try {
      const { enrichSemanticLayer } = await import("./enrich.js");
      console.log(`\nEnriching with LLM (${process.env.ATLAS_PROVIDER ?? "anthropic"})...\n`);
      await enrichSemanticLayer(profiles, { semanticDir: outputBase });
      enrichmentSucceeded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (explicitEnrich) {
        console.error(`\nLLM enrichment failed: ${msg}`);
        console.error("Base semantic layer was written but enrichment failed.\n");
        throw e;
      } else {
        console.warn(`\nNote: LLM enrichment was auto-detected but failed: ${msg}`);
        console.warn("The semantic layer was generated without LLM enrichment.\n");
      }
    }
  }

  const relativeOutput = orgId
    ? `./semantic/.orgs/${orgId}/`
    : id === "default" ? "./semantic/" : `./semantic/${id}/`;
  console.log(`
Done! Semantic layer written to ${relativeOutput} in ${formatDuration(profilingElapsed)}

Generated:
  - ${profiles.length} entity YAMLs with dimensions, joins, measures, and query patterns${sourceId ? ` (connection: ${id})` : ""}
  - catalog.yml with use_for guidance and common questions
  - glossary.yml with auto-detected terms and ambiguities
  - Metric definitions in metrics/*.yml
${enrichmentSucceeded ? "  - LLM-enriched descriptions, use cases, and business context\n" : ""}
Next steps:
  1. Review the generated YAMLs and refine business context
  2. Run \`bun run dev\` to start Atlas
`);
}

// --- Import ---

async function handleImport(args: string[]): Promise<void> {
  const connectionArg = getFlag(args, "--connection");

  // Determine the API base URL
  const apiUrl = process.env.ATLAS_API_URL ?? "http://localhost:3001";

  // Build the import request
  const importUrl = `${apiUrl}/api/v1/admin/semantic/org/import`;
  const body: Record<string, string> = {};
  if (connectionArg) body.connectionId = connectionArg;

  // Determine auth header
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ATLAS_API_KEY) headers.Authorization = `Bearer ${process.env.ATLAS_API_KEY}`;

  console.log("Importing semantic layer from disk to DB...\n");

  try {
    const resp = await fetch(importUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.error("Import failed: authentication required.");
        console.error("  Set ATLAS_API_KEY environment variable.");
      } else {
        let errorMsg = `HTTP ${resp.status}`;
        try {
          const json = await resp.json() as { message?: string; error?: string };
          errorMsg = json.message ?? json.error ?? errorMsg;
        } catch {
          errorMsg = await resp.text().catch(() => errorMsg);
        }
        console.error(`Import failed: ${errorMsg}`);
      }
      process.exit(1);
    }

    const result = await resp.json() as { imported: number; skipped: number; errors: Array<{ file: string; reason: string }>; total: number };

    console.log(`Imported: ${result.imported}`);
    if (result.skipped > 0) {
      console.log(`Skipped:  ${result.skipped}`);
    }
    console.log(`Total:    ${result.total}`);

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      for (const e of result.errors) {
        console.log(`  ${e.file}: ${e.reason}`);
      }
    }

    if (result.imported > 0) {
      console.log("\nDone! Entities imported to DB. The explore tool and SQL validation will use the updated semantic layer.");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("ECONNREFUSED") || detail.includes("fetch failed")) {
      console.error(`Cannot reach Atlas API at ${apiUrl}. Is the server running?`);
      console.error("  Start it with: bun run dev:api");
      console.error("  Set ATLAS_API_URL if the API is not on localhost:3001");
    } else {
      console.error(`Import failed: ${detail}`);
    }
    process.exit(1);
  }
}

// --- Migrate ---

async function handleMigrate(args: string[]): Promise<void> {
  const shouldApply = args.includes("--apply");

  // Require DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL is required for atlas migrate.");
    console.error("  Set DATABASE_URL to a PostgreSQL connection string for the Atlas internal database.");
    process.exit(1);
  }

  // Load config to get plugin list
  const { loadConfig } = await import("@atlas/api/lib/config");
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const plugins = config.plugins as Array<{ id: string; schema?: Record<string, unknown> }> | undefined;
  if (!plugins?.length) {
    console.log("No plugins configured in atlas.config.ts — nothing to migrate.");
    return;
  }

  // Check which plugins have schemas
  const pluginsWithSchema = plugins.filter((p) => p.schema && Object.keys(p.schema).length > 0);
  if (pluginsWithSchema.length === 0) {
    console.log("No plugins declare a schema — nothing to migrate.");
    return;
  }

  // Generate migration SQL
  const { generateMigrationSQL, applyMigrations, diffSchema } = await import("@atlas/api/lib/plugins/migrate");

  const statements = generateMigrationSQL(pluginsWithSchema as Parameters<typeof generateMigrationSQL>[0]);
  if (statements.length === 0) {
    console.log("No migration statements generated.");
    return;
  }

  if (!shouldApply) {
    // Dry run — print SQL
    console.log("-- Plugin schema migrations (dry run)\n");
    console.log(`-- ${statements.length} table(s) from ${pluginsWithSchema.length} plugin(s)\n`);
    for (const stmt of statements) {
      console.log(`-- Plugin: ${stmt.pluginId}, Table: ${stmt.tableName} → ${stmt.prefixedName}`);
      console.log(stmt.sql);
      console.log();
    }
    console.log("-- Run with --apply to execute these migrations.");

    // Show diff if possible
    try {
      const { getInternalDB } = await import("@atlas/api/lib/db/internal");
      const db = getInternalDB();
      const diff = await diffSchema(db, statements);
      if (diff.newTables.length > 0) {
        console.log(`\nNew tables: ${diff.newTables.join(", ")}`);
      }
      if (diff.existingTables.length > 0) {
        console.log(`Already existing: ${diff.existingTables.join(", ")}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`\n-- Skipped schema diff: could not connect to internal database.`);
      console.log(`--   Reason: ${detail}`);
    }
    return;
  }

  // Apply migrations
  console.log("Applying plugin schema migrations...\n");

  const { getInternalDB } = await import("@atlas/api/lib/db/internal");
  let db;
  try {
    db = getInternalDB();
  } catch (err) {
    console.error(`Error connecting to internal database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let result;
  try {
    result = await applyMigrations(db, statements);
  } catch (err) {
    console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("\nYour database may be in a partially migrated state.");
    console.error("Run 'atlas migrate' (without --apply) to review pending migrations.");
    process.exit(1);
  }

  if (result.applied.length > 0) {
    console.log(`Applied ${result.applied.length} migration(s):`);
    for (const table of result.applied) {
      console.log(`  ✓ ${table}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} already-applied migration(s):`);
    for (const table of result.skipped) {
      console.log(`  - ${table}`);
    }
  }
  if (result.applied.length === 0 && result.skipped.length > 0) {
    console.log("\nAll migrations already applied — nothing to do.");
  } else if (result.applied.length > 0) {
    console.log("\nPlugin schema migrations complete.");
  }
}

// --- Help system ---

interface SubcommandHelp {
  description: string;
  usage: string;
  flags?: Array<{ flag: string; description: string }>;
  subcommands?: Array<{ name: string; description: string }>;
  examples?: string[];
}

function printSubcommandHelp(help: SubcommandHelp): void {
  console.log(`${help.description}\n`);
  console.log(`Usage: atlas ${help.usage}\n`);
  if (help.subcommands?.length) {
    console.log("Subcommands:");
    const maxLen = Math.max(...help.subcommands.map((s) => s.name.length));
    for (const s of help.subcommands) {
      console.log(`  ${s.name.padEnd(maxLen + 2)}${s.description}`);
    }
    console.log();
  }
  if (help.flags?.length) {
    console.log("Options:");
    const maxLen = Math.max(...help.flags.map((f) => f.flag.length));
    for (const f of help.flags) {
      console.log(`  ${f.flag.padEnd(maxLen + 2)}${f.description}`);
    }
    console.log();
  }
  if (help.examples?.length) {
    console.log("Examples:");
    for (const ex of help.examples) {
      console.log(`  ${ex}`);
    }
    console.log();
  }
}

const SUBCOMMAND_HELP: Record<string, SubcommandHelp> = {
  init: {
    description: "Profile a database and generate semantic layer YAML files.",
    usage: "init [options]",
    flags: [
      { flag: "--tables <t1,t2>", description: "Profile only specific tables/views (comma-separated)" },
      { flag: "--schema <name>", description: "PostgreSQL schema name (default: public)" },
      { flag: "--source <name>", description: "Write to semantic/{name}/ subdirectory (mutually exclusive with --connection)" },
      { flag: "--connection <name>", description: "Profile a named datasource from atlas.config.ts (mutually exclusive with --source)" },
      { flag: "--csv <file1.csv,...>", description: "Load CSV files via DuckDB (no DB server needed, requires @duckdb/node-api)" },
      { flag: "--parquet <f1.parquet,...>", description: "Load Parquet files via DuckDB (requires @duckdb/node-api)" },
      { flag: "--enrich", description: "Add LLM-enriched descriptions and query patterns (requires API key)" },
      { flag: "--no-enrich", description: "Explicitly skip LLM enrichment" },
      { flag: "--force", description: "Continue even if more than 20% of tables fail to profile" },
      { flag: "--demo [simple|cybersec|ecommerce]", description: "Load a demo dataset then profile (default: simple)" },
      { flag: "--org <orgId>", description: "Write to semantic/.orgs/{orgId}/ and auto-import to DB (org-scoped mode)" },
      { flag: "--no-import", description: "Skip auto-import to DB in org-scoped mode (write disk only)" },
    ],
    examples: [
      "atlas init",
      "atlas init --tables users,orders,products",
      "atlas init --enrich",
      "atlas init --demo cybersec",
      "atlas init --csv sales.csv,products.csv",
      "atlas init --org org-123",
    ],
  },
  diff: {
    description: "Compare the database schema against the existing semantic layer. Exits with code 1 if drift is detected.",
    usage: "diff [options]",
    flags: [
      { flag: "--tables <t1,t2>", description: "Diff only specific tables/views" },
      { flag: "--schema <name>", description: "PostgreSQL schema (falls back to ATLAS_SCHEMA, then public)" },
      { flag: "--source <name>", description: "Read from semantic/{name}/ subdirectory" },
    ],
    examples: [
      "atlas diff",
      "atlas diff --tables users,orders",
      'atlas diff || echo "Schema drift detected!"',
    ],
  },
  query: {
    description: "Ask a natural language question and get an answer. Requires a running Atlas API server.",
    usage: 'query "your question" [options]',
    flags: [
      { flag: "--json", description: "Raw JSON output (pipe-friendly)" },
      { flag: "--csv", description: "CSV output (headers + rows, no narrative)" },
      { flag: "--quiet", description: "Data only — no narrative, SQL, or stats" },
      { flag: "--auto-approve", description: "Auto-approve any pending actions" },
      { flag: "--connection <id>", description: "Query a specific datasource" },
    ],
    examples: [
      'atlas query "How many users signed up last month?"',
      'atlas query "top 10 customers by revenue" --json',
      'atlas query "monthly revenue by product" --csv > report.csv',
    ],
  },
  doctor: {
    description: "Alias for 'atlas validate' — validate config, semantic layer, and connectivity.",
    usage: "doctor",
    examples: [
      "atlas doctor",
    ],
  },
  validate: {
    description: "Validate config, semantic layer, and connectivity. Use --offline to skip connectivity checks.",
    usage: "validate [options]",
    flags: [
      { flag: "--offline", description: "Skip connectivity checks (datasource, provider, internal DB)" },
    ],
    examples: [
      "atlas validate",
      "atlas validate --offline",
    ],
  },
  mcp: {
    description: "Start an MCP (Model Context Protocol) server for Claude Desktop, Cursor, and other MCP clients.",
    usage: "mcp [options]",
    flags: [
      { flag: "--transport <stdio|sse>", description: "Transport type (default: stdio)" },
      { flag: "--port <n>", description: "Port for SSE transport (default: 8080)" },
    ],
    examples: [
      "atlas mcp",
      "atlas mcp --transport sse --port 9090",
    ],
  },
  import: {
    description: "Import semantic layer YAML files from disk into the internal DB for the active org.",
    usage: "import [options]",
    flags: [
      { flag: "--connection <name>", description: "Associate imported entities with a named datasource" },
    ],
    examples: [
      "atlas import",
      "atlas import --connection warehouse",
    ],
  },
  index: {
    description: "Rebuild the semantic index from current YAML files, or print index statistics.",
    usage: "index [options]",
    flags: [
      { flag: "--stats", description: "Print current index statistics without rebuilding" },
    ],
    examples: [
      "atlas index",
      "atlas index --stats",
    ],
  },
  learn: {
    description: "Analyze audit log and propose semantic layer YAML improvements.",
    usage: "learn [options]",
    flags: [
      { flag: "--apply", description: "Write proposed changes to YAML files (default: dry-run)" },
      { flag: "--limit <n>", description: "Max audit log entries to analyze (default: 1000)" },
      { flag: "--since <date>", description: "Only analyze queries after this date (ISO 8601)" },
      { flag: "--source <name>", description: "Read from/write to semantic/{name}/ subdirectory" },
    ],
    examples: [
      "atlas learn",
      "atlas learn --apply",
      "atlas learn --since 2026-03-01 --limit 500",
      "atlas learn --source warehouse",
    ],
  },
  migrate: {
    description: "Generate or apply plugin schema migrations.",
    usage: "migrate [options]",
    flags: [
      { flag: "--apply", description: "Execute migrations against internal database (default: dry-run)" },
    ],
    examples: [
      "atlas migrate",
      "atlas migrate --apply",
    ],
  },
  plugin: {
    description: "Manage Atlas plugins.",
    usage: "plugin <list|create|add>",
    subcommands: [
      { name: "list", description: "List installed plugins from atlas.config.ts" },
      { name: "create <name> --type <type>", description: "Scaffold a new plugin (datasource|context|interaction|action|sandbox)" },
      { name: "add <package-name>", description: "Install a plugin package" },
    ],
    examples: [
      "atlas plugin list",
      "atlas plugin create my-plugin --type datasource",
      "atlas plugin add @useatlas/plugin-bigquery",
    ],
  },
  eval: {
    description: "Run the evaluation pipeline against demo schemas to measure text-to-SQL accuracy.",
    usage: "eval [options]",
    flags: [
      { flag: "--schema <name>", description: "Filter by demo dataset (not a PostgreSQL schema; e.g. simple, cybersec, ecommerce)" },
      { flag: "--category <name>", description: "Filter by category" },
      { flag: "--difficulty <level>", description: "Filter by difficulty (simple|medium|complex)" },
      { flag: "--id <case-id>", description: "Run a single case" },
      { flag: "--limit <n>", description: "Max cases to evaluate" },
      { flag: "--resume <file>", description: "Resume from existing JSONL results file" },
      { flag: "--baseline", description: "Save results as new baseline" },
      { flag: "--compare <file.jsonl>", description: "Diff against baseline (exit 1 on regression)" },
      { flag: "--csv", description: "CSV output" },
      { flag: "--json", description: "JSON summary output" },
    ],
    examples: [
      "atlas eval",
      "atlas eval --schema cybersec --difficulty complex",
      "atlas eval --baseline",
    ],
  },
  smoke: {
    description: "Run end-to-end smoke tests against a running Atlas deployment.",
    usage: "smoke [options]",
    flags: [
      { flag: "--target <url>", description: "API base URL (default: http://localhost:3001)" },
      { flag: "--api-key <key>", description: "Bearer auth token" },
      { flag: "--timeout <ms>", description: "Per-check timeout (default: 30000)" },
      { flag: "--verbose", description: "Show full response bodies on failure" },
      { flag: "--json", description: "Machine-readable JSON output" },
    ],
    examples: [
      "atlas smoke",
      "atlas smoke --target https://api.example.com --api-key sk-...",
    ],
  },
  benchmark: {
    description: "Run the BIRD benchmark for text-to-SQL accuracy evaluation.",
    usage: "benchmark [options]",
    flags: [
      { flag: "--bird-path <path>", description: "Path to the downloaded BIRD dev directory (required)" },
      { flag: "--limit <n>", description: "Max questions to evaluate" },
      { flag: "--db <name>", description: "Filter to a single database" },
      { flag: "--csv", description: "CSV output" },
      { flag: "--resume <file>", description: "Resume from existing JSONL results file" },
    ],
    examples: [
      "atlas benchmark --bird-path ./bird-dev",
      "atlas benchmark --bird-path ./bird-dev --db california_schools --limit 50",
    ],
  },
  completions: {
    description: "Output a shell completion script.",
    usage: "completions <bash|zsh|fish>",
    examples: [
      'eval "$(atlas completions bash)"',
      'eval "$(atlas completions zsh)"',
      "atlas completions fish > ~/.config/fish/completions/atlas.fish",
    ],
  },
};

function printOverviewHelp(): void {
  console.log(
    "Atlas CLI — profile databases, generate semantic layers, and query your data.\n\n" +
    "Usage: atlas <command> [options]\n\n" +
    "Commands:\n" +
    "  init          Profile DB and generate semantic layer\n" +
    "  import        Import semantic YAML files from disk into DB\n" +
    "  index         Rebuild or inspect the semantic index\n" +
    "  learn         Analyze audit log and propose YAML improvements\n" +
    "  diff          Compare DB schema against existing semantic layer\n" +
    "  query         Ask a question via the Atlas API\n" +
    "  validate      Validate config, semantic layer, and connectivity\n" +
    "  doctor        Alias for validate\n" +
    "  eval          Run eval pipeline against demo schemas\n" +
    "  smoke         Run E2E smoke tests against a running Atlas deployment\n" +
    "  migrate       Generate/apply plugin schema migrations\n" +
    "  plugin        Manage plugins (list, create, add)\n" +
    "  benchmark     Run BIRD benchmark for text-to-SQL accuracy\n" +
    "  mcp           Start MCP server (stdio or SSE transport)\n" +
    "  completions   Output shell completion script (bash, zsh, fish)\n\n" +
    "Run atlas <command> --help for detailed usage of any command."
  );
}

/** Check if args contain --help or -h for a subcommand. */
function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Top-level help: atlas --help, atlas -h, or no command
  if (!command || command === "--help" || command === "-h") {
    printOverviewHelp();
    process.exit(0);
  }

  // Per-subcommand --help
  if (wantsHelp(args) && command in SUBCOMMAND_HELP) {
    printSubcommandHelp(SUBCOMMAND_HELP[command]);
    process.exit(0);
  }

  await checkEnvFile(command);

  if (command === "query") {
    return handleQuery(args);
  }

  if (command === "eval") {
    const { handleEval } = await import("./eval");
    return handleEval(args);
  }

  if (command === "benchmark") {
    const { handleBenchmark } = await import("./benchmark");
    return handleBenchmark(args);
  }

  if (command === "smoke") {
    const { handleSmoke } = await import("./smoke");
    return handleSmoke(args);
  }

  if (command === "completions") {
    const { handleCompletions } = await import("../src/completions");
    handleCompletions(args);
    return;
  }

  if (command === "doctor") {
    // doctor is an alias for validate with relaxed exit codes:
    // Sandbox and Internal DB failures don't contribute to exit 1
    const { runValidate } = await import("../src/validate");
    const exitCode = await runValidate({ mode: "doctor" });
    process.exit(exitCode);
  }

  if (command === "validate") {
    const { runValidate } = await import("../src/validate");
    const offline = args.includes("--offline");
    const exitCode = await runValidate({ offline });
    process.exit(exitCode);
  }

  if (command === "index") {
    return handleIndex(args);
  }

  if (command === "learn") {
    return handleLearn(args);
  }

  if (command === "diff") {
    return handleDiff(args);
  }

  if (command === "mcp") {
    const transportFlag = args.includes("--transport")
      ? args[args.indexOf("--transport") + 1]
      : "stdio";
    const portFlag = args.includes("--port")
      ? parseInt(args[args.indexOf("--port") + 1], 10)
      : 8080;

    if (transportFlag !== "stdio" && transportFlag !== "sse") {
      console.error(`[atlas] Unknown transport: "${transportFlag}". Use "stdio" or "sse".`);
      process.exit(1);
    }

    if (transportFlag === "sse" && (isNaN(portFlag) || portFlag <= 0)) {
      console.error(`[atlas] Invalid port for SSE transport. Must be a positive integer.`);
      process.exit(1);
    }

    try {
      const { createAtlasMcpServer } = await import("@atlas/mcp/server");

      if (transportFlag === "sse") {
        const { startSseServer } = await import("@atlas/mcp/sse");
        const handle = await startSseServer(
          () => createAtlasMcpServer(),
          { port: portFlag },
        );
        console.error(
          `[atlas] MCP server running on http://${handle.server.hostname}:${handle.server.port}/mcp`,
        );

        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) return;
          shuttingDown = true;
          try {
            await handle.close();
          } catch (err) {
            console.error(`[atlas] Error closing SSE server: ${err instanceof Error ? err.message : String(err)}`);
          }
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } else {
        const server = await createAtlasMcpServer();
        const { StdioServerTransport } = await import(
          "@modelcontextprotocol/sdk/server/stdio.js"
        );
        await server.connect(new StdioServerTransport());
        console.error("[atlas] MCP server running on stdio");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[atlas] Failed to start MCP server: ${detail}`);
      process.exit(1);
    }
    return;
  }

  if (command === "import") {
    return handleImport(args);
  }

  if (command === "migrate") {
    return handleMigrate(args);
  }

  if (command === "plugin") {
    return handlePlugin(args);
  }

  if (command !== "init") {
    console.error(`Unknown command: ${command}\n`);
    printOverviewHelp();
    process.exit(1);
  }

  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;
  const cliSchema = getFlag(args, "--schema") ?? process.env.ATLAS_SCHEMA;
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");
  const connectionArg = requireFlagIdentifier(args, "--connection", "connection name");
  const demoDataset = parseDemoArg(args);
  const forceInit = args.includes("--force");
  const csvArg = getFlag(args, "--csv");
  const parquetArg = getFlag(args, "--parquet");
  const hasDocumentFiles = !!(csvArg || parquetArg);

  // Validate schema name if provided
  if (cliSchema) validateSchemaName(cliSchema);

  // --connection and --source are mutually exclusive
  if (connectionArg && sourceArg) {
    console.error("Error: --connection and --source are mutually exclusive.");
    console.error("  --connection profiles a named datasource from atlas.config.ts");
    console.error("  --source is the legacy flag for per-source output directory");
    process.exit(1);
  }

  // Warn if --demo is combined with --connection (seeds into config-sourced URL)
  if (connectionArg && demoDataset) {
    console.warn(
      `Warning: --demo will seed data into the "${connectionArg}" datasource ` +
      `defined in atlas.config.ts. Ensure this is not a production database.`
    );
  }

  // --- CSV/Parquet document source via DuckDB (early-exit path) ---
  if (hasDocumentFiles) {
    const files: { path: string; format: "csv" | "parquet" }[] = [];
    if (csvArg) {
      for (const f of csvArg.split(",")) files.push({ path: f.trim(), format: "csv" });
    }
    if (parquetArg) {
      for (const f of parquetArg.split(",")) files.push({ path: f.trim(), format: "parquet" });
    }

    // Compute output directories
    const outputBase = sourceArg ? path.join(SEMANTIC_DIR, sourceArg) : SEMANTIC_DIR;
    const entitiesOutDir = path.join(outputBase, "entities");
    const metricsOutDir = path.join(outputBase, "metrics");
    const dbPath = path.join(outputBase, ".atlas.duckdb");

    console.log(`\nAtlas Init — loading document files via DuckDB...\n`);

    // Ingest files
    const tableNames = await ingestIntoDuckDB(dbPath, files);
    console.log(`\nIngested ${tableNames.length} file(s) into ${dbPath}\n`);

    // Profile the DuckDB database
    console.log("Profiling DuckDB tables...\n");
    const duckFilterTables = filterTables ?? tableNames;
    const duckProgress = createProgressTracker();
    const duckStart = Date.now();
    const duckResult = await profileDuckDB(dbPath, duckFilterTables, undefined, duckProgress);
    const { profiles } = duckResult;
    duckProgress.onComplete(profiles.length, Date.now() - duckStart);

    if (profiles.length === 0) {
      console.error("\nError: No tables were successfully profiled.");
      process.exit(1);
    }

    // Warn about any profiling errors
    if (duckResult.errors.length > 0) {
      const total = profiles.length + duckResult.errors.length;
      logProfilingErrors(duckResult.errors, total);
      const { shouldAbort } = checkFailureThreshold(duckResult, forceInit);
      if (shouldAbort) {
        console.error(`\nUse \`--force\` to continue anyway.`);
        process.exit(1);
      }
      console.warn(`Continuing with ${profiles.length} successfully profiled tables.\n`);
    }

    // Run profiler heuristics
    analyzeTableProfiles(profiles);

    console.log(`\nFound ${profiles.length} table(s):\n`);
    for (const p of profiles) {
      console.log(`  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} cols`);
    }

    // Write semantic layer
    fs.mkdirSync(entitiesOutDir, { recursive: true });
    fs.mkdirSync(metricsOutDir, { recursive: true });

    // Clean stale entity/metric files from previous runs
    for (const dir of [entitiesOutDir, metricsOutDir]) {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(".yml") || file.endsWith(".yaml")) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    }

    console.log(`\nGenerating semantic layer...\n`);

    // DuckDB uses PostgreSQL-compatible SQL — "public" schema is not meaningful
    const duckSchema = "main";
    for (const profile of profiles) {
      const filePath = path.join(entitiesOutDir, `${profile.table_name}.yml`);
      fs.writeFileSync(filePath, generateEntityYAML(profile, profiles, "duckdb" as DBType, duckSchema, sourceArg));
      console.log(`  wrote ${filePath}`);
    }

    const catalogPath = path.join(outputBase, "catalog.yml");
    fs.writeFileSync(catalogPath, generateCatalogYAML(profiles));
    console.log(`  wrote ${catalogPath}`);

    const glossaryPath = path.join(outputBase, "glossary.yml");
    fs.writeFileSync(glossaryPath, generateGlossaryYAML(profiles));
    console.log(`  wrote ${glossaryPath}`);

    for (const profile of profiles) {
      const metricYaml = generateMetricYAML(profile, duckSchema);
      if (metricYaml) {
        const filePath = path.join(metricsOutDir, `${profile.table_name}.yml`);
        fs.writeFileSync(filePath, metricYaml);
        console.log(`  wrote ${filePath}`);
      }
    }

    const duckDbUrl = `duckdb://${dbPath}`;
    const relativeOutput = sourceArg ? `./semantic/${sourceArg}/` : "./semantic/";
    console.log(`
Done! Your semantic layer is at ${relativeOutput}

Generated:
  - ${profiles.length} entity YAMLs with dimensions, measures, and query patterns${sourceArg ? ` (connection: ${sourceArg})` : ""}
  - DuckDB database at ${dbPath}
  - catalog.yml, glossary.yml, and metric definitions

Next steps:
  1. Review the generated YAMLs and refine business context
  2. Set ATLAS_DATASOURCE_URL=${duckDbUrl} in your .env
  3. Run \`bun run dev\` to start Atlas
`);
    process.exit(0);
  }

  // Determine enrichment mode (shared across all datasources)
  const explicitEnrich = args.includes("--enrich");
  const explicitNoEnrich = args.includes("--no-enrich");
  const hasApiKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AI_GATEWAY_API_KEY
  );
  const providerConfigured = hasApiKey && !!process.env.ATLAS_PROVIDER;
  let shouldEnrich: boolean;
  if (explicitEnrich) {
    shouldEnrich = true;
  } else if (explicitNoEnrich) {
    shouldEnrich = false;
  } else if (providerConfigured && process.stdin.isTTY) {
    p.log.info(
      `LLM enrichment adds richer descriptions, query patterns, and business context ` +
      `to your semantic layer using ${pc.cyan(process.env.ATLAS_PROVIDER ?? "anthropic")}.`
    );
    const enrich = await p.confirm({
      message: "Enrich semantic layer with LLM? (recommended)",
      initialValue: true,
    });
    if (p.isCancel(enrich)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    shouldEnrich = enrich;
  } else {
    shouldEnrich = providerConfigured;
  }

  // --- Detect org-scoped mode ---
  // When DATABASE_URL is set and managed auth is active, atlas init writes
  // to semantic/.orgs/{orgId}/ and auto-imports to the internal DB.
  const noImport = args.includes("--no-import");
  let orgId: string | undefined;
  if (process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET) {
    // Org-scoped mode is available. The orgId comes from the active session.
    // For CLI use, accept ATLAS_ORG_ID env var or --org flag.
    orgId = getFlag(args, "--org") ?? process.env.ATLAS_ORG_ID;
    if (orgId) {
      console.log(`Org-scoped mode: writing to semantic/.orgs/${orgId}/\n`);
    }
  }

  // --- Resolve datasource list ---

  // Try loading atlas.config.ts
  let configDatasources: Record<string, { url: string; schema?: string; description?: string }> | null = null;
  if (connectionArg || !sourceArg) {
    try {
      const { loadConfig } = await import("@atlas/api/lib/config");
      const config = await loadConfig();
      if (config.source === "file" && Object.keys(config.datasources).length > 0) {
        configDatasources = config.datasources;
      }
    } catch (err) {
      // loadConfig() returns source:"env" when no file exists (no throw).
      // Errors here mean a broken config file — do not silently ignore.
      if (connectionArg) {
        console.error(`Error: Failed to load atlas.config.ts: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.warn(`Warning: atlas.config.ts found but failed to load: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("Falling back to ATLAS_DATASOURCE_URL environment variable.\n");
    }
  }

  let datasources: DatasourceEntry[];

  if (connectionArg) {
    // --connection <name>: single datasource from config
    if (!configDatasources) {
      console.error("Error: --connection requires an atlas.config.ts with datasources defined.");
      process.exit(1);
    }
    const ds = configDatasources[connectionArg];
    if (!ds) {
      const available = Object.keys(configDatasources).join(", ");
      console.error(`Error: Datasource "${connectionArg}" not found in atlas.config.ts.`);
      console.error(`  Available: ${available}`);
      process.exit(1);
    }
    datasources = [{
      id: connectionArg,
      url: ds.url,
      schema: cliSchema ?? ds.schema ?? "public",
    }];
  } else if (sourceArg) {
    // Legacy --source flag: single datasource from env var, output to semantic/{source}/
    const connStr = process.env.ATLAS_DATASOURCE_URL;
    if (!connStr) exitMissingDatasourceUrl();
    // Warn if --source and --demo are used together
    if (demoDataset) {
      console.warn(
        `Warning: --demo seeds data into the database at ATLAS_DATASOURCE_URL, ` +
        `but --source "${sourceArg}" writes entities with connection: "${sourceArg}". ` +
        `Ensure the "${sourceArg}" connection is registered to the same database at runtime.`
      );
    }
    datasources = [{
      id: sourceArg,
      url: connStr,
      schema: cliSchema ?? "public",
    }];
  } else if (configDatasources && Object.keys(configDatasources).length > 0) {
    // Config with N datasources — interactive picker in TTY, or all
    const allEntries = Object.entries(configDatasources).map(([id, ds]) => {
      validateIdentifier(id, "datasource name");
      return {
        id,
        url: ds.url,
        schema: cliSchema ?? ds.schema ?? "public",
      };
    });

    if (allEntries.length > 1 && process.stdin.isTTY) {
      const selected = await p.multiselect({
        message: `Select datasources to profile (${allEntries.length} found in atlas.config.ts)`,
        options: allEntries.map((ds) => {
          let dbLabel: string;
          try {
            dbLabel = detectDBType(ds.url);
          } catch (err) {
            dbLabel = "unknown";
            console.warn(`  Warning: Cannot detect DB type for "${ds.id}": ${err instanceof Error ? err.message : String(err)}`);
          }
          return {
            value: ds.id,
            label: `${ds.id} (${dbLabel})`,
          };
        }),
        initialValues: allEntries.map((ds) => ds.id),
        required: true,
      });

      if (p.isCancel(selected)) {
        p.cancel("Selection cancelled.");
        process.exit(1);
      }

      const selectedIds = new Set(selected as string[]);
      datasources = allEntries.filter((ds) => selectedIds.has(ds.id));

      if (datasources.length === 0) {
        p.cancel("No datasources selected.");
        process.exit(1);
      }
    } else {
      datasources = allEntries;
    }

    // --demo restricted to single-datasource when using config
    if (demoDataset && datasources.length > 1) {
      console.error("Error: --demo cannot be used with multiple datasources. Use --connection to target a single datasource.");
      process.exit(1);
    }
  } else {
    // No config -- fall back to ATLAS_DATASOURCE_URL (backward-compatible single-source behavior)
    const connStr = process.env.ATLAS_DATASOURCE_URL;
    if (!connStr) exitMissingDatasourceUrl();
    datasources = [{
      id: "default",
      url: connStr,
      schema: cliSchema ?? "public",
    }];
  }

  // --- Multi-source orchestration loop ---

  const isMultiSource = datasources.length > 1;
  const errors: { id: string; error: string }[] = [];

  for (const ds of datasources) {
    let dbType: DBType;
    try {
      dbType = detectDBType(ds.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMultiSource) {
        console.error(`\nError detecting DB type for "${ds.id}": ${msg}`);
        errors.push({ id: ds.id, error: msg });
        continue;
      }
      console.error(`\nError: ${msg}`);
      process.exit(1);
    }

    if (isMultiSource) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Profiling datasource: ${ds.id} (${dbType})`);
      console.log(`${"=".repeat(60)}\n`);
    }

    try {
      await profileDatasource({
        id: ds.id,
        url: ds.url,
        dbType,
        schema: ds.schema,
        filterTables,
        shouldEnrich,
        explicitEnrich,
        demoDataset: isMultiSource ? null : demoDataset,
        force: forceInit,
        orgId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMultiSource) {
        console.error(`\nFailed to profile datasource "${ds.id}": ${msg}\n`);
        errors.push({ id: ds.id, error: msg });
        continue;
      }
      // Single datasource — propagate as fatal
      throw err;
    }
  }

  // Report failures if multi-source
  if (errors.length > 0) {
    console.error(`\n${"=".repeat(60)}`);
    console.error(`${errors.length} datasource(s) failed:`);
    for (const e of errors) {
      console.error(`  - ${e.id}: ${e.error}`);
    }
    console.error(`${"=".repeat(60)}`);
    process.exit(1);
  }

  // --- Auto-import to DB in org-scoped mode ---
  if (orgId && !noImport) {
    console.log("\nImporting entities to internal DB...\n");

    const apiUrl = process.env.ATLAS_API_URL ?? "http://localhost:3001";
    const importUrl = `${apiUrl}/api/v1/admin/semantic/org/import`;
    const importHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.ATLAS_API_KEY) importHeaders.Authorization = `Bearer ${process.env.ATLAS_API_KEY}`;

    // For each datasource, import with its connection ID
    let anyImported = false;
    for (const ds of datasources) {
      const importBody: Record<string, string> = {};
      if (ds.id !== "default") importBody.connectionId = ds.id;

      try {
        const resp = await fetch(importUrl, {
          method: "POST",
          headers: importHeaders,
          body: JSON.stringify(importBody),
          signal: AbortSignal.timeout(60_000),
        });

        if (resp.ok) {
          const result = await resp.json() as { imported: number; skipped: number; total: number };
          console.log(`  Imported ${result.imported} entities${ds.id !== "default" ? ` (connection: ${ds.id})` : ""}`);
          if (result.imported > 0) anyImported = true;
        } else {
          let errorMsg = `HTTP ${resp.status}`;
          try {
            const json = await resp.json() as { message?: string; error?: string };
            errorMsg = json.message ?? json.error ?? errorMsg;
          } catch {
            errorMsg = await resp.text().catch(() => errorMsg);
          }
          console.warn(`  Warning: Import failed for ${ds.id}: ${errorMsg}`);
          console.warn("  Run 'atlas import' later to retry.\n");
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (detail.includes("ECONNREFUSED") || detail.includes("fetch failed")) {
          console.warn("  Warning: Atlas API not reachable — skipping auto-import.");
          console.warn("  Set ATLAS_API_URL if the API is not on localhost:3001");
          console.warn("  Start the API server and run 'atlas import' to import manually.\n");
          break; // Don't try remaining datasources
        }
        console.warn(`  Warning: Import failed for ${ds.id}: ${detail}`);
      }
    }

    if (!anyImported && datasources.length > 0) {
      console.warn("\nNo entities were imported to the DB. Files were written to disk successfully.");
      console.warn("Run 'atlas import' once the API server is available to complete the import.");
      if (!process.env.ATLAS_API_KEY) {
        console.warn("Hint: set ATLAS_API_KEY for CLI authentication.\n");
      }
    }
  }
}

export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.startsWith("--")) return undefined;
  return value;
}

function exitMissingDatasourceUrl(): never {
  console.error("Error: ATLAS_DATASOURCE_URL is required for atlas init.");
  console.error("  PostgreSQL:  ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname");
  console.error("  MySQL:       ATLAS_DATASOURCE_URL=mysql://user:pass@host:3306/dbname");
  console.error("  Snowflake:   ATLAS_DATASOURCE_URL=snowflake://user:pass@account/database/schema?warehouse=WH");
  console.error("  DuckDB:      ATLAS_DATASOURCE_URL=duckdb://path/to/file.duckdb");
  console.error("  CSV/Parquet: Use --csv or --parquet flags (no database required)");
  process.exit(1);
}

// Only run CLI when this file is the entry point (not when imported by tests)
const isEntryPoint =
  (typeof Bun !== "undefined" && Bun.main === import.meta.path) ||
  typeof Bun === "undefined"; // tsx / node fallback

if (isEntryPoint) {
  main().catch((err) => {
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  });
}
