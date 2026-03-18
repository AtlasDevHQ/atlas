/**
 * Git-style diff output for `atlas learn` proposals.
 *
 * Generates unified diff format showing before/after YAML changes
 * for each file affected by proposals.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import pc from "picocolors";
import type { ProposalSet, EntityYaml } from "./propose";

/**
 * Generate a unified diff between two YAML strings.
 * Returns an array of formatted lines.
 */
function unifiedDiff(
  filePath: string,
  original: string,
  modified: string,
): string[] {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const lines: string[] = [];

  lines.push(pc.bold(`--- a/${filePath}`));
  lines.push(pc.bold(`+++ b/${filePath}`));

  // Simple diff: find added lines at the end of sections
  // For YAML amendments, new content is typically appended to arrays
  let origIdx = 0;
  let modIdx = 0;
  let hunkStart = -1;
  const hunkLines: string[] = [];

  while (origIdx < originalLines.length || modIdx < modifiedLines.length) {
    const origLine = origIdx < originalLines.length ? originalLines[origIdx] : undefined;
    const modLine = modIdx < modifiedLines.length ? modifiedLines[modIdx] : undefined;

    if (origLine === modLine) {
      // Flush any pending hunk
      if (hunkLines.length > 0) {
        lines.push(pc.cyan(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`));
        lines.push(...hunkLines);
        hunkLines.length = 0;
      }
      origIdx++;
      modIdx++;
      continue;
    }

    if (hunkLines.length === 0) {
      hunkStart = origIdx;
      // Add context lines before the change
      const ctxStart = Math.max(0, origIdx - 3);
      for (let i = ctxStart; i < origIdx; i++) {
        hunkLines.push(` ${originalLines[i]}`);
      }
    }

    // Check if original line exists later in modified (line was added before it)
    if (origLine !== undefined && modLine !== undefined) {
      // Check if modLine is a new addition
      const origRestContains = originalLines.slice(origIdx).includes(modLine);
      if (!origRestContains) {
        // New line in modified
        hunkLines.push(pc.green(`+${modLine}`));
        modIdx++;
        continue;
      }

      // Check if origLine was removed
      const modRestContains = modifiedLines.slice(modIdx).includes(origLine);
      if (!modRestContains) {
        hunkLines.push(pc.red(`-${origLine}`));
        origIdx++;
        continue;
      }

      // Both lines differ — show as removal + addition
      hunkLines.push(pc.red(`-${origLine}`));
      hunkLines.push(pc.green(`+${modLine}`));
      origIdx++;
      modIdx++;
    } else if (origLine === undefined && modLine !== undefined) {
      // Extra lines at end of modified
      hunkLines.push(pc.green(`+${modLine}`));
      modIdx++;
    } else if (origLine !== undefined && modLine === undefined) {
      // Lines removed from end
      hunkLines.push(pc.red(`-${origLine}`));
      origIdx++;
    }
  }

  // Flush remaining hunk
  if (hunkLines.length > 0) {
    lines.push(pc.cyan(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`));
    lines.push(...hunkLines);
  }

  return lines;
}

/**
 * Serialize an entity YAML consistently for diffing.
 */
function serializeEntity(entity: EntityYaml): string {
  return yaml.dump(entity, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: "'",
  });
}

/**
 * Format all proposals as a git-style diff output.
 *
 * @param proposalSet - The complete proposal set with entity/glossary updates.
 * @returns Formatted diff string ready for console output.
 */
export function formatDiff(proposalSet: ProposalSet): string {
  const output: string[] = [];

  // Entity diffs
  for (const [filePath, updatedEntity] of proposalSet.entityUpdates) {
    let originalContent: string;
    try {
      originalContent = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      console.warn(`Warning: could not read ${filePath} (${err instanceof Error ? err.message : String(err)}) — diffing against empty file`);
      originalContent = "";
    }

    const modifiedContent = serializeEntity(updatedEntity);

    // Make paths relative to cwd for cleaner output
    const relativePath = filePath.replace(process.cwd() + "/", "");
    const diffLines = unifiedDiff(relativePath, originalContent, modifiedContent);

    if (diffLines.length > 2) { // More than just --- and +++ headers
      output.push(...diffLines);
      output.push(""); // blank line between files
    }
  }

  // Glossary diff
  if (proposalSet.glossaryUpdate && proposalSet.glossaryPath) {
    let originalContent: string;
    try {
      originalContent = fs.readFileSync(proposalSet.glossaryPath, "utf-8");
    } catch (err) {
      console.warn(`Warning: could not read ${proposalSet.glossaryPath} (${err instanceof Error ? err.message : String(err)}) — diffing against empty file`);
      originalContent = "";
    }

    const modifiedContent = yaml.dump(proposalSet.glossaryUpdate, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
      quotingType: "'",
    });

    const relativePath = proposalSet.glossaryPath.replace(process.cwd() + "/", "");
    const diffLines = unifiedDiff(relativePath, originalContent, modifiedContent);

    if (diffLines.length > 2) {
      output.push(...diffLines);
      output.push("");
    }
  }

  return output.join("\n");
}

/**
 * Format a summary of proposals for console output.
 */
export function formatSummary(proposalSet: ProposalSet): string {
  const { proposals } = proposalSet;
  if (proposals.length === 0) {
    return pc.green("No new patterns found — semantic layer is up to date.");
  }

  const byType = {
    query_pattern: proposals.filter((p) => p.type === "query_pattern"),
    join: proposals.filter((p) => p.type === "join"),
    glossary_term: proposals.filter((p) => p.type === "glossary_term"),
  };

  const lines: string[] = [
    pc.bold(`Found ${proposals.length} proposal(s):`),
    "",
  ];

  if (byType.query_pattern.length > 0) {
    lines.push(pc.bold(`  Query patterns (${byType.query_pattern.length}):`));
    for (const p of byType.query_pattern) {
      lines.push(`    ${pc.green("+")} ${p.description}`);
    }
    lines.push("");
  }

  if (byType.join.length > 0) {
    lines.push(pc.bold(`  Join discoveries (${byType.join.length}):`));
    for (const p of byType.join) {
      lines.push(`    ${pc.green("+")} ${p.description}`);
    }
    lines.push("");
  }

  if (byType.glossary_term.length > 0) {
    lines.push(pc.bold(`  Glossary terms (${byType.glossary_term.length}):`));
    for (const p of byType.glossary_term) {
      lines.push(`    ${pc.green("+")} ${p.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
