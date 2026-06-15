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
  esEntityToSnapshot,
  computeDiff,
  formatDiff,
  type EntitySnapshot,
} from "../../lib/diff";
import {
  profileElasticsearch,
  elasticsearchConfigFromEnv,
} from "../../../../plugins/elasticsearch/src/profiler";

export async function handleDiff(args: string[]): Promise<void> {
  // An Elastic Cloud ID names the endpoint without a URL (#3309). Trimmed so
  // a whitespace-only value behaves like unset (and reaches the Cloud-ID
  // branch instead of failing scheme detection).
  const connStr = (process.env.ATLAS_DATASOURCE_URL ?? "").trim();
  if (!connStr && !process.env.ATLAS_ES_CLOUD_ID) {
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
    console.error(
      "  Elasticsearch / OpenSearch: ATLAS_DATASOURCE_URL=elasticsearch://host:9200 (or opensearch://host:9200),",
    );
    console.error(
      "                 or ATLAS_ES_CLOUD_ID=<cloud-id> for an Elastic Cloud deployment (no URL needed).",
    );
    console.error(
      "                 Auth via ATLAS_ES_API_KEY, ATLAS_ES_USERNAME/ATLAS_ES_PASSWORD, or ATLAS_ES_AWS_REGION (AWS SigV4).",
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
    // An empty connStr is only reachable on the Elastic Cloud ID path —
    // ATLAS_ES_CLOUD_ID names the endpoint, so there is no scheme to sniff.
    dbType = connStr ? detectDBType(connStr) : "elasticsearch";
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
    if (dbType === "elasticsearch") {
      // The endpoint may be a Cloud ID with no URL at all — point at the full
      // ATLAS_ES_* contract instead of the (possibly absent) URL.
      console.error(
        `\nCheck the endpoint (elasticsearch:// / opensearch:// URL or ` +
          `ATLAS_ES_CLOUD_ID) and the ATLAS_ES_* credentials.`,
      );
    } else {
      console.error(
        `\nCheck that ATLAS_DATASOURCE_URL is correct and the server is running.`,
      );
    }
    process.exit(1);
  }

  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;

  // Live-side snapshots, populated by the ES or SQL branch below.
  const dbSnapshots = new Map<string, EntitySnapshot>();

  if (dbType === "elasticsearch") {
    // Elasticsearch profiles index mappings into entity docs — no SQL
    // TableProfile pipeline, no --schema (Postgres-only). Credentials are read
    // from the ATLAS_ES_* env contract (API key / Basic / SigV4, optional
    // Cloud ID + engine override), never the URL (#3309).
    console.log(`\nProfiling Elasticsearch mappings...\n`);
    try {
      const esConfig = elasticsearchConfigFromEnv(connStr || undefined);
      const { entities, errors } = await profileElasticsearch(
        esConfig,
        filterTables,
      );
      for (const e of errors) {
        console.warn(`  Warning: ${e.table}: ${e.error}`);
      }
      for (const entity of entities) {
        dbSnapshots.set(entity.table, esEntityToSnapshot(entity));
      }
    } catch (err) {
      console.error(`\nError: Failed to profile Elasticsearch.`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (dbSnapshots.size === 0) {
      console.error(
        "Error: No indices were profiled from the cluster — it exposes no user " +
          "indices, or every requested index was missing or had no fields.",
      );
      process.exit(1);
    }
  } else {
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
          result = await profileMySQL({
            url: connStr,
            selectedTables: filterTables,
            logger: cliProfileLogger,
          });
          break;
        case "postgres":
          result = await profilePostgres({
            url: connStr,
            schema: schemaArg,
            selectedTables: filterTables,
            logger: cliProfileLogger,
          });
          break;
        case "clickhouse": {
          const { profileClickHouse } = await import("../../../../plugins/clickhouse/src/profiler");
          result = await profileClickHouse({ url: connStr, selectedTables: filterTables });
          break;
        }
        case "snowflake": {
          // Snowflake profiling lives on the plugin profiler contract (ADR-0017,
          // #3622) — consume the plugin export directly (CLI → plugin, no @atlas/api).
          const { profileSnowflake } = await import(
            "../../../../plugins/snowflake/src/profiler"
          );
          result = await profileSnowflake({ url: connStr, selectedTables: filterTables });
          break;
        }
        case "duckdb": {
          // DuckDB profiling consumes the plugin's `profile` export directly
          // (ADR-0017, #3623) — CLI → plugin, no @atlas/api.
          const { profileDuckDB } = await import(
            "../../../../plugins/duckdb/src/profiler"
          );
          result = await profileDuckDB({ url: connStr, selectedTables: filterTables });
          break;
        }
        case "salesforce": {
          const { profileSalesforce } = await import("../../../../plugins/salesforce/src/profiler");
          result = await profileSalesforce({ url: connStr, selectedTables: filterTables });
          break;
        }
        case "bigquery": {
          const { profileBigQuery } = await import(
            "../../../../plugins/bigquery/src/profiler"
          );
          result = await profileBigQuery({ url: connStr, selectedTables: filterTables });
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
    for (const profile of profiles) {
      dbSnapshots.set(profile.table_name, profileToSnapshot(profile));
    }
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
