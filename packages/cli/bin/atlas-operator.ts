#!/usr/bin/env tsx
/**
 * Atlas operator CLI — internal, operator-only tooling that touches tenant data
 * directly (no API, no gate chain).
 *
 * Split out of the published `atlas` CLI so the workspace-facing binary never
 * ships tenant-destructive direct-DB tooling (ADR-0025 sub-decision 1 /
 * sequencing step 4, #4045). Behavior and gates are unchanged from when these
 * subcommands lived under `atlas` — this is packaging only.
 *
 * Usage:
 *   bun run atlas-operator -- ops wipe --confirm
 *   bun run atlas-operator -- ops backfill-crm-leads --dry-run
 *   bun run atlas-operator -- ops smoke-crm --personas ./fixtures/personas.yml
 *   bun run atlas-operator -- seed prompts --workspace <id|slug> --library ./prompts/library.yml
 *   bun run atlas-operator -- proactive enable --workspace <id|slug> --channels <c1,c2>
 *   bun run atlas-operator -- export --output backup.json
 *   bun run atlas-operator -- learn --apply
 *
 * The tenant-data subcommands (ops, seed, proactive) target the tenant Postgres
 * at ATLAS_TEAM_PG_URL (falling back to DATABASE_URL); export and learn instead
 * read Atlas's internal DB via DATABASE_URL (the two-database split). All
 * preserve their existing gates (ATLAS_WIPE_OK, --confirm, ATLAS_SMOKE_WIPE_OK,
 * ATLAS_TEARDOWN_OK, …).
 */

import {
  OPERATOR_SUBCOMMAND_HELP,
  printOperatorOverviewHelp,
  type OperatorCommand,
} from "../lib/operator-help";
import { printSubcommandHelp, wantsHelp } from "../lib/help";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Top-level help: atlas-operator --help, -h, or no command
  if (!command || command === "--help" || command === "-h") {
    printOperatorOverviewHelp();
    process.exit(0);
  }

  // Per-subcommand --help. `Object.hasOwn` (not `in`) so inherited prototype
  // keys like `toString` aren't mistaken for commands; it confirms `command` is
  // a real own key, which makes the narrowing cast sound (OPERATOR_SUBCOMMAND_HELP
  // is keyed by the literal OperatorCommand union, which a raw `string` can't index).
  if (wantsHelp(args) && Object.hasOwn(OPERATOR_SUBCOMMAND_HELP, command)) {
    printSubcommandHelp(
      OPERATOR_SUBCOMMAND_HELP[command as OperatorCommand],
      "atlas-operator",
    );
    process.exit(0);
  }

  if (command === "ops") {
    const { handleOps } = await import("../src/commands/operator/ops");
    return handleOps(args);
  }

  if (command === "seed") {
    const { handleSeed } = await import("../src/commands/operator/seed");
    return handleSeed(args);
  }

  if (command === "proactive") {
    const { handleProactive } = await import(
      "../src/commands/operator/proactive"
    );
    return handleProactive(args);
  }

  if (command === "export") {
    const { handleExport } = await import("../src/commands/operator/export");
    return handleExport(args);
  }

  if (command === "learn") {
    const { handleLearn } = await import("../src/commands/operator/learn");
    return handleLearn(args);
  }

  console.error(`Unknown operator command: ${command}\n`);
  printOperatorOverviewHelp();
  process.exit(1);
}

// Only run the CLI when this file is the entry point (not when imported by tests)
const isEntryPoint =
  (typeof Bun !== "undefined" && Bun.main === import.meta.path) ||
  typeof Bun === "undefined"; // tsx / node fallback

if (isEntryPoint) {
  main().catch((err) => {
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  });
}
