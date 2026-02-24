/**
 * Semantic layer exploration tool.
 *
 * Uses just-bash to give the agent a full sandboxed bash environment
 * over the semantic/ directory. OverlayFs ensures read-only access:
 * reads come from disk, writes stay in memory.
 */

import { tool } from "ai";
import { z } from "zod";
import { Bash, OverlayFs } from "just-bash";
import * as path from "path";

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

let bashInstance: Bash | null = null;

function getBash(): Bash {
  if (!bashInstance) {
    const overlay = new OverlayFs({
      root: SEMANTIC_ROOT,
      mountPoint: "/semantic",
    });
    bashInstance = new Bash({
      fs: overlay,
      cwd: "/semantic",
      executionLimits: {
        maxCommandCount: 5000,
        maxLoopIterations: 1000,
      },
    });
  }
  return bashInstance;
}

export const explore = tool({
  description: `Run bash commands to explore the semantic layer (YAML files describing the data model). The working directory is /semantic.

Available commands include: ls, cat, head, tail, grep, find, wc, tree, sort, uniq, cut, awk, sed, and more. Use pipes and flags freely.

The semantic directory contains:
- catalog.yml: Index of all entities and their descriptions
- entities/*.yml: Table schemas with columns, types, sample values, joins
- metrics/*.yml: Canonical metric definitions with authoritative SQL
- glossary.yml: Business term definitions and disambiguation

Always start by reading catalog.yml to understand what data is available.`,

  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "A bash command to run, e.g. 'cat catalog.yml', 'grep -r revenue entities/', 'find . -name \"*.yml\"'"
      ),
  }),

  execute: async ({ command }) => {
    try {
      const bash = getBash();
      const result = await bash.exec(command);

      if (result.exitCode !== 0) {
        return `Error (exit ${result.exitCode}):\n${result.stderr}`;
      }

      return result.stdout || "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
