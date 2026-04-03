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
 * Supports PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, and Salesforce.
 */

import { checkEnvFile } from "../src/env-check";
import {
  SUBCOMMAND_HELP,
  printSubcommandHelp,
  printOverviewHelp,
  wantsHelp,
} from "../lib/help";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility (tests import from "../atlas")
// ---------------------------------------------------------------------------

// Re-export from shared profiler
export {
  type ColumnProfile,
  type TableProfile,
  type ProfileError,
  type ProfilingResult,
  FATAL_ERROR_PATTERN,
  isFatalConnectionError,
  checkFailureThreshold,
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
  mapSQLType,
  isView,
  isMatView,
  isViewLike,
  entityName,
  outputDirForDatasource,
  inferForeignKeys,
  detectAbandonedTables,
  detectEnumInconsistency,
  detectDenormalizedTables,
  analyzeTableProfiles,
  pluralize,
  singularize,
} from "@atlas/api/lib/profiler";

// Re-export extracted utilities
export {
  cliProfileLogger,
  detectDBType,
  getFlag,
  logProfilingErrors,
  requireFlagIdentifier,
  validateIdentifier,
  validateSchemaName,
  SEMANTIC_DIR,
  ENTITIES_DIR,
} from "../lib/cli-utils";
export {
  formatCellValue,
  formatCsvValue,
  quoteCsvField,
  renderTable,
} from "../lib/output";
export { testDatabaseConnection } from "../lib/test-connection";

// Re-export DB helpers
export {
  rewriteClickHouseUrl,
  clickhouseQuery,
  snowflakeQuery,
  createSnowflakePool,
  loadDuckDB,
} from "../lib/test-connection";

// Re-export profilers
export {
  type ClickHouseClient,
  listClickHouseObjects,
  profileClickHouse,
  type SnowflakePool,
  listSnowflakeObjects,
  profileSnowflake,
  listSalesforceObjects,
  profileSalesforce,
  ingestIntoDuckDB,
  listDuckDBObjects,
  profileDuckDB,
} from "../lib/profilers";

// Re-export diff logic
export {
  type EntitySnapshot,
  type TableDiff,
  type DiffResult,
  parseEntityYAML,
  profileToSnapshot,
  computeDiff,
  formatDiff,
} from "../lib/diff";

// Re-export plugin commands
export {
  type ScaffoldPluginType,
  handlePluginList,
  pluginTemplate,
  pluginTestTemplate,
  pluginPackageJsonTemplate,
  pluginTsconfigTemplate,
  handlePluginCreate,
  handlePluginAdd,
} from "../src/commands/plugin";

// Re-export init/demo commands
export {
  type DemoDataset,
  DEMO_DATASETS,
  parseDemoArg,
  seedDemoPostgres,
  handleIndex,
  exitMissingDatasourceUrl,
} from "../src/commands/init";

// Re-export migrate command
export { handleMigrate } from "../src/commands/migrate";

// Re-export help system
export {
  type SubcommandHelp,
  printSubcommandHelp,
  SUBCOMMAND_HELP,
  printOverviewHelp,
  wantsHelp,
} from "../lib/help";

// Re-export handleActionApproval from extracted query module
export { handleActionApproval } from "../src/commands/query";

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
    const { handleQuery } = await import("../src/commands/query");
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
    const { handleIndex } = await import("../src/commands/init");
    return handleIndex(args);
  }

  if (command === "learn") {
    const { handleLearn } = await import("../src/commands/learn");
    return handleLearn(args);
  }

  if (command === "diff") {
    const { handleDiff } = await import("../src/commands/diff");
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
      console.error(
        `[atlas] Unknown transport: "${transportFlag}". Use "stdio" or "sse".`,
      );
      process.exit(1);
    }

    if (
      transportFlag === "sse" &&
      (isNaN(portFlag) || portFlag <= 0)
    ) {
      console.error(
        `[atlas] Invalid port for SSE transport. Must be a positive integer.`,
      );
      process.exit(1);
    }

    try {
      const { createAtlasMcpServer } = await import(
        "@atlas/mcp/server"
      );

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
            console.error(
              `[atlas] Error closing SSE server: ${err instanceof Error ? err.message : String(err)}`,
            );
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
      const detail =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[atlas] Failed to start MCP server: ${detail}`,
      );
      process.exit(1);
    }
    return;
  }

  if (command === "export") {
    const { handleExport } = await import("../src/commands/export");
    return handleExport(args);
  }

  if (command === "import") {
    const { handleImport } = await import("../src/commands/import");
    return handleImport(args);
  }

  if (command === "migrate-import") {
    const { handleMigrateImport } = await import(
      "../src/commands/migrate-import"
    );
    return handleMigrateImport(args);
  }

  if (command === "migrate") {
    const { handleMigrate } = await import(
      "../src/commands/migrate"
    );
    return handleMigrate(args);
  }

  if (command === "plugin") {
    const { handlePlugin } = await import(
      "../src/commands/plugin"
    );
    return handlePlugin(args);
  }

  if (command !== "init") {
    console.error(`Unknown command: ${command}\n`);
    printOverviewHelp();
    process.exit(1);
  }

  // init is the default/fallback command
  const { handleInit } = await import("../src/commands/init");
  return handleInit(args);
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
      console.error(
        err instanceof Error ? err.message : String(err),
      );
    }
    process.exit(1);
  });
}
