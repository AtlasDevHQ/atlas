/**
 * Shared profiler library — used by the wizard API for database profiling.
 *
 * Contains type mapping, YAML generation, heuristics, and DB-specific
 * profiling. Canonical type definitions live in @useatlas/types and are
 * re-exported here for convenience.
 */

import * as yaml from "js-yaml";
import type { DBType } from "@atlas/api/lib/db/connection";
import { createLogger } from "@atlas/api/lib/logger";
import {
  inferSemanticTypes,
  inferJoinsFromNamingConventions,
  suggestMeasureType,
  describeMeasure,
} from "./profiler-patterns";

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
// View helpers
// ---------------------------------------------------------------------------

export function isView(profile: TableProfile): boolean {
  return profile.object_type === "view";
}

export function isMatView(profile: TableProfile): boolean {
  return profile.object_type === "materialized_view";
}

export function isViewLike(profile: TableProfile): boolean {
  return profile.object_type === "view" || profile.object_type === "materialized_view";
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

export function mapSQLType(sqlType: string): string {
  const unwrapped = sqlType.replace(/Nullable\((.+)\)/g, "$1").replace(/LowCardinality\((.+)\)/g, "$1");
  const t = unwrapped.toLowerCase();
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

export function mapSalesforceFieldType(sfType: string): string {
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
    default:
      return "string";
  }
}

// ---------------------------------------------------------------------------
// Pluralization helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Profiler heuristics (pure functions on TableProfile[])
// ---------------------------------------------------------------------------

export function inferForeignKeys(profiles: TableProfile[]): void {
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

      const prefix = col.name.slice(0, -3);
      if (!prefix) continue;

      const candidates = [prefix, pluralize(prefix), singularize(prefix)];
      let targetTable: TableProfile | undefined;
      for (const candidate of candidates) {
        targetTable = tableMap.get(candidate);
        if (targetTable) break;
      }

      if (!targetTable) continue;

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

export function detectAbandonedTables(profiles: TableProfile[]): void {
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

export function detectEnumInconsistency(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    for (const col of profile.columns) {
      if (!col.is_enum_like) continue;
      if (col.sample_values.length === 0) continue;

      const groups = new Map<string, string[]>();
      for (const val of col.sample_values) {
        const lower = val.toLowerCase();
        const existing = groups.get(lower) ?? [];
        existing.push(val);
        groups.set(lower, existing);
      }

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

export function analyzeTableProfiles(profiles: readonly TableProfile[]): TableProfile[] {
  // Create fresh copies with reset analysis fields (no mutation of input).
  // Deep-clone foreign_keys and partition_info to fully isolate from input.
  const analyzed: TableProfile[] = profiles.map((p) => ({
    ...p,
    foreign_keys: p.foreign_keys.map((fk) => ({ ...fk })),
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    columns: p.columns.map((col) => ({ ...col, profiler_notes: [] })),
    partition_info: p.partition_info
      ? { ...p.partition_info, children: [...p.partition_info.children] }
      : undefined,
  }));

  inferForeignKeys(analyzed);
  inferJoinsFromNamingConventions(analyzed);
  inferSemanticTypes(analyzed);
  detectAbandonedTables(analyzed);
  detectEnumInconsistency(analyzed);
  detectDenormalizedTables(analyzed);

  return analyzed;
}

// ---------------------------------------------------------------------------
// Entity name helper
// ---------------------------------------------------------------------------

export function entityName(tableName: string): string {
  return tableName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// YAML generation
// ---------------------------------------------------------------------------

export function generateEntityYAML(
  profile: TableProfile,
  allProfiles: TableProfile[],
  dbType: DBType,
  schema: string = "public",
  source?: string,
): string {
  const name = entityName(profile.table_name);
  const qualifiedTable = schema !== "public" && schema !== "main" ? `${schema}.${profile.table_name}` : profile.table_name;

  // Build dimensions
  const dimensions: Record<string, unknown>[] = profile.columns.map((col) => {
    const dim: Record<string, unknown> = {
      name: col.name,
      sql: col.name,
      type: dbType === "salesforce" ? mapSalesforceFieldType(col.type) : mapSQLType(col.type),
    };

    if (col.is_primary_key) {
      dim.description = `Primary key`;
      dim.primary_key = true;
    } else if (col.is_foreign_key) {
      dim.description = `Foreign key to ${col.fk_target_table}`;
    }

    if (col.semantic_type) dim.semantic_type = col.semantic_type;
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

  // Build virtual dimensions
  const virtualDims: Record<string, unknown>[] = [];
  for (const col of profile.columns) {
    if (col.is_primary_key || col.is_foreign_key) continue;
    const mappedType = dbType === "salesforce" ? mapSalesforceFieldType(col.type) : mapSQLType(col.type);

    if (mappedType === "number" && !col.name.endsWith("_id") && dbType !== "salesforce") {
      const label = col.name.replace(/_/g, " ");
      if (dbType === "mysql") {
        virtualDims.push({
          name: `${col.name}_bucket`,
          sql: `CASE\n  WHEN ${col.name} IS NULL THEN 'Unknown'\n  WHEN ${col.name} < (SELECT AVG(${col.name}) * 0.5 FROM ${qualifiedTable}) THEN 'Low'\n  WHEN ${col.name} < (SELECT AVG(${col.name}) * 1.5 FROM ${qualifiedTable}) THEN 'Medium'\n  ELSE 'High'\nEND`,
          type: "string",
          description: `${label} bucketed into Low/Medium/High`,
          virtual: true,
          sample_values: ["Low", "Medium", "High"],
        });
      } else if (dbType === "clickhouse") {
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

  // Profiler notes on dimensions
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

  // Build measures (skip for views/matviews)
  const measures: Record<string, unknown>[] = [];

  if (!isViewLike(profile)) {
    const pkCol = profile.columns.find((c) => c.is_primary_key);
    if (pkCol) {
      measures.push({
        name: `${singularize(profile.table_name)}_count`,
        sql: pkCol.name,
        type: "count_distinct",
      });
    }

    for (const col of profile.columns) {
      if (col.is_primary_key || col.is_foreign_key) continue;
      if (col.name.endsWith("_id")) continue;
      const mappedType = mapSQLType(col.type);

      // Boolean columns → COUNT WHERE true
      if (mappedType === "boolean") {
        measures.push({
          name: `${col.name}_count`,
          sql: col.name,
          type: "count_where",
          description: `Count of rows where ${col.name.replace(/_/g, " ")} is true`,
        });
        continue;
      }

      if (mappedType !== "number") continue;

      const suggestion = suggestMeasureType(col);

      switch (suggestion) {
        case "sum":
          measures.push({
            name: `total_${col.name}`,
            sql: col.name,
            type: "sum",
            description: describeMeasure(col, "sum"),
          });
          break;
        case "avg":
          measures.push({
            name: `avg_${col.name}`,
            sql: col.name,
            type: "avg",
            description: describeMeasure(col, "avg"),
          });
          break;
        case "sum_and_avg":
          measures.push({
            name: `total_${col.name}`,
            sql: col.name,
            type: "sum",
            description: describeMeasure(col, "sum"),
          });
          measures.push({
            name: `avg_${col.name}`,
            sql: col.name,
            type: "avg",
            description: describeMeasure(col, "avg"),
          });
          break;
        case "count_where":
          // Booleans are handled above — this branch is unreachable for numeric columns
          break;
        default:
          suggestion satisfies never;
      }
    }
  }

  // Build use_cases
  const useCases: string[] = [];

  if (isView(profile)) {
    useCases.push(`This is a database view — it may encapsulate complex joins or aggregations. Query it directly rather than recreating its logic`);
  }

  if (isMatView(profile)) {
    useCases.push(`WARNING: This is a materialized view — data may be stale. Check with the user about refresh frequency before relying on real-time accuracy`);
    if (profile.matview_populated === false) {
      useCases.push(`WARNING: This materialized view has never been refreshed and contains no data`);
    }
  }

  if (profile.partition_info) {
    useCases.push(`This table is partitioned by ${profile.partition_info.strategy} on (${profile.partition_info.key}). Always include ${profile.partition_info.key} in WHERE clauses for optimal query performance`);
  }

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

  const allFKs = [...profile.foreign_keys, ...profile.inferred_foreign_keys];
  if (joins.length > 0) {
    const targets = allFKs.map((fk) => fk.to_table);
    const uniqueTargets = [...new Set(targets)];
    useCases.push(
      `Join with ${uniqueTargets.join(", ")} for cross-entity analysis`
    );
  }
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

  // Build query patterns (skip for views/matviews)
  const queryPatterns: Record<string, unknown>[] = [];

  if (!isViewLike(profile)) {
    for (const col of enumCols.slice(0, 2)) {
      queryPatterns.push({
        description: `${entityName(profile.table_name)} by ${col.name}`,
        sql: `SELECT ${col.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${col.name}\nORDER BY count DESC`,
      });
    }

    if (numericCols.length > 0 && enumCols.length > 0) {
      const numCol = numericCols[0];
      const enumCol = enumCols[0];
      queryPatterns.push({
        description: `Total ${numCol.name} by ${enumCol.name}`,
        sql: `SELECT ${enumCol.name}, SUM(${numCol.name}) as total_${numCol.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${enumCol.name}\nORDER BY total_${numCol.name} DESC`,
      });
    }
  }

  // Build description
  let description: string;
  if (isMatView(profile)) {
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

  // Entity type
  let entityType: string;
  if (isMatView(profile)) {
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
    grain: isMatView(profile)
      ? `one row per result from ${profile.table_name} materialized view`
      : isViewLike(profile)
        ? `one row per result from ${profile.table_name} view`
        : `one row per ${singularize(profile.table_name).replace(/_/g, " ")} record`,
    description,
    dimensions: [...dimensions, ...virtualDims],
  };

  if (profile.partition_info) {
    entity.partitioned = true;
    entity.partition_strategy = profile.partition_info.strategy;
    entity.partition_key = profile.partition_info.key;
  }

  if (measures.length > 0) entity.measures = measures;
  if (joins.length > 0) entity.joins = joins;
  entity.use_cases = useCases;
  if (queryPatterns.length > 0) entity.query_patterns = queryPatterns;

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

  for (const col of numericCols) {
    const suggestion = suggestMeasureType(col);

    switch (suggestion) {
      case "sum":
      case "sum_and_avg":
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
        if (suggestion === "sum") break;
      // falls through for sum_and_avg
      case "avg":
        metrics.push({
          id: `avg_${col.name}`,
          label: `Average ${col.name.replace(/_/g, " ")}`,
          description: `Average ${col.name} per ${singularize(profile.table_name)}.`,
          type: "atomic",
          sql: `SELECT AVG(${col.name}) as avg_${col.name}\nFROM ${qualifiedTable}`,
          aggregation: "avg",
        });
        break;
      case "count_where":
        // Booleans filtered out by numericCols — unreachable for numeric columns
        break;
      default:
        suggestion satisfies never;
    }

    if (enumCols.length > 0) {
      const enumCol = enumCols[0];
      const aggFunc = suggestion === "avg" ? "AVG" : "SUM";
      const aggLabel = suggestion === "avg" ? "avg" : "total";
      metrics.push({
        id: `${col.name}_by_${enumCol.name}`,
        label: `${col.name.replace(/_/g, " ")} by ${enumCol.name}`,
        description: `${col.name} broken down by ${enumCol.name}.`,
        type: "atomic",
        sql: `SELECT ${enumCol.name}, ${aggFunc}(${col.name}) as ${aggLabel}_${col.name}, COUNT(*) as count\nFROM ${qualifiedTable}\nGROUP BY ${enumCol.name}\nORDER BY ${aggLabel}_${col.name} DESC`,
      });
    }
  }

  return yaml.dump({ metrics }, { lineWidth: 120, noRefs: true });
}

export function generateGlossaryYAML(profiles: TableProfile[]): string {
  const terms: Record<string, unknown> = {};

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

// ---------------------------------------------------------------------------
// Output directory helpers
// ---------------------------------------------------------------------------

import * as path from "path";

const SEMANTIC_DIR = path.resolve("semantic");

export function outputDirForDatasource(id: string, orgId?: string): string {
  const base = orgId ? path.join(SEMANTIC_DIR, ".orgs", orgId) : SEMANTIC_DIR;
  return id === "default" ? base : path.join(base, id);
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
