/**
 * atlas diff -- Compare DB schema against the existing semantic layer.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { DBType } from "@atlas/api/lib/db/connection";
import type { TableProfile, ProfilingResult } from "@atlas/api/lib/profiler";
import {
  analyzeTableProfiles,
  profilePostgres,
  profileMySQL,
} from "@atlas/api/lib/profiler";
import {
  getFlag,
  requireFlagIdentifier,
  detectDBType,
  validateSchemaName,
  logProfilingErrors,
  cliProfileLogger,
  SEMANTIC_DIR,
  ENTITIES_DIR,
} from "../../lib/cli-utils";
import { testDatabaseConnection } from "../../lib/test-connection";
import {
  parseEntityYAML,
  profileToSnapshot,
  computeDiff,
  formatDiff,
} from "../../lib/diff";

export async function handleDiff(args: string[]): Promise<void> {
  const connStr = process.env.ATLAS_DATASOURCE_URL;
  if (!connStr) {
    console.error("Error: ATLAS_DATASOURCE_URL is required for atlas diff.");
    console.error(
      "  PostgreSQL:  ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname",
    );
    console.error(
      "  MySQL:       ATLAS_DATASOURCE_URL=mysql://user:pass@host:3306/dbname",
    );
    console.error(
      "  Snowflake:   ATLAS_DATASOURCE_URL=snowflake://user:pass@account/database/schema?warehouse=WH",
    );
    console.error(
      "  Salesforce:  ATLAS_DATASOURCE_URL=salesforce://user:pass@login.salesforce.com?token=TOKEN",
    );
    process.exit(1);
  }

  // Determine entities directory -- per-source layout if --source is provided
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");
  const entitiesDir = sourceArg
    ? path.join(SEMANTIC_DIR, sourceArg, "entities")
    : ENTITIES_DIR;

  // Check semantic layer exists
  if (!fs.existsSync(entitiesDir)) {
    console.error(
      `Error: ${entitiesDir} not found. Run \`bun run atlas -- init${sourceArg ? ` --source ${sourceArg}` : ""}\` first.`,
    );
    process.exit(1);
  }
  const yamlFiles = fs
    .readdirSync(entitiesDir)
    .filter((f) => f.endsWith(".yml"));
  if (yamlFiles.length === 0) {
    console.error(
      `Error: No entity YAMLs found in ${entitiesDir}. Run \`bun run atlas -- init${sourceArg ? ` --source ${sourceArg}` : ""}\` first.`,
    );
    process.exit(1);
  }

  let dbType: DBType;
  try {
    dbType = detectDBType(connStr);
  } catch (err) {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Test connection using shared utility
  console.log("Testing database connection...");
  try {
    const version = await testDatabaseConnection(connStr, dbType);
    console.log(`Connected: ${version}`);
  } catch (err) {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      `\nCheck that ATLAS_DATASOURCE_URL is correct and the server is running.`,
    );
    process.exit(1);
  }

  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;
  let schemaArg =
    getFlag(args, "--schema") ?? process.env.ATLAS_SCHEMA ?? "public";

  validateSchemaName(schemaArg);
  if (schemaArg !== "public" && dbType !== "postgres") {
    console.warn(
      `Warning: --schema is only supported for PostgreSQL. Ignoring "${schemaArg}" for ${dbType}.`,
    );
    schemaArg = "public";
  }

  // Profile live DB
  console.log(`\nProfiling ${dbType} database...\n`);
  let profiles: TableProfile[];
  try {
    let result: ProfilingResult;
    switch (dbType) {
      case "mysql":
        result = await profileMySQL(
          connStr,
          filterTables,
          undefined,
          undefined,
          cliProfileLogger,
        );
        break;
      case "postgres":
        result = await profilePostgres(
          connStr,
          filterTables,
          undefined,
          schemaArg,
          undefined,
          cliProfileLogger,
        );
        break;
      case "clickhouse": {
        const { profileClickHouse } = await import("../../lib/profilers/clickhouse");
        result = await profileClickHouse(connStr, filterTables);
        break;
      }
      case "snowflake": {
        const { profileSnowflake } = await import("../../lib/profilers/snowflake");
        result = await profileSnowflake(connStr, filterTables);
        break;
      }
      case "duckdb": {
        const { parseDuckDBUrl } = await import(
          "../../../../plugins/duckdb/src/connection"
        );
        const { profileDuckDB } = await import("../../lib/profilers/duckdb");
        const duckConfig = parseDuckDBUrl(connStr);
        result = await profileDuckDB(duckConfig.path, filterTables);
        break;
      }
      case "salesforce": {
        const { profileSalesforce } = await import("../../lib/profilers/salesforce");
        result = await profileSalesforce(connStr, filterTables);
        break;
      }
      default: {
        throw new Error(`Unknown database type: ${dbType}`);
      }
    }
    profiles = result.profiles;
    if (result.errors.length > 0) {
      const total = result.profiles.length + result.errors.length;
      logProfilingErrors(result.errors, total);
      console.warn(
        `Continuing diff with ${profiles.length} successfully profiled tables.\n`,
      );
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
  profiles = analyzeTableProfiles(profiles);

  // Build DB snapshots
  const dbSnapshots = new Map<
    string,
    ReturnType<typeof profileToSnapshot>
  >();
  for (const profile of profiles) {
    dbSnapshots.set(profile.table_name, profileToSnapshot(profile));
  }

  // Parse YAML snapshots
  const yamlSnapshots = new Map<
    string,
    ReturnType<typeof parseEntityYAML>
  >();
  const yamlErrors: string[] = [];
  for (const file of yamlFiles) {
    try {
      const content = fs.readFileSync(
        path.join(entitiesDir, file),
        "utf-8",
      );
      const doc = yaml.load(content) as Record<string, unknown>;
      if (!doc || typeof doc.table !== "string") {
        console.warn(
          `[atlas diff] Skipping ${file}: missing or non-string 'table' field`,
        );
        continue;
      }
      const tableName = doc.table as string;
      // If --tables filter is set, only include matching YAML entities
      if (filterTables && !filterTables.includes(tableName)) continue;
      yamlSnapshots.set(tableName, parseEntityYAML(doc));
    } catch (err) {
      yamlErrors.push(
        `${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (yamlErrors.length > 0) {
    console.warn(
      `\nWarning: Failed to parse ${yamlErrors.length} YAML file(s):`,
    );
    for (const e of yamlErrors) console.warn(`  - ${e}`);
  }
  if (yamlSnapshots.size === 0 && yamlFiles.length > 0) {
    console.warn(
      `\nWarning: No valid entity YAML files found despite files existing in ${entitiesDir}.`,
    );
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
