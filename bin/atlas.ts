#!/usr/bin/env tsx
/**
 * Atlas CLI — auto-generate semantic layer from your database.
 *
 * Usage:
 *   bun run atlas -- init                        # Profile DB and generate semantic layer
 *   bun run atlas -- init --tables users,orders  # Only specific tables
 *   bun run atlas -- init --enrich               # Profile + LLM enrichment (needs API key)
 *   bun run atlas -- init --no-enrich            # Explicitly skip LLM enrichment
 *
 * Requires DATABASE_URL in environment.
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const SEMANTIC_DIR = path.resolve("semantic");
const ENTITIES_DIR = path.join(SEMANTIC_DIR, "entities");
const METRICS_DIR = path.join(SEMANTIC_DIR, "metrics");

// --- Interfaces ---

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
}

export interface ForeignKey {
  from_column: string;
  to_table: string;
  to_column: string;
}

export interface TableProfile {
  table_name: string;
  row_count: number;
  columns: ColumnProfile[];
  primary_key_columns: string[];
  foreign_keys: ForeignKey[];
}

// --- PostgreSQL profiler ---

async function queryPrimaryKeys(
  pool: Pool,
  tableName: string
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
    [`public.${tableName}`]
  );
  return result.rows.map((r: { column_name: string }) => r.column_name);
}

async function queryForeignKeys(
  pool: Pool,
  tableName: string
): Promise<ForeignKey[]> {
  const result = await pool.query(
    `
    SELECT
      a_from.attname AS from_column,
      cl_to.relname AS to_table,
      a_to.attname AS to_column
    FROM pg_constraint c
    JOIN pg_attribute a_from
      ON a_from.attrelid = c.conrelid AND a_from.attnum = ANY(c.conkey)
    JOIN pg_class cl_to
      ON cl_to.oid = c.confrelid
    JOIN pg_attribute a_to
      ON a_to.attrelid = c.confrelid AND a_to.attnum = ANY(c.confkey)
    WHERE c.contype = 'f'
      AND c.conrelid = $1::regclass
    ORDER BY a_from.attname
    `,
    [`public.${tableName}`]
  );
  return result.rows.map(
    (r: { from_column: string; to_table: string; to_column: string }) => ({
      from_column: r.from_column,
      to_table: r.to_table,
      to_column: r.to_column,
    })
  );
}

export async function profilePostgres(
  connectionString: string,
  filterTables?: string[]
): Promise<TableProfile[]> {
  const pool = new Pool({ connectionString, max: 3 });
  const profiles: TableProfile[] = [];
  const errors: { table: string; error: string }[] = [];

  const tablesResult = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const tablesToProfile = tablesResult.rows.filter(
    (r: { table_name: string }) => !filterTables || filterTables.includes(r.table_name)
  );

  for (let i = 0; i < tablesToProfile.length; i++) {
    const { table_name } = tablesToProfile[i];
    console.log(`  [${i + 1}/${tablesToProfile.length}] Profiling ${table_name}...`);

    try {
      const countResult = await pool.query(
        `SELECT COUNT(*) as c FROM "${table_name}"`
      );
      const rowCount = parseInt(countResult.rows[0].c, 10);

      // Get primary keys and foreign keys from system catalogs
      let primaryKeyColumns: string[] = [];
      let foreignKeys: ForeignKey[] = [];
      try {
        primaryKeyColumns = await queryPrimaryKeys(pool, table_name);
      } catch {
        // Table may not have PK constraints
      }
      try {
        foreignKeys = await queryForeignKeys(pool, table_name);
      } catch {
        // Table may not have FK constraints
      }

      const fkLookup = new Map(
        foreignKeys.map((fk) => [fk.from_column, fk])
      );

      const colResult = await pool.query(
        `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position
      `,
        [table_name]
      );

      const columns: ColumnProfile[] = [];

      for (const col of colResult.rows) {
        let unique_count: number | null = null;
        let null_count: number | null = null;
        let sample_values: string[] = [];

        const isPK = primaryKeyColumns.includes(col.column_name);
        const fkInfo = fkLookup.get(col.column_name);
        const isFK = !!fkInfo;

        try {
          const uq = await pool.query(
            `SELECT COUNT(DISTINCT "${col.column_name}") as c FROM "${table_name}"`
          );
          unique_count = parseInt(uq.rows[0].c, 10);

          const nc = await pool.query(
            `SELECT COUNT(*) as c FROM "${table_name}" WHERE "${col.column_name}" IS NULL`
          );
          null_count = parseInt(nc.rows[0].c, 10);

          // For enum-like columns, get ALL distinct values; otherwise sample 10
          const isTextType =
            col.data_type === "text" ||
            col.data_type === "character varying" ||
            col.data_type === "character";
          const isEnumLike =
            isTextType &&
            unique_count !== null &&
            unique_count < 20 &&
            rowCount > 0 &&
            unique_count / rowCount <= 0.05;

          const sampleLimit = isEnumLike ? 100 : 10;
          const sv = await pool.query(
            `SELECT DISTINCT "${col.column_name}" as v FROM "${table_name}" WHERE "${col.column_name}" IS NOT NULL ORDER BY "${col.column_name}" LIMIT ${sampleLimit}`
          );
          sample_values = sv.rows.map((r: { v: unknown }) => String(r.v));

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
            is_enum_like: isEnumLike ?? false,
          });
        } catch {
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
            is_enum_like: false,
          });
        }
      }

      profiles.push({
        table_name,
        row_count: rowCount,
        columns,
        primary_key_columns: primaryKeyColumns,
        foreign_keys: foreignKeys,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: Failed to profile ${table_name}: ${msg}`);
      errors.push({ table: table_name, error: msg });
      continue;
    }
  }

  await pool.end();

  if (errors.length > 0) {
    console.log(`\nWarning: ${errors.length} table(s) failed to profile:`);
    for (const e of errors) {
      console.log(`  - ${e.table}: ${e.error}`);
    }
  }

  return profiles;
}

// --- Generate YAML from profile ---

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

function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (lower.endsWith("ies")) return word.slice(0, -3) + "y";
  if (lower.endsWith("ses") || lower.endsWith("xes") || lower.endsWith("zes"))
    return word.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function entityName(tableName: string): string {
  return tableName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function generateEntityYAML(
  profile: TableProfile,
  allProfiles: TableProfile[]
): string {
  const name = entityName(profile.table_name);

  // Build dimensions
  const dimensions: Record<string, unknown>[] = profile.columns.map((col) => {
    const dim: Record<string, unknown> = {
      name: col.name,
      sql: col.name,
      type: mapSQLType(col.type),
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

  // Build virtual dimensions — CASE bucketing for numeric columns, date extractions
  const virtualDims: Record<string, unknown>[] = [];
  for (const col of profile.columns) {
    if (col.is_primary_key || col.is_foreign_key) continue;
    const mappedType = mapSQLType(col.type);

    if (mappedType === "number" && !col.name.endsWith("_id")) {
      const label = col.name.replace(/_/g, " ");
      virtualDims.push({
        name: `${col.name}_bucket`,
        sql: `CASE\n  WHEN ${col.name} < (SELECT PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY ${col.name}) FROM ${profile.table_name}) THEN 'Low'\n  WHEN ${col.name} < (SELECT PERCENTILE_CONT(0.66) WITHIN GROUP (ORDER BY ${col.name}) FROM ${profile.table_name}) THEN 'Medium'\n  ELSE 'High'\nEND`,
        type: "string",
        description: `${label} bucketed into Low/Medium/High terciles`,
        virtual: true,
        sample_values: ["Low", "Medium", "High"],
      });
    }

    if (mappedType === "date") {
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

  // Build joins from foreign keys
  const joins: Record<string, unknown>[] = profile.foreign_keys.map((fk) => ({
    target_entity: entityName(fk.to_table),
    relationship: "many_to_one",
    join_columns: {
      from: fk.from_column,
      to: fk.to_column,
    },
    description: `Each ${singularize(profile.table_name)} belongs to one ${singularize(fk.to_table)}`,
  }));

  // Build measures
  const measures: Record<string, unknown>[] = [];

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

  // Build use_cases
  const useCases: string[] = [];
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
  if (joins.length > 0) {
    const targets = profile.foreign_keys.map((fk) => fk.to_table);
    useCases.push(
      `Join with ${targets.join(", ")} for cross-entity analysis`
    );
  }
  // Add "avoid" guidance for related tables
  const tablesPointingHere = allProfiles.filter((p) =>
    p.foreign_keys.some((fk) => fk.to_table === profile.table_name)
  );
  if (tablesPointingHere.length > 0) {
    useCases.push(
      `Avoid for row-level ${tablesPointingHere.map((p) => p.table_name).join("/")} queries — use those entities directly`
    );
  }
  if (useCases.length === 0) {
    useCases.push(`Use for querying ${profile.table_name} data`);
  }

  // Build query patterns
  const queryPatterns: Record<string, unknown>[] = [];

  // Pattern: count by enum column
  for (const col of enumCols.slice(0, 2)) {
    queryPatterns.push({
      description: `${entityName(profile.table_name)} by ${col.name}`,
      sql: `SELECT ${col.name}, COUNT(*) as count\nFROM ${profile.table_name}\nGROUP BY ${col.name}\nORDER BY count DESC`,
    });
  }

  // Pattern: aggregate numeric by enum
  if (numericCols.length > 0 && enumCols.length > 0) {
    const numCol = numericCols[0];
    const enumCol = enumCols[0];
    queryPatterns.push({
      description: `Total ${numCol.name} by ${enumCol.name}`,
      sql: `SELECT ${enumCol.name}, SUM(${numCol.name}) as total_${numCol.name}, COUNT(*) as count\nFROM ${profile.table_name}\nGROUP BY ${enumCol.name}\nORDER BY total_${numCol.name} DESC`,
    });
  }

  // Assemble entity
  const entity: Record<string, unknown> = {
    name,
    type: "fact_table",
    table: profile.table_name,
    grain: `one row per ${singularize(profile.table_name).replace(/_/g, " ")} record`,
    description: `Auto-profiled schema for ${profile.table_name} (${profile.row_count.toLocaleString()} rows). Contains ${profile.columns.length} columns${profile.foreign_keys.length > 0 ? `, linked to ${profile.foreign_keys.map((fk) => fk.to_table).join(", ")}` : ""}.`,
    dimensions: [...dimensions, ...virtualDims],
  };

  if (measures.length > 0) entity.measures = measures;
  if (joins.length > 0) entity.joins = joins;
  entity.use_cases = useCases;
  if (queryPatterns.length > 0) entity.query_patterns = queryPatterns;

  return yaml.dump(entity, { lineWidth: 120, noRefs: true });
}

function generateCatalogYAML(profiles: TableProfile[]): string {
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
      if (p.foreign_keys.length > 0) {
        useFor.push(
          `Cross-entity analysis via ${p.foreign_keys.map((fk) => fk.to_table).join(", ")}`
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
      if (p.foreign_keys.length > 0) {
        const fk = p.foreign_keys[0];
        questions.push(
          `How are ${p.table_name} distributed across ${fk.to_table}?`
        );
      }
      if (questions.length === 0) {
        questions.push(`What data is in ${p.table_name}?`);
      }

      return {
        name: entityName(p.table_name),
        file: `entities/${p.table_name}.yml`,
        grain: `one row per ${singularize(p.table_name).replace(/_/g, " ")} record`,
        description: `${p.table_name} (${p.row_count.toLocaleString()} rows, ${p.columns.length} columns)`,
        use_for: useFor,
        common_questions: questions,
      };
    }),
    glossary: "glossary.yml",
  };

  // Add metrics section if we'll be generating metric files
  const tablesWithNumericCols = profiles.filter((p) =>
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

  return yaml.dump(catalog, { lineWidth: 120, noRefs: true });
}

function generateMetricYAML(profile: TableProfile): string | null {
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

  const metrics: Record<string, unknown>[] = [];

  // Count metric
  if (pkCol) {
    metrics.push({
      id: `${profile.table_name}_count`,
      label: `Total ${entityName(profile.table_name)}`,
      description: `Count of distinct ${profile.table_name} records.`,
      type: "atomic",
      sql: `SELECT COUNT(DISTINCT ${pkCol.name}) as count\nFROM ${profile.table_name}`,
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
      sql: `SELECT SUM(${col.name}) as total_${col.name}\nFROM ${profile.table_name}`,
      aggregation: "sum",
      objective: "maximize",
    });

    metrics.push({
      id: `avg_${col.name}`,
      label: `Average ${col.name.replace(/_/g, " ")}`,
      description: `Average ${col.name} per ${singularize(profile.table_name)}.`,
      type: "atomic",
      sql: `SELECT AVG(${col.name}) as avg_${col.name}\nFROM ${profile.table_name}`,
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
        sql: `SELECT ${enumCol.name}, SUM(${col.name}) as total_${col.name}, AVG(${col.name}) as avg_${col.name}, COUNT(*) as count\nFROM ${profile.table_name}\nGROUP BY ${enumCol.name}\nORDER BY total_${col.name} DESC`,
      });
    }
  }

  return yaml.dump({ metrics }, { lineWidth: 120, noRefs: true });
}

function generateGlossaryYAML(profiles: TableProfile[]): string {
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

  if (Object.keys(terms).length === 0) {
    terms["example_term"] = {
      status: "defined",
      definition: "Replace this with your own business terms",
    };
  }

  return yaml.dump({ terms }, { lineWidth: 120, noRefs: true });
}

function mapSQLType(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("real") ||
    t.includes("numeric") ||
    t.includes("decimal")
  )
    return "number";
  if (t.includes("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp"))
    return "date";
  return "string";
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "init") {
    console.log(
      "Usage: bun run atlas -- init [--tables t1,t2] [--enrich] [--no-enrich]"
    );
    process.exit(1);
  }

  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;

  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error("Error: DATABASE_URL is required");
    process.exit(1);
  }

  // Test connection before profiling
  console.log("Testing database connection...");
  const testPool = new Pool({ connectionString: connStr, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await testPool.connect();
    const versionResult = await client.query("SELECT version()");
    console.log(`Connected: ${versionResult.rows[0].version.split(",")[0]}`);
    client.release();
  } catch (err) {
    console.error(`\nError: Cannot connect to database.`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`\nCheck that DATABASE_URL is correct and the server is running.`);
    process.exit(1);
  } finally {
    await testPool.end();
  }

  // Determine enrichment mode
  const explicitEnrich = args.includes("--enrich");
  const explicitNoEnrich = args.includes("--no-enrich");
  const hasApiKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AI_GATEWAY_API_KEY
  );
  const shouldEnrich =
    explicitEnrich || (!explicitNoEnrich && hasApiKey && !!process.env.ATLAS_PROVIDER);

  console.log(`\nAtlas Init — profiling database...\n`);

  const profiles = await profilePostgres(connStr, filterTables);

  console.log(`Found ${profiles.length} tables:\n`);
  for (const p of profiles) {
    const fkCount = p.foreign_keys.length;
    const pkInfo = p.primary_key_columns.length > 0 ? ` PK: ${p.primary_key_columns.join(",")}` : "";
    const fkInfo = fkCount > 0 ? ` FKs: ${fkCount}` : "";
    console.log(
      `  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} cols${pkInfo}${fkInfo}`
    );
  }

  // Write files
  fs.mkdirSync(ENTITIES_DIR, { recursive: true });
  fs.mkdirSync(METRICS_DIR, { recursive: true });

  // Generate entity YAMLs
  console.log(`\nGenerating semantic layer...\n`);

  for (const profile of profiles) {
    const filePath = path.join(ENTITIES_DIR, `${profile.table_name}.yml`);
    fs.writeFileSync(filePath, generateEntityYAML(profile, profiles));
    console.log(`  wrote ${filePath}`);
  }

  // Generate catalog
  const catalogPath = path.join(SEMANTIC_DIR, "catalog.yml");
  fs.writeFileSync(catalogPath, generateCatalogYAML(profiles));
  console.log(`  wrote ${catalogPath}`);

  // Generate glossary
  const glossaryPath = path.join(SEMANTIC_DIR, "glossary.yml");
  fs.writeFileSync(glossaryPath, generateGlossaryYAML(profiles));
  console.log(`  wrote ${glossaryPath}`);

  // Generate metric files per table
  for (const profile of profiles) {
    const metricYaml = generateMetricYAML(profile);
    if (metricYaml) {
      const filePath = path.join(METRICS_DIR, `${profile.table_name}.yml`);
      fs.writeFileSync(filePath, metricYaml);
      console.log(`  wrote ${filePath}`);
    }
  }

  // LLM enrichment (optional)
  if (shouldEnrich) {
    try {
      const { enrichSemanticLayer } = await import("./enrich.js");
      console.log(`\nEnriching with LLM (${process.env.ATLAS_PROVIDER ?? "anthropic"})...\n`);
      await enrichSemanticLayer(profiles);
    } catch (e) {
      if (explicitEnrich) {
        console.error(`\nLLM enrichment failed: ${e instanceof Error ? e.message : e}`);
        console.error("Generated base semantic layer without enrichment.\n");
      }
      // Silent fallback if auto-detected
    }
  }

  console.log(`
Done! Your semantic layer is at ./semantic/

Generated:
  - ${profiles.length} entity YAMLs with dimensions, joins, measures, and query patterns
  - catalog.yml with use_for guidance and common questions
  - glossary.yml with auto-detected terms and ambiguities
  - Metric definitions in metrics/*.yml
${shouldEnrich ? "  - LLM-enriched descriptions, use cases, and business context\n" : ""}
Next steps:
  1. Review the generated YAMLs and refine business context
  2. Run \`bun run dev\` to start Atlas
`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
