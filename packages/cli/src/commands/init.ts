/**
 * atlas init — Profile a database and generate semantic layer YAML files.
 *
 * Extracted from atlas.ts to reduce monolith size. Includes:
 * - handleIndex() (atlas index subcommand)
 * - profileDatasource() and its orchestration logic
 * - Demo dataset seeding
 * - The main init handler with CSV/Parquet, multi-source, and org-scoped modes
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { type DBType } from "@atlas/api/lib/db/connection";
import type { DatabaseObject, ProfilingResult } from "@atlas/api/lib/profiler";
import {
  checkFailureThreshold,
  isView,
  isMatView,
  isViewLike,
  analyzeTableProfiles,
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
  outputDirForDatasource,
  listPostgresObjects,
  listMySQLObjects,
} from "@atlas/api/lib/profiler";
import {
  createProgressTracker,
  formatDuration,
} from "../progress";
import {
  cliProfileLogger,
  detectDBType,
  getFlag,
  logProfilingErrors,
  requireFlagIdentifier,
  validateIdentifier,
  validateSchemaName,
  SEMANTIC_DIR,
} from "../../lib/cli-utils";
import { testDatabaseConnection } from "../../lib/test-connection";
import {
  listClickHouseObjects,
  profileClickHouse,
  listSnowflakeObjects,
  profileSnowflake,
  listSalesforceObjects,
  profileSalesforce,
  ingestIntoDuckDB,
  listDuckDBObjects,
  profileDuckDB,
} from "../../lib/profilers";
import { profileMySQL, profilePostgres } from "@atlas/api/lib/profiler";

// --- Demo datasets ---

export type DemoDataset = "simple" | "cybersec" | "ecommerce";

export const DEMO_DATASETS: Record<
  DemoDataset,
  { pg: string; semanticDir: string; label: string }
> = {
  simple: {
    pg: "seeds/simple/seed.sql",
    semanticDir: "seeds/simple/semantic",
    label: "Demo data loaded: 50 companies, ~200 people, 80 accounts",
  },
  cybersec: {
    pg: "seeds/cybersec/seed.sql",
    semanticDir: "seeds/cybersec/semantic",
    label:
      "Cybersec demo loaded: 62 tables, ~500K rows (Sentinel Security SaaS)",
  },
  ecommerce: {
    pg: "seeds/ecommerce/seed.sql",
    semanticDir: "seeds/ecommerce/semantic",
    label:
      "E-commerce demo loaded: 52 tables, ~480K rows (NovaMart DTC brand)",
  },
};

export function parseDemoArg(args: string[]): DemoDataset | null {
  const hasDemo = args.includes("--demo");
  const hasSeed = args.includes("--seed");
  if (!hasDemo && !hasSeed) return null;
  if (hasDemo && hasSeed) {
    throw new Error("Cannot use both --demo and --seed. They are aliases — pick one.");
  }
  const flag = hasDemo ? "--demo" : "--seed";
  const next = getFlag(args, flag);
  if (!next || next.startsWith("--")) return "simple"; // bare flag → backward compatible default
  if (next in DEMO_DATASETS) return next as DemoDataset;
  throw new Error(
    `Unknown demo dataset "${next}". Available: ${Object.keys(DEMO_DATASETS).join(", ")}`,
  );
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
  dataset: DemoDataset,
): Promise<void> {
  const meta = DEMO_DATASETS[dataset];
  const sqlFile = path.resolve(import.meta.dir, "../../data", meta.pg);
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
    throw new Error(
      `Failed to seed ${dataset} demo data into Postgres: ${msg}`,
      { cause: err },
    );
  } finally {
    await pool.end();
  }
}

// --- Index CLI handler ---

export async function handleIndex(args: string[]): Promise<void> {
  const statsOnly = args.includes("--stats");

  if (!fs.existsSync(SEMANTIC_DIR)) {
    console.error(
      pc.red("No semantic/ directory found. Run 'atlas init' first."),
    );
    process.exit(1);
  }

  try {
    const { getSemanticIndexStats, buildSemanticIndex } = await import(
      "@atlas/api/lib/semantic/search"
    );

    // Use stats-based validation — works for both default and per-source layouts
    const stats = getSemanticIndexStats(SEMANTIC_DIR);

    if (stats.entities === 0) {
      console.error(
        pc.red(
          "No valid entity YAML files found in semantic/. Run 'atlas init' first.",
        ),
      );
      process.exit(1);
    }

    if (statsOnly) {
      console.log(
        `${pc.bold("Semantic index stats:")} ` +
          `${stats.entities} entities, ${stats.dimensions} dimensions, ` +
          `${stats.measures} measures, ${stats.metrics} metrics, ` +
          `${stats.glossaryTerms} glossary terms (${stats.keywords} keywords)`,
      );
      return;
    }

    // Full rebuild — buildSemanticIndex does its own loading; stats above are for validation + display
    const start = Date.now();
    buildSemanticIndex(SEMANTIC_DIR);
    const elapsed = Date.now() - start;

    console.log(
      pc.green("\u2713") +
        ` Indexed ${stats.entities} entities, ` +
        `${stats.dimensions} dimensions, ${stats.measures} measures ` +
        `(${stats.keywords} keywords) in ${elapsed}ms`,
    );
  } catch (err) {
    console.error(pc.red("Failed to build semantic index."));
    console.error(
      `  ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// --- Profile a single datasource ---

interface ProfileDatasourceOpts {
  id: string; // "default", "warehouse", etc.
  url: string;
  dbType: DBType;
  schema: string; // resolved schema for this datasource
  filterTables?: string[];
  shouldEnrich: boolean;
  explicitEnrich: boolean;
  demoDataset: DemoDataset | null; // null for multi-source runs (--demo is single-datasource only)
  force: boolean; // skip failure threshold check
  orgId?: string; // org-scoped mode: write to semantic/.orgs/{orgId}/
}

interface DatasourceEntry {
  id: string;
  url: string;
  schema: string;
}

async function profileDatasource(
  opts: ProfileDatasourceOpts,
): Promise<void> {
  const {
    id,
    url: connStr,
    dbType,
    filterTables,
    shouldEnrich,
    explicitEnrich,
    demoDataset,
    force,
    orgId,
  } = opts;
  let { schema: schemaArg } = opts;

  validateSchemaName(schemaArg);

  // The source name for YAML connection: field — "default" omits it
  const sourceId = id === "default" ? undefined : id;

  // --schema is PostgreSQL-only
  if (schemaArg !== "public" && dbType !== "postgres") {
    console.warn(
      `Warning: --schema is only supported for PostgreSQL. Ignoring "${schemaArg}" for ${dbType}.`,
    );
    schemaArg = "public";
  }

  // Seed demo data if requested
  if (demoDataset) {
    if (dbType !== "postgres") {
      console.error(
        `Error: --demo is not supported for ${dbType}. Demo SQL files use PostgreSQL-specific syntax.` +
          (dbType === "duckdb"
            ? " For DuckDB, use --csv or --parquet instead."
            : ""),
      );
      throw new Error(`--demo is not supported for ${dbType}.`);
    }
    console.log(`Seeding ${demoDataset} demo data (${dbType})...`);
    await seedDemoPostgres(connStr, demoDataset);
    console.log("");
  }

  // Test connection before profiling
  console.log("Testing database connection...");
  try {
    const version = await testDatabaseConnection(connStr, dbType);
    console.log(`Connected: ${version}`);
  } catch (err) {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      `\nCheck that the datasource URL is correct and the server is running.`,
    );
    throw err;
  }

  // Interactive table/view selection (TTY only, when --tables and --demo not provided)
  let selectedTables = filterTables;
  let prefetchedObjects: DatabaseObject[] | undefined;

  if (!selectedTables && !demoDataset && process.stdin.isTTY) {
    let allObjects: DatabaseObject[];
    try {
      switch (dbType) {
        case "mysql":
          allObjects = await listMySQLObjects(connStr, cliProfileLogger);
          break;
        case "postgres":
          allObjects = await listPostgresObjects(
            connStr,
            schemaArg,
            cliProfileLogger,
          );
          break;
        case "clickhouse":
          allObjects = await listClickHouseObjects(connStr);
          break;
        case "snowflake":
          allObjects = await listSnowflakeObjects(connStr);
          break;
        case "duckdb": {
          const { parseDuckDBUrl } = await import(
            "../../../../plugins/duckdb/src/connection"
          );
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
      console.error(
        `\nError: Failed to list tables from ${dbType} database.`,
      );
      console.error(
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    if (allObjects.length === 0) {
      throw new Error("No tables or views found in the database.");
    }

    const selected = await p.multiselect({
      message: `Select tables/views to profile (${allObjects.length} found)`,
      options: allObjects.map((obj) => ({
        value: obj.name,
        label:
          obj.type === "view" ? `${obj.name} (view)` : obj.name,
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
    p.log.info(
      `Selected ${pc.cyan(String(selectedTables.length))} of ${allObjects.length} tables/views.`,
    );
  } else if (!selectedTables && demoDataset) {
    console.log("Demo mode: profiling all tables and views.");
  } else if (!selectedTables) {
    console.log(
      "Non-interactive mode: profiling all tables and views. Use --tables to select specific ones.",
    );
  }

  console.log(`\nAtlas Init — profiling ${dbType} database...\n`);

  const progress = createProgressTracker();
  const profilingStart = Date.now();

  let result: ProfilingResult;
  switch (dbType) {
    case "mysql":
      result = await profileMySQL(
        connStr,
        selectedTables,
        prefetchedObjects,
        progress,
        cliProfileLogger,
      );
      break;
    case "postgres":
      result = await profilePostgres(
        connStr,
        selectedTables,
        prefetchedObjects,
        schemaArg,
        progress,
        cliProfileLogger,
      );
      break;
    case "clickhouse":
      result = await profileClickHouse(
        connStr,
        selectedTables,
        prefetchedObjects,
        progress,
      );
      break;
    case "snowflake":
      result = await profileSnowflake(
        connStr,
        selectedTables,
        prefetchedObjects,
        progress,
      );
      break;
    case "duckdb": {
      const { parseDuckDBUrl } = await import(
        "../../../../plugins/duckdb/src/connection"
      );
      const duckConfig = parseDuckDBUrl(connStr);
      result = await profileDuckDB(
        duckConfig.path,
        selectedTables,
        prefetchedObjects,
        progress,
      );
      break;
    }
    case "salesforce":
      result = await profileSalesforce(
        connStr,
        selectedTables,
        prefetchedObjects,
        progress,
      );
      break;
    default: {
      throw new Error(`Unknown database type: ${dbType}`);
    }
  }

  let { profiles } = result;
  const { errors: profilingErrors } = result;
  const profilingElapsed = Date.now() - profilingStart;
  progress.onComplete(profiles.length, profilingElapsed);

  if (profiles.length === 0) {
    throw new Error(
      "No tables or views were successfully profiled. Check the warnings above and verify your database permissions.",
    );
  }

  // Always warn about profiling errors
  if (profilingErrors.length > 0) {
    const totalAttempted = profiles.length + profilingErrors.length;
    logProfilingErrors(profilingErrors, totalAttempted);

    const { shouldAbort } = checkFailureThreshold(result, force);
    if (shouldAbort) {
      console.error(
        `\nThis usually indicates a connection or permission issue.`,
      );
      console.error(
        `Run \`atlas doctor\` to diagnose. Use \`--force\` to continue anyway.`,
      );
      throw new Error(
        `Profiling failed for ${profilingErrors.length}/${totalAttempted} tables ` +
          `(${Math.round((profilingErrors.length / totalAttempted) * 100)}%). ` +
          `Use --force to continue anyway.`,
      );
    }
    console.warn(
      `Continuing with ${profiles.length} successfully profiled tables.\n`,
    );
  }

  // Run profiler heuristics
  profiles = analyzeTableProfiles(profiles);

  const tableCount = profiles.filter((p) => !isViewLike(p)).length;
  const viewCount = profiles.filter((p) => isView(p)).length;
  const matviewCount = profiles.filter((p) => isMatView(p)).length;
  const countParts: string[] = [];
  countParts.push(
    `${tableCount} table${tableCount !== 1 ? "s" : ""}`,
  );
  if (viewCount > 0)
    countParts.push(
      `${viewCount} view${viewCount !== 1 ? "s" : ""}`,
    );
  if (matviewCount > 0)
    countParts.push(
      `${matviewCount} materialized view${matviewCount !== 1 ? "s" : ""}`,
    );
  console.log(`Found ${countParts.join(", ")}:\n`);
  for (const p of profiles) {
    const fkCount = p.foreign_keys.length;
    const inferredFkCount = p.inferred_foreign_keys.length;
    const pkInfo =
      p.primary_key_columns.length > 0
        ? ` PK: ${p.primary_key_columns.join(",")}`
        : "";
    const fkInfo = fkCount > 0 ? ` FKs: ${fkCount}` : "";
    const inferredFkInfo =
      inferredFkCount > 0 ? ` +${inferredFkCount} inferred` : "";
    const flags: string[] = [];
    if (isView(p)) flags.push("[view]");
    if (isMatView(p)) flags.push("[matview]");
    if (p.partition_info)
      flags.push(`[partitioned:${p.partition_info.strategy}]`);
    if (p.table_flags.possibly_abandoned)
      flags.push("[possibly-abandoned]");
    if (p.table_flags.possibly_denormalized)
      flags.push("[denormalized]");
    const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
    console.log(
      `  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} cols${pkInfo}${fkInfo}${inferredFkInfo}${flagStr}`,
    );
  }

  // Tech debt summary
  const totalInferredFKs = profiles.reduce(
    (n, p) => n + p.inferred_foreign_keys.length,
    0,
  );
  const totalAbandoned = profiles.filter(
    (p) => p.table_flags.possibly_abandoned,
  ).length;
  const totalEnumIssues = profiles.reduce(
    (n, p) =>
      n +
      p.columns.filter((c) =>
        c.profiler_notes.some((note) =>
          note.startsWith("Case-inconsistent"),
        ),
      ).length,
    0,
  );
  const totalDenormalized = profiles.filter(
    (p) => p.table_flags.possibly_denormalized,
  ).length;

  if (
    totalInferredFKs +
      totalAbandoned +
      totalEnumIssues +
      totalDenormalized >
    0
  ) {
    console.log(
      `\nTech debt detected: ${totalInferredFKs} inferred FKs, ${totalAbandoned} abandoned tables, ${totalEnumIssues} enum issues, ${totalDenormalized} denormalized tables`,
    );
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
    const filePath = path.join(
      entitiesOutDir,
      `${profile.table_name}.yml`,
    );
    fs.writeFileSync(
      filePath,
      generateEntityYAML(
        profile,
        profiles,
        dbType,
        schemaArg,
        sourceId,
      ),
    );
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
      const filePath = path.join(
        metricsOutDir,
        `${profile.table_name}.yml`,
      );
      fs.writeFileSync(filePath, metricYaml);
      console.log(`  wrote ${filePath}`);
    }
  }

  // Overlay hand-crafted semantic files with richer descriptions for demo datasets
  if (demoDataset) {
    const meta = DEMO_DATASETS[demoDataset];
    const curatedSemanticDir = path.resolve(
      import.meta.dir,
      "../../data",
      meta.semanticDir,
    );
    if (fs.existsSync(curatedSemanticDir)) {
      console.log(`\nApplying curated ${demoDataset} semantic layer...\n`);
      copyDirRecursive(curatedSemanticDir, outputBase);
    } else {
      console.warn(
        `\nWarning: Curated semantic layer for "${demoDataset}" not found at ${curatedSemanticDir}.` +
        `\nThe auto-profiled semantic layer will be used, which may have less descriptive metadata.` +
        `\nThis usually indicates an incomplete package installation — try reinstalling @atlas/cli.\n`,
      );
    }
  }

  // LLM enrichment (optional)
  let enrichmentSucceeded = false;
  if (shouldEnrich) {
    try {
      const { enrichSemanticLayer } = await import("../../bin/enrich.js");
      console.log(
        `\nEnriching with LLM (${process.env.ATLAS_PROVIDER ?? "anthropic"})...\n`,
      );
      await enrichSemanticLayer(profiles, {
        semanticDir: outputBase,
      });
      enrichmentSucceeded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (explicitEnrich) {
        console.error(`\nLLM enrichment failed: ${msg}`);
        console.error(
          "Base semantic layer was written but enrichment failed.\n",
        );
        throw e;
      } else {
        console.warn(
          `\nNote: LLM enrichment was auto-detected but failed: ${msg}`,
        );
        console.warn(
          "The semantic layer was generated without LLM enrichment.\n",
        );
      }
    }
  }

  const relativeOutput = orgId
    ? `./semantic/.orgs/${orgId}/`
    : id === "default"
      ? "./semantic/"
      : `./semantic/${id}/`;
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

  // Create initial snapshot after generation
  try {
    const { createSnapshot } = await import("../../lib/migrate");
    const semanticRoot = orgId
      ? path.join(SEMANTIC_DIR, ".orgs", orgId)
      : id === "default"
        ? SEMANTIC_DIR
        : path.join(SEMANTIC_DIR, id);
    const entry = createSnapshot(semanticRoot, {
      message: `Initial snapshot from atlas init${demoDataset ? ` (demo: ${demoDataset})` : ""}`,
      trigger: "init",
    });
    if (entry) {
      console.log(pc.dim(`  Snapshot ${entry.hash} created for version tracking. Run 'atlas migrate log' to view history.\n`));
    }
  } catch (err) {
    console.warn(`Warning: Could not create initial snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Missing datasource URL error ---

export function exitMissingDatasourceUrl(): never {
  console.error("Error: ATLAS_DATASOURCE_URL is required for atlas init.");
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
    "  DuckDB:      ATLAS_DATASOURCE_URL=duckdb://path/to/file.duckdb",
  );
  console.error(
    "  CSV/Parquet: Use --csv or --parquet flags (no database required)",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main init handler
// ---------------------------------------------------------------------------

export async function handleInit(args: string[]): Promise<void> {
  const tablesArg = getFlag(args, "--tables");
  const filterTables = tablesArg ? tablesArg.split(",") : undefined;
  const cliSchema =
    getFlag(args, "--schema") ?? process.env.ATLAS_SCHEMA;
  const sourceArg = requireFlagIdentifier(
    args,
    "--source",
    "source name",
  );
  const connectionArg = requireFlagIdentifier(
    args,
    "--connection",
    "connection name",
  );
  const demoDataset = parseDemoArg(args);
  const forceInit = args.includes("--force");
  const csvArg = getFlag(args, "--csv");
  const parquetArg = getFlag(args, "--parquet");
  const hasDocumentFiles = !!(csvArg || parquetArg);

  // Validate schema name if provided
  if (cliSchema) validateSchemaName(cliSchema);

  // --connection and --source are mutually exclusive
  if (connectionArg && sourceArg) {
    console.error(
      "Error: --connection and --source are mutually exclusive.",
    );
    console.error(
      "  --connection profiles a named datasource from atlas.config.ts",
    );
    console.error(
      "  --source is the legacy flag for per-source output directory",
    );
    process.exit(1);
  }

  // Warn if --demo is combined with --connection (seeds into config-sourced URL)
  if (connectionArg && demoDataset) {
    console.warn(
      `Warning: --demo will seed data into the "${connectionArg}" datasource ` +
        `defined in atlas.config.ts. Ensure this is not a production database.`,
    );
  }

  // --- CSV/Parquet document source via DuckDB (early-exit path) ---
  if (hasDocumentFiles) {
    const files: { path: string; format: "csv" | "parquet" }[] = [];
    if (csvArg) {
      for (const f of csvArg.split(","))
        files.push({ path: f.trim(), format: "csv" });
    }
    if (parquetArg) {
      for (const f of parquetArg.split(","))
        files.push({ path: f.trim(), format: "parquet" });
    }

    // Compute output directories
    const outputBase = sourceArg
      ? path.join(SEMANTIC_DIR, sourceArg)
      : SEMANTIC_DIR;
    const entitiesOutDir = path.join(outputBase, "entities");
    const metricsOutDir = path.join(outputBase, "metrics");
    const dbPath = path.join(outputBase, ".atlas.duckdb");

    console.log(
      `\nAtlas Init — loading document files via DuckDB...\n`,
    );

    // Ingest files
    const tableNames = await ingestIntoDuckDB(dbPath, files);
    console.log(
      `\nIngested ${tableNames.length} file(s) into ${dbPath}\n`,
    );

    // Profile the DuckDB database
    console.log("Profiling DuckDB tables...\n");
    const duckFilterTables = filterTables ?? tableNames;
    const duckProgress = createProgressTracker();
    const duckStart = Date.now();
    const duckResult = await profileDuckDB(
      dbPath,
      duckFilterTables,
      undefined,
      duckProgress,
    );
    let { profiles } = duckResult;
    duckProgress.onComplete(profiles.length, Date.now() - duckStart);

    if (profiles.length === 0) {
      console.error("\nError: No tables were successfully profiled.");
      process.exit(1);
    }

    // Warn about any profiling errors
    if (duckResult.errors.length > 0) {
      const total = profiles.length + duckResult.errors.length;
      logProfilingErrors(duckResult.errors, total);
      const { shouldAbort } = checkFailureThreshold(
        duckResult,
        forceInit,
      );
      if (shouldAbort) {
        console.error(`\nUse \`--force\` to continue anyway.`);
        process.exit(1);
      }
      console.warn(
        `Continuing with ${profiles.length} successfully profiled tables.\n`,
      );
    }

    // Run profiler heuristics
    profiles = analyzeTableProfiles(profiles);

    console.log(`\nFound ${profiles.length} table(s):\n`);
    for (const p of profiles) {
      console.log(
        `  ${p.table_name} — ${p.row_count.toLocaleString()} rows, ${p.columns.length} cols`,
      );
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
      const filePath = path.join(
        entitiesOutDir,
        `${profile.table_name}.yml`,
      );
      fs.writeFileSync(
        filePath,
        generateEntityYAML(
          profile,
          profiles,
          "duckdb" as DBType,
          duckSchema,
          sourceArg,
        ),
      );
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
        const filePath = path.join(
          metricsOutDir,
          `${profile.table_name}.yml`,
        );
        fs.writeFileSync(filePath, metricYaml);
        console.log(`  wrote ${filePath}`);
      }
    }

    const duckDbUrl = `duckdb://${dbPath}`;
    const relativeOutput = sourceArg
      ? `./semantic/${sourceArg}/`
      : "./semantic/";
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
  const providerConfigured =
    hasApiKey && !!process.env.ATLAS_PROVIDER;
  let shouldEnrich: boolean;
  if (explicitEnrich) {
    shouldEnrich = true;
  } else if (explicitNoEnrich) {
    shouldEnrich = false;
  } else if (providerConfigured && process.stdin.isTTY) {
    p.log.info(
      `LLM enrichment adds richer descriptions, query patterns, and business context ` +
        `to your semantic layer using ${pc.cyan(process.env.ATLAS_PROVIDER ?? "anthropic")}.`,
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
    orgId =
      getFlag(args, "--org") ?? process.env.ATLAS_ORG_ID;
    if (orgId) {
      console.log(
        `Org-scoped mode: writing to semantic/.orgs/${orgId}/\n`,
      );
    }
  }

  // --- Resolve datasource list ---

  // Try loading atlas.config.ts
  let configDatasources: Record<
    string,
    { url: string; schema?: string; description?: string }
  > | null = null;
  if (connectionArg || !sourceArg) {
    try {
      const { loadConfig } = await import("@atlas/api/lib/config");
      const config = await loadConfig();
      if (
        config.source === "file" &&
        Object.keys(config.datasources).length > 0
      ) {
        configDatasources = config.datasources;
      }
    } catch (err) {
      // loadConfig() returns source:"env" when no file exists (no throw).
      // Errors here mean a broken config file — do not silently ignore.
      if (connectionArg) {
        console.error(
          `Error: Failed to load atlas.config.ts: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      console.warn(
        `Warning: atlas.config.ts found but failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn(
        "Falling back to ATLAS_DATASOURCE_URL environment variable.\n",
      );
    }
  }

  let datasources: DatasourceEntry[];

  if (connectionArg) {
    // --connection <name>: single datasource from config
    if (!configDatasources) {
      console.error(
        "Error: --connection requires an atlas.config.ts with datasources defined.",
      );
      process.exit(1);
    }
    const ds = configDatasources[connectionArg];
    if (!ds) {
      const available = Object.keys(configDatasources).join(", ");
      console.error(
        `Error: Datasource "${connectionArg}" not found in atlas.config.ts.`,
      );
      console.error(`  Available: ${available}`);
      process.exit(1);
    }
    datasources = [
      {
        id: connectionArg,
        url: ds.url,
        schema: cliSchema ?? ds.schema ?? "public",
      },
    ];
  } else if (sourceArg) {
    // Legacy --source flag: single datasource from env var, output to semantic/{source}/
    const connStr = process.env.ATLAS_DATASOURCE_URL;
    if (!connStr) exitMissingDatasourceUrl();
    // Warn if --source and --demo are used together
    if (demoDataset) {
      console.warn(
        `Warning: --demo seeds data into the database at ATLAS_DATASOURCE_URL, ` +
          `but --source "${sourceArg}" writes entities with connection: "${sourceArg}". ` +
          `Ensure the "${sourceArg}" connection is registered to the same database at runtime.`,
      );
    }
    datasources = [
      {
        id: sourceArg,
        url: connStr,
        schema: cliSchema ?? "public",
      },
    ];
  } else if (
    configDatasources &&
    Object.keys(configDatasources).length > 0
  ) {
    // Config with N datasources — interactive picker in TTY, or all
    const allEntries = Object.entries(configDatasources).map(
      ([id, ds]) => {
        validateIdentifier(id, "datasource name");
        return {
          id,
          url: ds.url,
          schema: cliSchema ?? ds.schema ?? "public",
        };
      },
    );

    if (allEntries.length > 1 && process.stdin.isTTY) {
      const selected = await p.multiselect({
        message: `Select datasources to profile (${allEntries.length} found in atlas.config.ts)`,
        options: allEntries.map((ds) => {
          let dbLabel: string;
          try {
            dbLabel = detectDBType(ds.url);
          } catch (err) {
            dbLabel = "unknown";
            console.warn(
              `  Warning: Cannot detect DB type for "${ds.id}": ${err instanceof Error ? err.message : String(err)}`,
            );
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
      datasources = allEntries.filter((ds) =>
        selectedIds.has(ds.id),
      );

      if (datasources.length === 0) {
        p.cancel("No datasources selected.");
        process.exit(1);
      }
    } else {
      datasources = allEntries;
    }

    // --demo restricted to single-datasource when using config
    if (demoDataset && datasources.length > 1) {
      console.error(
        "Error: --demo cannot be used with multiple datasources. Use --connection to target a single datasource.",
      );
      process.exit(1);
    }
  } else {
    // No config -- fall back to ATLAS_DATASOURCE_URL (backward-compatible single-source behavior)
    const connStr = process.env.ATLAS_DATASOURCE_URL;
    if (!connStr) exitMissingDatasourceUrl();
    datasources = [
      {
        id: "default",
        url: connStr,
        schema: cliSchema ?? "public",
      },
    ];
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
        console.error(
          `\nError detecting DB type for "${ds.id}": ${msg}`,
        );
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
        console.error(
          `\nFailed to profile datasource "${ds.id}": ${msg}\n`,
        );
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

    const apiUrl =
      process.env.ATLAS_API_URL ?? "http://localhost:3001";
    const importUrl = `${apiUrl}/api/v1/admin/semantic/org/import`;
    const importHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (process.env.ATLAS_API_KEY)
      importHeaders.Authorization = `Bearer ${process.env.ATLAS_API_KEY}`;

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
          const result = (await resp.json()) as {
            imported: number;
            skipped: number;
            total: number;
          };
          console.log(
            `  Imported ${result.imported} entities${ds.id !== "default" ? ` (connection: ${ds.id})` : ""}`,
          );
          if (result.imported > 0) anyImported = true;
        } else {
          let errorMsg = `HTTP ${resp.status}`;
          try {
            const json = (await resp.json()) as {
              message?: string;
              error?: string;
            };
            errorMsg =
              json.message ?? json.error ?? errorMsg;
          } catch {
            // intentionally ignored: JSON parse failed, fall through to text() attempt
            errorMsg = await resp
              .text()
              .catch(() => errorMsg);
          }
          console.warn(
            `  Warning: Import failed for ${ds.id}: ${errorMsg}`,
          );
          console.warn(
            "  Run 'atlas import' later to retry.\n",
          );
        }
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : String(err);
        if (
          detail.includes("ECONNREFUSED") ||
          detail.includes("fetch failed")
        ) {
          console.warn(
            "  Warning: Atlas API not reachable — skipping auto-import.",
          );
          console.warn(
            "  Set ATLAS_API_URL if the API is not on localhost:3001",
          );
          console.warn(
            "  Start the API server and run 'atlas import' to import manually.\n",
          );
          break; // Don't try remaining datasources
        }
        console.warn(
          `  Warning: Import failed for ${ds.id}: ${detail}`,
        );
      }
    }

    if (!anyImported && datasources.length > 0) {
      console.warn(
        "\nNo entities were imported to the DB. Files were written to disk successfully.",
      );
      console.warn(
        "Run 'atlas import' once the API server is available to complete the import.",
      );
      if (!process.env.ATLAS_API_KEY) {
        console.warn(
          "Hint: set ATLAS_API_KEY for CLI authentication.\n",
        );
      }
    }
  }
}
