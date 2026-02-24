#!/usr/bin/env tsx
/**
 * Atlas CLI — auto-generate semantic layer from your database.
 *
 * Usage:
 *   npx atlas init                     # Profile DB and generate semantic layer
 *   npx atlas init --db postgres       # Specify database type
 *   npx atlas init --tables users,orders  # Only specific tables
 *
 * This is the "connect your DB, get a working analyst in 5 minutes" experience.
 */

import { Pool } from "pg";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const SEMANTIC_DIR = path.resolve("semantic");
const ENTITIES_DIR = path.join(SEMANTIC_DIR, "entities");

interface ColumnProfile {
  name: string;
  type: string;
  nullable: boolean;
  unique_count: number | null;
  null_count: number | null;
  sample_values: string[];
}

interface TableProfile {
  table_name: string;
  row_count: number;
  columns: ColumnProfile[];
}

// --- SQLite profiler ---
async function profileSQLite(
  dbPath: string,
  filterTables?: string[]
): Promise<TableProfile[]> {
  const db = new Database(dbPath, { readonly: true });
  const profiles: TableProfile[] = [];

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];

  for (const { name } of tables) {
    if (filterTables && !filterTables.includes(name)) continue;

    const rowCount = (
      db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number }
    ).c;

    const columnInfo = db.prepare(`PRAGMA table_info("${name}")`).all() as {
      name: string;
      type: string;
      notnull: number;
    }[];

    const columns: ColumnProfile[] = [];

    for (const col of columnInfo) {
      let unique_count: number | null = null;
      let null_count: number | null = null;
      let sample_values: string[] = [];

      try {
        unique_count = (
          db
            .prepare(
              `SELECT COUNT(DISTINCT "${col.name}") as c FROM "${name}"`
            )
            .get() as { c: number }
        ).c;

        null_count = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM "${name}" WHERE "${col.name}" IS NULL`
            )
            .get() as { c: number }
        ).c;

        const samples = db
          .prepare(
            `SELECT DISTINCT "${col.name}" as v FROM "${name}" WHERE "${col.name}" IS NOT NULL LIMIT 10`
          )
          .all() as { v: unknown }[];

        sample_values = samples.map((s) => String(s.v));
      } catch {
        // Skip profiling errors for complex types
      }

      columns.push({
        name: col.name,
        type: col.type.toLowerCase() || "text",
        nullable: !col.notnull,
        unique_count,
        null_count,
        sample_values,
      });
    }

    profiles.push({ table_name: name, row_count: rowCount, columns });
  }

  db.close();
  return profiles;
}

// --- PostgreSQL profiler ---
async function profilePostgres(
  connectionString: string,
  filterTables?: string[]
): Promise<TableProfile[]> {
  const pool = new Pool({ connectionString, max: 3 });
  const profiles: TableProfile[] = [];

  const tablesResult = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  for (const { table_name } of tablesResult.rows) {
    if (filterTables && !filterTables.includes(table_name)) continue;

    const countResult = await pool.query(
      `SELECT COUNT(*) as c FROM "${table_name}"`
    );
    const rowCount = parseInt(countResult.rows[0].c, 10);

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

      try {
        const uq = await pool.query(
          `SELECT COUNT(DISTINCT "${col.column_name}") as c FROM "${table_name}"`
        );
        unique_count = parseInt(uq.rows[0].c, 10);

        const nc = await pool.query(
          `SELECT COUNT(*) as c FROM "${table_name}" WHERE "${col.column_name}" IS NULL`
        );
        null_count = parseInt(nc.rows[0].c, 10);

        const sv = await pool.query(
          `SELECT DISTINCT "${col.column_name}" as v FROM "${table_name}" WHERE "${col.column_name}" IS NOT NULL LIMIT 10`
        );
        sample_values = sv.rows.map((r: { v: unknown }) => String(r.v));
      } catch {
        // Skip
      }

      columns.push({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === "YES",
        unique_count,
        null_count,
        sample_values,
      });
    }

    profiles.push({ table_name, row_count: rowCount, columns });
  }

  await pool.end();
  return profiles;
}

// --- Generate YAML from profile ---
function generateEntityYAML(profile: TableProfile): string {
  const entity = {
    name: profile.table_name.charAt(0).toUpperCase() + profile.table_name.slice(1),
    type: "fact_table",
    table: profile.table_name,
    grain: `one row per ${profile.table_name.replace(/_/g, " ").replace(/s$/, "")} record`,
    description: `Auto-generated schema for ${profile.table_name} (${profile.row_count.toLocaleString()} rows). Review and enrich this with business context.`,
    dimensions: profile.columns.map((col) => {
      const dim: Record<string, unknown> = {
        name: col.name,
        sql: col.name,
        type: mapSQLType(col.type),
      };
      if (col.unique_count !== null) dim.unique_count = col.unique_count;
      if (col.null_count !== null && col.null_count > 0) dim.null_count = col.null_count;
      if (col.sample_values.length > 0) dim.sample_values = col.sample_values.slice(0, 8);
      return dim;
    }),
    use_cases: [
      `TODO: Add use cases for ${profile.table_name}`,
      `TODO: Add common questions`,
    ],
  };

  return yaml.dump(entity, { lineWidth: 100, noRefs: true });
}

function generateCatalogYAML(profiles: TableProfile[]): string {
  const catalog = {
    version: "1.0",
    entities: profiles.map((p) => ({
      name: p.table_name.charAt(0).toUpperCase() + p.table_name.slice(1),
      file: `entities/${p.table_name}.yml`,
      grain: `one row per ${p.table_name.replace(/_/g, " ").replace(/s$/, "")} record`,
      description: `${p.table_name} (${p.row_count.toLocaleString()} rows)`,
      common_questions: [`TODO: Add questions about ${p.table_name}`],
    })),
    glossary: "glossary.yml",
  };

  return yaml.dump(catalog, { lineWidth: 100, noRefs: true });
}

function mapSQLType(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes("int") || t.includes("float") || t.includes("real") || t.includes("numeric") || t.includes("decimal"))
    return "number";
  if (t.includes("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp")) return "date";
  return "string";
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "init") {
    console.log("Usage: npx atlas init [--db sqlite|postgres] [--tables t1,t2]");
    process.exit(1);
  }

  const dbType = getFlag(args, "--db") ?? process.env.ATLAS_DB ?? "sqlite";
  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;

  console.log(`\nAtlas Init — profiling ${dbType} database...\n`);

  let profiles: TableProfile[];

  if (dbType === "sqlite") {
    const dbPath = process.env.ATLAS_SQLITE_PATH ?? "./data/atlas.db";
    profiles = await profileSQLite(dbPath, filterTables);
  } else if (dbType === "postgres") {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) {
      console.error("Error: DATABASE_URL is required for postgres");
      process.exit(1);
    }
    profiles = await profilePostgres(connStr, filterTables);
  } else {
    console.error(`Unknown db type: ${dbType}`);
    process.exit(1);
  }

  console.log(`Found ${profiles.length} tables:\n`);
  for (const p of profiles) {
    console.log(`  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} columns`);
  }

  // Write files
  fs.mkdirSync(ENTITIES_DIR, { recursive: true });
  fs.mkdirSync(path.join(SEMANTIC_DIR, "metrics"), { recursive: true });

  for (const profile of profiles) {
    const filePath = path.join(ENTITIES_DIR, `${profile.table_name}.yml`);
    fs.writeFileSync(filePath, generateEntityYAML(profile));
    console.log(`  wrote ${filePath}`);
  }

  const catalogPath = path.join(SEMANTIC_DIR, "catalog.yml");
  fs.writeFileSync(catalogPath, generateCatalogYAML(profiles));
  console.log(`  wrote ${catalogPath}`);

  // Write empty glossary if it doesn't exist
  const glossaryPath = path.join(SEMANTIC_DIR, "glossary.yml");
  if (!fs.existsSync(glossaryPath)) {
    fs.writeFileSync(
      glossaryPath,
      yaml.dump({
        terms: {
          example_term: {
            status: "defined",
            definition: "Replace this with your own business terms",
          },
        },
      })
    );
    console.log(`  wrote ${glossaryPath}`);
  }

  console.log(`
Done! Your semantic layer is at ./semantic/

Next steps:
  1. Review the generated entity YAMLs and add business context
  2. Add use_cases and common_questions to catalog.yml
  3. Create metric definitions in metrics/*.yml
  4. Add ambiguous terms to glossary.yml
  5. Run \`npm run dev\` to start Atlas
`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
