/**
 * Semantic-layer mechanical generator — YAML emitters.
 *
 * Turns analyzed `TableProfile`s into entity / catalog / glossary / metric
 * YAML. Pure, deterministic, no LLM and no DB access — this is the "Phase 1"
 * mechanical baseline from docs/design/semantic-onboarding.md (§ D).
 *
 * Relocated from `lib/profiler.ts` (issue #3233); `lib/profiler.ts` re-exports
 * these for backward compatibility.
 */

import * as yaml from "js-yaml";
import type { DBType } from "@atlas/api/lib/db/connection";
import type { TableProfile } from "@useatlas/types";
import { mapSQLType, isViewLike, singularize, entityName } from "../../profiler-utils";
import { suggestMeasureType, describeMeasure } from "../../profiler-patterns";
import { isView, isMatView, mapSalesforceFieldType } from "./analyze";

/**
 * Decide the `table:` / `FROM` qualifier for a profiled table.
 *
 * `public` is the PostgreSQL default schema and is always left unqualified.
 * `main` is the DuckDB/SQLite default schema, so it is unqualified *only*
 * there — but `--schema` is Postgres-only, so a PostgreSQL datasource can be
 * profiled with a custom schema literally named `main`, which MUST stay
 * qualified or resolution silently falls back to the connection's
 * `search_path` rather than the explicit schema (issue #3252). Every other
 * schema is qualified.
 *
 * `generateEntityYAML` (entity `table:`) and `generateMetricYAML` (metric
 * `FROM`) call this in lockstep: the SQL whitelist is built from
 * `entity.table`, so a divergent metric ref would fail table-whitelist
 * validation.
 */
function qualifyTableName(tableName: string, schema: string, dbType: DBType): string {
  const schemaIsDefault =
    schema === "public" ||
    (schema === "main" && (dbType === "duckdb" || dbType === "sqlite"));
  return schemaIsDefault ? tableName : `${schema}.${tableName}`;
}

export function generateEntityYAML(
  profile: TableProfile,
  allProfiles: TableProfile[],
  dbType: DBType,
  schema: string = "public",
  source?: string,
): string {
  const name = entityName(profile.table_name);
  const qualifiedTable = qualifyTableName(profile.table_name, schema, dbType);

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
    ...(source ? { group: source } : {}),
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

// `dbType` is appended after `schema` (rather than placed before it as in
// generateEntityYAML) to preserve the existing `(profile, schema)` callers; it
// is required for dbType-aware `main` qualification (issue #3252) and defaults
// to "postgres" — the primary datasource and the only dbType for which a custom
// schema named `main` is reachable.
export function generateMetricYAML(
  profile: TableProfile,
  schema: string = "public",
  dbType: DBType = "postgres",
): string | null {
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
  const qualifiedTable = qualifyTableName(profile.table_name, schema, dbType);

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
