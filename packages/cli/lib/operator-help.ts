/**
 * Help system for the operator CLI (`atlas-operator`).
 *
 * The operator subcommands (`ops`, `seed`, `proactive`, `export`, `learn`) are
 * internal, operator-only, direct-DB tooling. They were split out of the
 * published `atlas` CLI so the workspace-facing binary never ships
 * tenant-destructive direct-DB tooling (ADR-0025 sub-decision 1 / sequencing
 * step 4, #4045). These help entries live here — NOT in `help.ts` — so the
 * published CLI's help never advertises operator commands.
 *
 * Rendering reuses `printSubcommandHelp` from `help.ts` with the `atlas-operator`
 * bin name so the printed `Usage:` line and the published-CLI help stay one code
 * path.
 */

import type { SubcommandHelp } from "./help";

/**
 * The operator-only subcommands, owned exclusively by `bin/atlas-operator.ts`.
 * Single source of truth for the command names — `OPERATOR_SUBCOMMAND_HELP` is
 * `satisfies Record<OperatorCommand, …>`, so a name added here without a matching
 * help entry (or vice-versa) is a compile error.
 */
export const OPERATOR_COMMAND_NAMES = [
  "ops",
  "seed",
  "proactive",
  "export",
  "learn",
] as const;

export type OperatorCommand = (typeof OPERATOR_COMMAND_NAMES)[number];

/** Runtime membership gate the published `atlas` CLI uses to redirect. */
export const OPERATOR_COMMANDS: ReadonlySet<string> = new Set(
  OPERATOR_COMMAND_NAMES,
);

// ---------------------------------------------------------------------------
// Subcommand help definitions (relocated from help.ts SUBCOMMAND_HELP)
// ---------------------------------------------------------------------------

export const OPERATOR_SUBCOMMAND_HELP = {
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
      "atlas-operator learn",
      "atlas-operator learn --apply",
      "atlas-operator learn --since 2026-03-01 --limit 500",
      "atlas-operator learn --source warehouse",
      "atlas-operator learn --suggestions --auto-approve",
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
      "atlas-operator export",
      "atlas-operator export --output backup.json",
      "atlas-operator export --org org_abc123",
    ],
  },
  proactive: {
    description:
      "Enable or disable proactive chat for a workspace. Operates against the tenant Postgres at ATLAS_TEAM_PG_URL (falls back to DATABASE_URL).",
    usage: "proactive <enable|disable> --workspace <id|slug> [options]",
    subcommands: [
      {
        name: "enable",
        description:
          "Turn proactive chat on for a workspace + opt one or more channels in (idempotent upsert).",
      },
      {
        name: "disable",
        description:
          "Flip workspace_proactive_config.enabled to false (channel config rows preserved).",
      },
    ],
    flags: [
      {
        flag: "--workspace <id|slug>",
        description:
          "Workspace slug (resolved via organization.slug) or literal `org_*` id",
      },
      {
        flag: "--channels <id1,id2,...>",
        description:
          "Comma-separated Slack channel ids to opt in (required for `enable`)",
      },
    ],
    examples: [
      "atlas-operator proactive enable --workspace atlas --channels C0AAA,C0BBB",
      "atlas-operator proactive disable --workspace atlas",
    ],
  },
  seed: {
    description:
      "Seed durable workspace data — starter prompt collections and connection groups. Operates against the tenant Postgres at ATLAS_TEAM_PG_URL (falls back to DATABASE_URL).",
    usage: "seed <prompts|workspace> [options]",
    subcommands: [
      {
        name: "prompts",
        description:
          "Seed a prompt-library collection + items from a YAML file into prompt_collections / prompt_items.",
      },
      {
        name: "workspace",
        description:
          "Provision a connection group with one or more member connections + per-group semantic entities.",
      },
    ],
    flags: [
      {
        flag: "--workspace <id|slug>",
        description: "Target workspace (required)",
      },
      {
        flag: "--library <path>",
        description:
          "Path to library YAML (seed prompts) — defaults to ./prompts/library.yml",
      },
      {
        flag: "--group <name>",
        description: "Connection group name (seed workspace, required)",
      },
      {
        flag: "--group-id <id>",
        description: "Connection group id (seed workspace, defaults to `g_<group>`)",
      },
      {
        flag: "--connections <id=urlEnv:type[:primary],...>",
        description:
          "Group members. Each entry: connection id, env var holding the URL, db type (postgres|mysql|…), and optional `:primary` marker. Exactly one entry must be primary.",
      },
      {
        flag: "--semantic <path>",
        description:
          "Optional path to a semantic/ directory whose entities/, metrics/, glossary/ are inserted scoped to the new group.",
      },
    ],
    examples: [
      "atlas-operator seed prompts --workspace atlas --library ./prompts/library.yml",
      "atlas-operator seed workspace --workspace atlas --group prod --connections us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres",
    ],
  },
  ops: {
    description:
      "Operator-only tools that touch tenant data. Destructive subcommands require an explicit double-confirm flag.",
    usage:
      "ops <wipe|backfill-crm-leads|smoke-crm|teardown-verify-accounts> [options]",
    subcommands: [
      {
        name: "wipe",
        description:
          "TRUNCATE every public table in the tenant DB (excluding migration bookkeeping) with RESTART IDENTITY CASCADE. Requires ATLAS_WIPE_OK=1 + --confirm. No backup is taken — wrap with pg_dump yourself.",
      },
      {
        name: "backfill-crm-leads",
        description:
          "Enqueue every existing demo_leads row into crm_outbox so the flusher dispatches them to Twenty as Persons. Re-runs are safe (dedupe by primary email). Flags: --dry-run, --batch-size N (default 500), --source demo, --database-url <url>.",
      },
      {
        name: "smoke-crm",
        description:
          "End-to-end CRM lead-capture verification — inject fixture personas below Turnstile via the outbox, wait for the flusher to drain, then diff the resulting Twenty Persons/Notes against the fixture. Makes live Twenty calls: run ad-hoc by an operator and as the post-deploy staging-smoke gate, not per-PR CI. Flags: --personas <path> (required), --wipe-twenty (requires ATLAS_SMOKE_WIPE_OK=1), --twenty-base-url <url>, --twenty-api-key <key>, --timeout-seconds N (default 60), --database-url <url>.",
      },
      {
        name: "teardown-verify-accounts",
        description:
          "Surgically delete throwaway /verify-prod-signup accounts (user + org + Stripe customer) from one region's internal DB. DRY RUN by default; EXECUTE requires ATLAS_TEARDOWN_OK=1 + --confirm. Flags: --email <addr[,addr]> (required, repeatable), --region <us|eu|apac> OR --database-url <url>, --dry-run, --force (allow non-plus-addressed emails).",
      },
    ],
    flags: [
      {
        flag: "--confirm",
        description:
          "wipe: required to proceed past the double-confirm gate. Pair with ATLAS_WIPE_OK=1 in the env.",
      },
      {
        flag: "--wipe-twenty",
        description:
          "smoke-crm: clear the Twenty workspace before the run. Destructive — double-gated by ATLAS_SMOKE_WIPE_OK=1.",
      },
      {
        flag: "--database-url <url>",
        description:
          "Override the target Postgres URL (defaults to ATLAS_TEAM_PG_URL, then DATABASE_URL).",
      },
    ],
    examples: [
      "ATLAS_WIPE_OK=1 atlas-operator ops wipe --confirm",
      "ATLAS_WIPE_OK=1 atlas-operator ops wipe --confirm --database-url $US_DB_URL",
      "atlas-operator ops backfill-crm-leads --dry-run",
      "atlas-operator ops smoke-crm --personas ./fixtures/personas.yml",
      "ATLAS_SMOKE_WIPE_OK=1 atlas-operator ops smoke-crm --personas ./fixtures/personas.yml --wipe-twenty",
    ],
  },
} satisfies Record<OperatorCommand, SubcommandHelp>;

// ---------------------------------------------------------------------------
// Overview help
// ---------------------------------------------------------------------------

export function printOperatorOverviewHelp(): void {
  console.log(
    "Atlas operator CLI — internal, operator-only tooling that touches tenant data directly.\n\n" +
      "These commands bypass the API, its gates, and the tenant boundary — they are shipped to\n" +
      "the platform operator, never to a workspace (ADR-0025, #4045). The tenant-data subcommands\n" +
      "(ops, seed, proactive) target the tenant Postgres at ATLAS_TEAM_PG_URL (falling back to\n" +
      "DATABASE_URL); export and learn read Atlas's internal DB via DATABASE_URL.\n\n" +
      "Usage: atlas-operator <command> [options]\n\n" +
      "Commands:\n" +
      "  ops              Operator-only destructive tools (wipe, backfill-crm-leads, smoke-crm, teardown-verify-accounts)\n" +
      "  seed             Seed durable workspace data — prompts, connection groups\n" +
      "  proactive        Enable/disable proactive chat for a workspace\n" +
      "  export           Export workspace data to a migration bundle\n" +
      "  learn            Analyze audit log and propose semantic YAML improvements\n\n" +
      "Run atlas-operator <command> --help for detailed usage of any command.",
  );
}
