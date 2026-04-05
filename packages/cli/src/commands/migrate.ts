/**
 * atlas migrate — Semantic layer versioning and migration tracking.
 *
 * Subcommands:
 *   status   — show current state vs last snapshot
 *   snapshot — capture current state as a versioned snapshot
 *   diff     — show unified diff between current state and a snapshot
 *   log      — show history of snapshots
 *   rollback — restore semantic layer to a previous snapshot
 */

import * as fs from "fs";
import pc from "picocolors";
import { getFlag, requireFlagIdentifier, SEMANTIC_DIR } from "../../lib/cli-utils";
import {
  createSnapshot,
  getHistory,
  getLatestEntry,
  currentHash,
  diffCurrentVsSnapshot,
  diffSnapshots,
  rollbackToSnapshot,
  collectSemanticFiles,
} from "../../lib/migrate";
import type { FileDiff, DiffLine } from "../../lib/migrate";

// ── Subcommand dispatch ───────────────────────────────────────────

export async function handleMigrate(args: string[]): Promise<void> {
  const subcommand = args[1];

  const sourceArg = requireFlagIdentifier(args, "--source", "source name");
  const semanticRoot = sourceArg
    ? `${SEMANTIC_DIR}/${sourceArg}`
    : SEMANTIC_DIR;

  if (!fs.existsSync(semanticRoot)) {
    console.error(pc.red(`Semantic layer not found at ${semanticRoot}. Run 'atlas init' first.`));
    process.exit(1);
  }

  switch (subcommand) {
    case "status":
      return handleStatus(semanticRoot);
    case "snapshot":
      return handleSnapshot(args, semanticRoot);
    case "diff":
      return handleDiff(args, semanticRoot);
    case "log":
      return handleLog(args, semanticRoot);
    case "rollback":
      return handleRollback(args, semanticRoot);
    default:
      if (subcommand && !subcommand.startsWith("-")) {
        console.error(pc.red(`Unknown subcommand: ${subcommand}`));
      }
      console.error(
        "Usage: atlas migrate <status|snapshot|diff|log|rollback> [options]\n\n" +
        "Run 'atlas migrate --help' for details.",
      );
      process.exit(1);
  }
}

// ── status ────────────────────────────────────────────────────────

function handleStatus(semanticRoot: string): void {
  const files = collectSemanticFiles(semanticRoot);
  const latest = getLatestEntry(semanticRoot);
  const hash = currentHash(semanticRoot);

  console.log(`\n${pc.bold("Semantic Layer Status")}\n`);
  console.log(`  Files:    ${pc.bold(String(files.length))} YAML files`);
  console.log(`  Hash:     ${pc.cyan(hash)}`);

  if (!latest) {
    console.log(`  Snapshot: ${pc.yellow("none")} — run 'atlas migrate snapshot' to create one`);
    console.log();
    return;
  }

  console.log(`  Latest:   ${pc.cyan(latest.hash)} (${formatTimestamp(latest.timestamp)})`);

  if (latest.hash === hash) {
    console.log(`  Status:   ${pc.green("up to date")} — no changes since last snapshot`);
  } else {
    const result = diffCurrentVsSnapshot(semanticRoot);
    if (result) {
      const changed = result.diffs.filter((d) => d.status !== "unchanged");
      const added = changed.filter((d) => d.status === "added").length;
      const removed = changed.filter((d) => d.status === "removed").length;
      const modified = changed.filter((d) => d.status === "modified").length;

      const parts: string[] = [];
      if (added > 0) parts.push(pc.green(`${added} added`));
      if (modified > 0) parts.push(pc.yellow(`${modified} modified`));
      if (removed > 0) parts.push(pc.red(`${removed} removed`));

      console.log(`  Status:   ${pc.yellow("changed")} — ${parts.join(", ")}`);
    } else {
      console.log(`  Status:   ${pc.yellow("changed")}`);
    }
  }

  if (latest.message) {
    console.log(`  Message:  ${latest.message}`);
  }
  console.log();
}

// ── snapshot ──────────────────────────────────────────────────────

function handleSnapshot(args: string[], semanticRoot: string): void {
  const message = getFlag(args, "-m") ?? getFlag(args, "--message") ?? "";
  const force = args.includes("--force");

  const entry = createSnapshot(semanticRoot, {
    message,
    trigger: "manual",
    force,
  });

  if (!entry) {
    console.log(pc.dim("No changes since last snapshot — nothing to capture."));
    console.log(pc.dim("Use --force to create a snapshot anyway."));
    return;
  }

  console.log(`\n${pc.green("Snapshot created:")}`);
  console.log(`  Hash:      ${pc.cyan(entry.hash)}`);
  console.log(`  Timestamp: ${formatTimestamp(entry.timestamp)}`);
  if (entry.message) {
    console.log(`  Message:   ${entry.message}`);
  }
  console.log();
}

// ── diff ──────────────────────────────────────────────────────────

function handleDiff(args: string[], semanticRoot: string): void {
  const fromHash = getFlag(args, "--from");
  const toHash = getFlag(args, "--to");

  // Diff between two snapshots
  if (fromHash && toHash) {
    const result = diffSnapshots(semanticRoot, fromHash, toHash);
    if (!result) {
      console.error(pc.red("Could not find one or both snapshots. Run 'atlas migrate log' to see available snapshots."));
      process.exit(1);
    }
    console.log(`\n${pc.bold("Diff:")} ${pc.cyan(result.from.hash)} → ${pc.cyan(result.to.hash)}\n`);
    printDiffs(result.diffs);
    return;
  }

  // Diff current vs snapshot
  const targetHash = fromHash ?? getFlag(args, "--snapshot");
  const result = diffCurrentVsSnapshot(semanticRoot, targetHash ?? undefined);

  if (!result) {
    if (targetHash) {
      console.error(pc.red(`Snapshot not found: ${targetHash}. Run 'atlas migrate log' to see available snapshots.`));
    } else {
      console.error(pc.yellow("No snapshots found. Run 'atlas migrate snapshot' to create one."));
    }
    process.exit(1);
  }

  console.log(`\n${pc.bold("Diff:")} ${pc.cyan(result.snapshotEntry.hash)} → ${pc.cyan("current")}\n`);
  printDiffs(result.diffs);
}

// ── log ───────────────────────────────────────────────────────────

function handleLog(args: string[], semanticRoot: string): void {
  const limitArg = getFlag(args, "--limit") ?? getFlag(args, "-n");
  const limit = limitArg ? parseInt(limitArg, 10) : 20;

  const manifest = getHistory(semanticRoot);

  if (manifest.entries.length === 0) {
    console.log(pc.dim("No snapshots yet. Run 'atlas migrate snapshot' to create one."));
    return;
  }

  const entries = manifest.entries.toReversed().slice(0, limit);
  const currentH = currentHash(semanticRoot);

  console.log(`\n${pc.bold("Snapshot History")} (${manifest.entries.length} total)\n`);

  for (const entry of entries) {
    const isCurrent = entry.hash === currentH;
    const hashLabel = isCurrent
      ? pc.green(`${entry.hash} (current)`)
      : pc.cyan(entry.hash);

    console.log(`${pc.bold(hashLabel)}  ${formatTimestamp(entry.timestamp)}  [${entry.trigger}]`);
    if (entry.message) {
      console.log(`  ${entry.message}`);
    }
  }

  if (manifest.entries.length > limit) {
    console.log(pc.dim(`\n  ... ${manifest.entries.length - limit} older snapshot(s) not shown. Use --limit to see more.`));
  }
  console.log();
}

// ── rollback ──────────────────────────────────────────────────────

function handleRollback(args: string[], semanticRoot: string): void {
  const hash = args[2];

  if (!hash || hash.startsWith("-")) {
    console.error(pc.red("Usage: atlas migrate rollback <hash>"));
    console.error("  Provide the hash (or prefix) of the snapshot to restore.");
    console.error("  Run 'atlas migrate log' to see available snapshots.");
    process.exit(1);
  }

  try {
    const { restored, preRollback } = rollbackToSnapshot(semanticRoot, hash);

    console.log(`\n${pc.green("Rollback complete:")}`);
    console.log(`  Restored:     ${pc.cyan(restored.hash)} (${formatTimestamp(restored.timestamp)})`);
    if (restored.message) {
      console.log(`  Message:      ${restored.message}`);
    }
    if (preRollback) {
      console.log(`  Pre-rollback: ${pc.dim(preRollback.hash)} (saved automatically)`);
    }
    console.log();
  } catch (err) {
    console.error(pc.red(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

// ── Formatting helpers ────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function printDiffs(diffs: FileDiff[]): void {
  const changed = diffs.filter((d) => d.status !== "unchanged");

  if (changed.length === 0) {
    console.log(pc.green("  No changes."));
    return;
  }

  for (const d of changed) {
    const statusLabel =
      d.status === "added" ? pc.green("A")
      : d.status === "removed" ? pc.red("D")
      : pc.yellow("M");

    console.log(`${statusLabel}  ${d.path}`);
  }

  console.log();

  // Show detailed diff for modified files
  for (const d of changed) {
    if (d.lines.length === 0) continue;

    console.log(pc.bold(`--- a/${d.path}`));
    console.log(pc.bold(`+++ b/${d.path}`));

    for (const line of d.lines) {
      printDiffLine(line);
    }
    console.log();
  }
}

function printDiffLine(line: DiffLine): void {
  switch (line.type) {
    case "added":
      console.log(pc.green(`+${line.content}`));
      break;
    case "removed":
      console.log(pc.red(`-${line.content}`));
      break;
    case "context":
      console.log(` ${line.content}`);
      break;
  }
}
