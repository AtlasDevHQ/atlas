/**
 * CLI help system — overview help, per-subcommand help, and help detection.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubcommandHelp {
  description: string;
  usage: string;
  flags?: Array<{ flag: string; description: string }>;
  subcommands?: Array<{ name: string; description: string }>;
  examples?: string[];
}

// ---------------------------------------------------------------------------
// Help printer
// ---------------------------------------------------------------------------

export function printSubcommandHelp(help: SubcommandHelp): void {
  console.log(`${help.description}\n`);
  console.log(`Usage: atlas ${help.usage}\n`);
  if (help.subcommands?.length) {
    console.log("Subcommands:");
    const maxLen = Math.max(
      ...help.subcommands.map((s) => s.name.length),
    );
    for (const s of help.subcommands) {
      console.log(
        `  ${s.name.padEnd(maxLen + 2)}${s.description}`,
      );
    }
    console.log();
  }
  if (help.flags?.length) {
    console.log("Options:");
    const maxLen = Math.max(
      ...help.flags.map((f) => f.flag.length),
    );
    for (const f of help.flags) {
      console.log(
        `  ${f.flag.padEnd(maxLen + 2)}${f.description}`,
      );
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

// ---------------------------------------------------------------------------
// Subcommand help definitions
// ---------------------------------------------------------------------------

export const SUBCOMMAND_HELP: Record<string, SubcommandHelp> = {
  init: {
    description:
      "Profile a database and generate semantic layer YAML files.",
    usage: "init [options]",
    flags: [
      {
        flag: "--tables <t1,t2>",
        description:
          "Profile only specific tables/views (comma-separated)",
      },
      {
        flag: "--schema <name>",
        description: "PostgreSQL schema name (default: public)",
      },
      {
        flag: "--source <name>",
        description:
          "Write to semantic/{name}/ subdirectory (mutually exclusive with --connection)",
      },
      {
        flag: "--connection <name>",
        description:
          "Profile a named datasource from atlas.config.ts (mutually exclusive with --source)",
      },
      {
        flag: "--csv <file1.csv,...>",
        description:
          "Load CSV files via DuckDB (no DB server needed, requires @duckdb/node-api)",
      },
      {
        flag: "--parquet <f1.parquet,...>",
        description:
          "Load Parquet files via DuckDB (requires @duckdb/node-api)",
      },
      {
        flag: "--enrich",
        description:
          "Add LLM-enriched descriptions and query patterns (requires API key)",
      },
      {
        flag: "--no-enrich",
        description: "Explicitly skip LLM enrichment",
      },
      {
        flag: "--force",
        description:
          "Continue even if more than 20% of tables fail to profile",
      },
      {
        flag: "--demo [simple|cybersec|ecommerce]",
        description:
          "Load a demo dataset then profile (default: simple)",
      },
      {
        flag: "--org <orgId>",
        description:
          "Write to semantic/.orgs/{orgId}/ and auto-import to DB (org-scoped mode)",
      },
      {
        flag: "--no-import",
        description:
          "Skip auto-import to DB in org-scoped mode (write disk only)",
      },
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
    description:
      "Compare the database schema against the existing semantic layer. Exits with code 1 if drift is detected.",
    usage: "diff [options]",
    flags: [
      {
        flag: "--tables <t1,t2>",
        description: "Diff only specific tables/views",
      },
      {
        flag: "--schema <name>",
        description:
          "PostgreSQL schema (falls back to ATLAS_SCHEMA, then public)",
      },
      {
        flag: "--source <name>",
        description: "Read from semantic/{name}/ subdirectory",
      },
    ],
    examples: [
      "atlas diff",
      "atlas diff --tables users,orders",
      'atlas diff || echo "Schema drift detected!"',
    ],
  },
  query: {
    description:
      "Ask a natural language question and get an answer. Requires a running Atlas API server.",
    usage: 'query "your question" [options]',
    flags: [
      {
        flag: "--json",
        description: "Raw JSON output (pipe-friendly)",
      },
      {
        flag: "--csv",
        description: "CSV output (headers + rows, no narrative)",
      },
      {
        flag: "--quiet",
        description: "Data only — no narrative, SQL, or stats",
      },
      {
        flag: "--auto-approve",
        description: "Auto-approve any pending actions",
      },
      {
        flag: "--connection <id>",
        description: "Query a specific datasource",
      },
    ],
    examples: [
      'atlas query "How many users signed up last month?"',
      'atlas query "top 10 customers by revenue" --json',
      'atlas query "monthly revenue by product" --csv > report.csv',
    ],
  },
  doctor: {
    description:
      "Alias for 'atlas validate' — validate config, semantic layer, and connectivity.",
    usage: "doctor",
    examples: ["atlas doctor"],
  },
  validate: {
    description:
      "Validate config, semantic layer, and connectivity. Use --offline to skip connectivity checks.",
    usage: "validate [options]",
    flags: [
      {
        flag: "--offline",
        description:
          "Skip connectivity checks (datasource, provider, internal DB)",
      },
    ],
    examples: ["atlas validate", "atlas validate --offline"],
  },
  mcp: {
    description:
      "Start an MCP (Model Context Protocol) server for Claude Desktop, Cursor, and other MCP clients.",
    usage: "mcp [options]",
    flags: [
      {
        flag: "--transport <stdio|sse>",
        description: "Transport type (default: stdio)",
      },
      {
        flag: "--port <n>",
        description: "Port for SSE transport (default: 8080)",
      },
    ],
    examples: [
      "atlas mcp",
      "atlas mcp --transport sse --port 9090",
    ],
  },
  import: {
    description:
      "Import semantic layer YAML files from disk into the internal DB for the active org.",
    usage: "import [options]",
    flags: [
      {
        flag: "--connection <name>",
        description:
          "Associate imported entities with a named datasource",
      },
    ],
    examples: [
      "atlas import",
      "atlas import --connection warehouse",
    ],
  },
  index: {
    description:
      "Rebuild the semantic index from current YAML files, or print index statistics.",
    usage: "index [options]",
    flags: [
      {
        flag: "--stats",
        description:
          "Print current index statistics without rebuilding",
      },
    ],
    examples: ["atlas index", "atlas index --stats"],
  },
  learn: {
    description:
      "Analyze audit log and propose semantic layer YAML improvements.",
    usage: "learn [options]",
    flags: [
      {
        flag: "--apply",
        description:
          "Write proposed changes to YAML files (default: dry-run)",
      },
      {
        flag: "--suggestions",
        description:
          "Generate query suggestions from the audit log (stored in the query_suggestions table). Can be combined with --apply, --since, --limit, and --source",
      },
      {
        flag: "--auto-approve",
        description:
          "With --suggestions: skip the /admin/starter-prompts moderation queue and write new rows as approved+published. Requires explicit operator intent — default is pending/draft",
      },
      {
        flag: "--limit <n>",
        description:
          "Max audit log entries to analyze (default: 1000)",
      },
      {
        flag: "--since <date>",
        description:
          "Only analyze queries after this date (ISO 8601)",
      },
      {
        flag: "--source <name>",
        description:
          "Read from/write to semantic/{name}/ subdirectory",
      },
    ],
    examples: [
      "atlas learn",
      "atlas learn --apply",
      "atlas learn --since 2026-03-01 --limit 500",
      "atlas learn --source warehouse",
      "atlas learn --suggestions --auto-approve",
    ],
  },
  improve: {
    description:
      "Analyze the semantic layer and propose data-driven improvements using database profiling and audit log patterns.",
    usage: "improve [options]",
    flags: [
      {
        flag: "-i, --interactive",
        description:
          "Start interactive conversation mode (review proposals one at a time)",
      },
      {
        flag: "--apply",
        description:
          "Write proposed changes to YAML files (default: dry-run)",
      },
      {
        flag: "--min-confidence <n>",
        description:
          "Minimum confidence to include (0–1, default: 0.5)",
      },
      {
        flag: "--entities <t1,t2>",
        description: "Limit analysis to specific entities (comma-separated)",
      },
      {
        flag: "--since <date>",
        description:
          "Only analyze audit log entries after this date (ISO 8601)",
      },
      {
        flag: "--source <name>",
        description:
          "Read from/write to semantic/{name}/ subdirectory",
      },
      {
        flag: "--schema <name>",
        description: "PostgreSQL schema name (default: public)",
      },
    ],
    examples: [
      "atlas improve",
      "atlas improve -i",
      "atlas improve --apply",
      "atlas improve --min-confidence 0.7 --entities orders,users",
      "atlas improve --since 2026-03-01 --source warehouse",
    ],
  },
  export: {
    description:
      "Export workspace data to a portable migration bundle (JSON). Reads from the internal database.",
    usage: "export [options]",
    flags: [
      {
        flag: "--output <path>",
        description:
          "Output file path (default: ./atlas-export-{date}.json)",
      },
      { flag: "-o <path>", description: "Alias for --output" },
      {
        flag: "--org <orgId>",
        description:
          "Export data for a specific org (default: global/unscoped)",
      },
    ],
    examples: [
      "atlas export",
      "atlas export --output backup.json",
      "atlas export --org org_abc123",
    ],
  },
  "migrate-import": {
    description:
      "Import an export bundle into a hosted Atlas instance. Used for self-hosted → SaaS migration.",
    usage: "migrate-import --bundle <path> [options]",
    flags: [
      {
        flag: "--bundle <path>",
        description:
          "Path to the export bundle JSON file (required)",
      },
      {
        flag: "--target <url>",
        description:
          "Target Atlas API URL (default: https://app.useatlas.dev)",
      },
      {
        flag: "--api-key <key>",
        description:
          "API key for the target workspace (or set ATLAS_API_KEY)",
      },
    ],
    examples: [
      "atlas migrate-import --bundle atlas-export-2026-04-02.json",
      "atlas migrate-import --bundle backup.json --target https://atlas.internal.company.com",
      "ATLAS_API_KEY=sk-... atlas migrate-import --bundle backup.json",
    ],
  },
  migrate: {
    description:
      "Semantic layer versioning — track changes, create snapshots, diff, and rollback.",
    usage: "migrate <subcommand> [options]",
    subcommands: [
      {
        name: "status",
        description:
          "Show current semantic layer state vs last snapshot",
      },
      {
        name: "snapshot",
        description:
          "Capture current state as a versioned snapshot",
      },
      {
        name: "diff",
        description:
          "Show unified diff between current state and a snapshot",
      },
      {
        name: "log",
        description: "Show history of snapshots",
      },
      {
        name: "rollback <hash>",
        description:
          "Restore semantic layer to a previous snapshot",
      },
    ],
    flags: [
      {
        flag: "-m, --message <text>",
        description: "Message for the snapshot (used with snapshot)",
      },
      {
        flag: "--force",
        description:
          "Create snapshot even if nothing changed (used with snapshot)",
      },
      {
        flag: "--from <hash>",
        description:
          "Source snapshot hash for diff comparison",
      },
      {
        flag: "--to <hash>",
        description:
          "Target snapshot hash for diff comparison",
      },
      {
        flag: "--source <name>",
        description: "Use semantic/{name}/ subdirectory",
      },
      {
        flag: "--limit <n>",
        description: "Max entries to show in log (default: 20)",
      },
    ],
    examples: [
      "atlas migrate status",
      'atlas migrate snapshot -m "Added order metrics"',
      "atlas migrate diff",
      "atlas migrate diff --from abc123 --to def456",
      "atlas migrate log",
      "atlas migrate rollback abc123",
    ],
  },
  plugin: {
    description: "Manage Atlas plugins.",
    usage: "plugin <list|create|add>",
    subcommands: [
      {
        name: "list",
        description:
          "List installed plugins from atlas.config.ts",
      },
      {
        name: "create <name> --type <type>",
        description:
          "Scaffold a new plugin (datasource|context|interaction|action|sandbox)",
      },
      {
        name: "add <package-name>",
        description: "Install a plugin package",
      },
    ],
    examples: [
      "atlas plugin list",
      "atlas plugin create my-plugin --type datasource",
      "atlas plugin add @useatlas/plugin-bigquery",
    ],
  },
  eval: {
    description:
      "Run the evaluation pipeline against demo schemas to measure text-to-SQL accuracy.",
    usage: "eval [options]",
    flags: [
      {
        flag: "--schema <name>",
        description:
          "Filter by demo dataset (not a PostgreSQL schema; e.g. simple, cybersec, ecommerce)",
      },
      {
        flag: "--category <name>",
        description: "Filter by category",
      },
      {
        flag: "--difficulty <level>",
        description:
          "Filter by difficulty (simple|medium|complex)",
      },
      {
        flag: "--id <case-id>",
        description: "Run a single case",
      },
      {
        flag: "--limit <n>",
        description: "Max cases to evaluate",
      },
      {
        flag: "--resume <file>",
        description: "Resume from existing JSONL results file",
      },
      {
        flag: "--baseline",
        description: "Save results as new baseline",
      },
      {
        flag: "--compare <file.jsonl>",
        description:
          "Diff against baseline (exit 1 on regression)",
      },
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
    description:
      "Run end-to-end smoke tests against a running Atlas deployment.",
    usage: "smoke [options]",
    flags: [
      {
        flag: "--target <url>",
        description:
          "API base URL (default: http://localhost:3001)",
      },
      {
        flag: "--api-key <key>",
        description: "Bearer auth token",
      },
      {
        flag: "--timeout <ms>",
        description: "Per-check timeout (default: 30000)",
      },
      {
        flag: "--verbose",
        description: "Show full response bodies on failure",
      },
      {
        flag: "--json",
        description: "Machine-readable JSON output",
      },
    ],
    examples: [
      "atlas smoke",
      "atlas smoke --target https://api.example.com --api-key sk-...",
    ],
  },
  benchmark: {
    description:
      "Run the BIRD benchmark for text-to-SQL accuracy evaluation.",
    usage: "benchmark [options]",
    flags: [
      {
        flag: "--bird-path <path>",
        description:
          "Path to the downloaded BIRD dev directory (required)",
      },
      {
        flag: "--limit <n>",
        description: "Max questions to evaluate",
      },
      {
        flag: "--db <name>",
        description: "Filter to a single database",
      },
      { flag: "--csv", description: "CSV output" },
      {
        flag: "--resume <file>",
        description: "Resume from existing JSONL results file",
      },
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

// ---------------------------------------------------------------------------
// Overview help
// ---------------------------------------------------------------------------

export function printOverviewHelp(): void {
  console.log(
    "Atlas CLI — profile databases, generate semantic layers, and query your data.\n\n" +
      "Usage: atlas <command> [options]\n\n" +
      "Commands:\n" +
      "  init             Profile DB and generate semantic layer\n" +
      "  import           Import semantic YAML files from disk into DB\n" +
      "  export           Export workspace data to a migration bundle\n" +
      "  migrate-import   Import a migration bundle into a hosted instance\n" +
      "  index            Rebuild or inspect the semantic index\n" +
      "  learn            Analyze audit log and propose YAML improvements\n" +
      "  improve          Analyze semantic layer and propose data-driven improvements\n" +
      "  diff             Compare DB schema against existing semantic layer\n" +
      "  query            Ask a question via the Atlas API\n" +
      "  validate         Validate config, semantic layer, and connectivity\n" +
      "  doctor           Alias for validate\n" +
      "  eval             Run eval pipeline against demo schemas\n" +
      "  smoke            Run E2E smoke tests against a running Atlas deployment\n" +
      "  migrate          Semantic layer versioning (snapshot, diff, rollback)\n" +
      "  plugin           Manage plugins (list, create, add)\n" +
      "  benchmark        Run BIRD benchmark for text-to-SQL accuracy\n" +
      "  mcp              Start MCP server (stdio or SSE transport)\n" +
      "  completions      Output shell completion script (bash, zsh, fish)\n\n" +
      "Run atlas <command> --help for detailed usage of any command.",
  );
}

// ---------------------------------------------------------------------------
// Help detection
// ---------------------------------------------------------------------------

/** Check if args contain --help or -h for a subcommand. */
export function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
