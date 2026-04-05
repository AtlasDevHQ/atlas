/**
 * Interactive session manager for `atlas improve -i`.
 *
 * Readline-based interactive review: presents analysis results one at a
 * time, shows colorized YAML diffs, and lets the user approve/reject/skip
 * each proposal. Accepted proposals are written to YAML files immediately.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as yaml from "js-yaml";
import pc from "picocolors";
import type { AnalysisResult } from "@atlas/api/lib/semantic/expert";
import {
  createSession,
  nextProposal,
  recordDecision,
  addMessage,
  getSessionSummary,
} from "@atlas/api/lib/semantic/expert";
import type { SessionState } from "@atlas/api/lib/semantic/expert";
import { applyAmendmentToEntity } from "./apply-amendment";
import { createSnapshot } from "../migrate";

// ── Diff rendering ─────────────────────────────────────────────────

/**
 * Generate a colorized line-by-line diff between before/after YAML.
 * Uses positional comparison (not a full diff algorithm), which works
 * well for append-only YAML changes.
 */
function renderDiff(entityName: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const output: string[] = [
    pc.bold(`--- a/semantic/entities/${entityName}.yml`),
    pc.bold(`+++ b/semantic/entities/${entityName}.yml`),
  ];

  const maxLen = Math.max(beforeLines.length, afterLines.length);
  let diffStart = -1;
  let diffEnd = -1;

  for (let i = 0; i < maxLen; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      if (diffStart === -1) diffStart = i;
      diffEnd = i;
    }
  }

  if (diffStart === -1) return pc.dim("  (no changes)");

  const ctxStart = Math.max(0, diffStart - 3);
  const ctxEnd = Math.min(maxLen - 1, diffEnd + 3);

  output.push(pc.cyan(`@@ -${ctxStart + 1},${Math.min(beforeLines.length, ctxEnd + 1) - ctxStart} +${ctxStart + 1},${Math.min(afterLines.length, ctxEnd + 1) - ctxStart} @@`));

  for (let i = ctxStart; i <= ctxEnd; i++) {
    const bLine = i < beforeLines.length ? beforeLines[i] : undefined;
    const aLine = i < afterLines.length ? afterLines[i] : undefined;

    if (bLine === aLine) {
      if (bLine !== undefined) output.push(` ${bLine}`);
    } else {
      if (bLine !== undefined) output.push(pc.red(`-${bLine}`));
      if (aLine !== undefined) output.push(pc.green(`+${aLine}`));
    }
  }

  return output.join("\n");
}

/** Format an amendment type for display. */
function formatType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Path safety ────────────────────────────────────────────────────

/** Resolve entity path with directory traversal protection. */
function safeEntityPath(entitiesDir: string, entityName: string): string | null {
  const resolved = path.resolve(entitiesDir, `${entityName}.yml`);
  if (!resolved.startsWith(path.resolve(entitiesDir))) {
    console.error(pc.red(`  Refused: entity name "${entityName}" escapes entities directory`));
    return null;
  }
  return resolved;
}

// ── Proposal presentation ──────────────────────────────────────────

/** Print a single proposal with context and diff. */
function presentProposal(
  index: number,
  total: number,
  result: AnalysisResult,
  entitiesDir: string,
): void {
  const confidencePct = Math.round(result.confidence * 100);

  console.log();
  console.log(pc.dim(`─── Proposal ${index + 1}/${total} ───`));
  console.log(
    `${pc.bold(`[${result.entityName}]`)} ${pc.cyan(formatType(result.amendmentType))}`,
  );
  console.log(`  ${result.rationale}`);
  console.log(
    `  Confidence: ${confidencePct}%  Score: ${result.score >= 0.5 ? pc.green(String(result.score)) : pc.yellow(String(result.score))}  Category: ${result.category}`,
  );

  const amendment = result.amendment as Record<string, unknown>;
  if (amendment.name) {
    console.log(`  Name: ${pc.bold(String(amendment.name))}`);
  }
  if (amendment.sql) {
    console.log(`  SQL: ${pc.dim(String(amendment.sql))}`);
  }

  // Show diff
  const entityPath = safeEntityPath(entitiesDir, result.entityName);
  if (entityPath && fs.existsSync(entityPath)) {
    try {
      const beforeYaml = fs.readFileSync(entityPath, "utf-8");
      const entity = yaml.load(beforeYaml) as Record<string, unknown>;
      const { updated, warning } = applyAmendmentToEntity(entity, result);
      if (warning) {
        console.warn(pc.yellow(`  Warning: ${warning}`));
      }
      const afterYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });
      console.log();
      console.log(renderDiff(result.entityName, beforeYaml, afterYaml));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(pc.yellow(`  Could not generate diff for ${result.entityName}.yml: ${msg}`));
    }
  }

  console.log();
}

// ── File writing ───────────────────────────────────────────────────

/** Apply a single proposal to the YAML file on disk. */
function applyToFile(result: AnalysisResult, entitiesDir: string): boolean {
  const entityPath = safeEntityPath(entitiesDir, result.entityName);
  if (!entityPath) return false;

  if (!fs.existsSync(entityPath)) {
    console.warn(pc.yellow(`  File not found: ${entityPath}`));
    return false;
  }

  try {
    const content = fs.readFileSync(entityPath, "utf-8");
    const entity = yaml.load(content) as Record<string, unknown>;
    const { updated, warning } = applyAmendmentToEntity(entity, result);
    if (warning) {
      console.warn(pc.yellow(`  Warning: ${warning}`));
    }
    const updatedYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(entityPath, updatedYaml, "utf-8");
    return true;
  } catch (err) {
    console.error(pc.red(`  Failed to apply: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }
}

// ── Readline prompt ────────────────────────────────────────────────

/** Prompt the user and resolve with their answer. Rejects on Ctrl+C/Ctrl+D. */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
    rl.once("close", () => {
      reject(new Error("readline closed"));
    });
  });
}

// ── Session summary ────────────────────────────────────────────────

function printSessionSummary(session: SessionState): void {
  const summary = getSessionSummary(session);
  const elapsed = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  console.log();
  console.log(pc.bold("Session Summary"));
  console.log(pc.dim("─".repeat(40)));
  console.log(`  ${pc.green(`${summary.accepted} accepted`)}`);
  console.log(`  ${pc.red(`${summary.rejected} rejected`)}`);
  console.log(`  ${pc.yellow(`${summary.skipped} skipped`)}`);
  console.log(`  ${pc.dim(`${summary.remaining} remaining`)}`);
  console.log(`  Duration: ${minutes > 0 ? `${minutes}m ` : ""}${seconds}s`);
  console.log();
}

// ── Main interactive loop ──────────────────────────────────────────

export interface InteractiveOptions {
  readonly entitiesDir: string;
  readonly semanticRoot: string;
  readonly proposals: readonly AnalysisResult[];
}

/**
 * Run the interactive improvement session.
 *
 * Presents proposals one at a time, prompts the user for decisions,
 * and applies accepted changes immediately.
 */
export async function runInteractiveSession(
  options: InteractiveOptions,
): Promise<SessionState> {
  const { entitiesDir, semanticRoot, proposals } = options;
  const session = createSession([...proposals]);

  if (proposals.length === 0) {
    console.log(pc.green("\nYour semantic layer looks good! No improvements found.\n"));
    return session;
  }

  // Auto-snapshot before interactive session begins
  try {
    const entry = createSnapshot(semanticRoot, {
      message: `Pre-improve interactive snapshot (${proposals.length} proposals)`,
      trigger: "interactive",
    });
    if (entry) {
      console.log(pc.dim(`  Snapshot ${entry.hash} created before interactive session`));
    }
  } catch (err) {
    console.warn(pc.yellow(`  Warning: Could not create snapshot: ${err instanceof Error ? err.message : String(err)}`));
  }

  console.log(
    `\nFound ${pc.bold(String(proposals.length))} improvement${proposals.length === 1 ? "" : "s"}. ` +
    `Reviewing one at a time.\n` +
    pc.dim("  y = accept  n = reject  s = skip  q = quit  ? = help\n"),
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let proposal = nextProposal(session);

    while (proposal !== null) {
      presentProposal(
        session.currentIndex,
        session.proposals.length,
        proposal,
        entitiesDir,
      );

      let answer: string;
      try {
        answer = await prompt(rl, pc.bold("  Apply? [y/n/s/q/?] "));
      } catch {
        // readline closed (Ctrl+C / Ctrl+D) — exit gracefully
        console.log(pc.dim("\n  Session interrupted."));
        break;
      }

      switch (answer) {
        case "y":
        case "yes": {
          const applied = applyToFile(proposal, entitiesDir);
          if (applied) {
            console.log(pc.green("  Applied."));
            addMessage(session, "user", `Accepted: [${proposal.amendmentType}] ${proposal.entityName}`);
          } else {
            console.log(pc.yellow("  Could not apply — skipping."));
            addMessage(session, "user", `Could not apply: [${proposal.amendmentType}] ${proposal.entityName}`);
          }
          recordDecision(session, applied ? "accepted" : "skipped");
          break;
        }

        case "n":
        case "no": {
          console.log(pc.red("  Rejected — skipped for this session."));
          addMessage(session, "user", `Rejected: [${proposal.amendmentType}] ${proposal.entityName}`);
          recordDecision(session, "rejected");
          break;
        }

        case "s":
        case "skip":
        case "": {
          console.log(pc.dim("  Skipped."));
          addMessage(session, "user", `Skipped: [${proposal.amendmentType}] ${proposal.entityName}`);
          recordDecision(session, "skipped");
          break;
        }

        case "q":
        case "quit":
        case "exit": {
          console.log(pc.dim("\n  Ending session..."));
          printSessionSummary(session);
          return session;
        }

        case "?":
        case "help": {
          console.log();
          console.log("  Commands:");
          console.log(`    ${pc.bold("y")} / ${pc.bold("yes")}      Apply this change to the YAML file`);
          console.log(`    ${pc.bold("n")} / ${pc.bold("no")}       Reject (skipped for this session)`);
          console.log(`    ${pc.bold("s")} / ${pc.bold("skip")}     Skip for now (may appear again next time)`);
          console.log(`    ${pc.bold("q")} / ${pc.bold("quit")}     End session and show summary`);
          console.log(`    ${pc.bold("?")} / ${pc.bold("help")}     Show this help`);
          console.log();
          continue;
        }

        default: {
          console.log(pc.yellow(`  Unknown command "${answer}". Type ? for help.`));
          continue;
        }
      }

      proposal = nextProposal(session);
    }

    console.log(pc.dim("\n  All proposals reviewed."));
    printSessionSummary(session);
  } finally {
    rl.close();
  }

  return session;
}
