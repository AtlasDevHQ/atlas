/**
 * Semantic layer exploration tool.
 *
 * Abstracts the shell backend behind an ExploreBackend interface so the
 * explore tool works on both self-hosted (just-bash) and Vercel (@vercel/sandbox).
 *
 * Both backends isolate command execution so the agent cannot modify the
 * host filesystem or access resources outside the semantic layer.
 * - just-bash: OverlayFs ensures read-only access; writes stay in memory.
 * - @vercel/sandbox: ephemeral microVM with networkPolicy "deny-all".
 */

import { tool } from "ai";
import { z } from "zod";
import * as path from "path";

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

// --- Backend interface ---

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shell backend for the explore tool.
 *
 * Implementations MUST provide read-only filesystem access scoped to the
 * semantic layer directory. Commands execute within /semantic as the working
 * directory. Writes should be silently discarded or cause errors, never
 * modify the host filesystem.
 */
export interface ExploreBackend {
  exec(command: string): Promise<ExecResult>;
  close?(): Promise<void>;
}

// --- Self-hosted backend (just-bash) ---

async function createBashBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
  let Bash, OverlayFs;
  try {
    ({ Bash, OverlayFs } = await import("just-bash"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[atlas] Failed to import just-bash:", detail);
    throw new Error(
      "Failed to load the just-bash runtime for the explore tool. " +
        "Ensure 'just-bash' is installed ('bun install'). " +
        "If running on Vercel, set ATLAS_RUNTIME=vercel.",
      { cause: err }
    );
  }

  const overlay = new OverlayFs({
    root: semanticRoot,
    mountPoint: "/semantic",
  });
  const bash = new Bash({
    fs: overlay,
    cwd: "/semantic",
    executionLimits: {
      maxCommandCount: 5000,
      maxLoopIterations: 1000,
    },
  });
  return {
    exec: async (command: string) => {
      const result = await bash.exec(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

// --- Runtime detection ---

function useVercelSandbox(): boolean {
  return process.env.ATLAS_RUNTIME === "vercel" || !!process.env.VERCEL;
}

let backendPromise: Promise<ExploreBackend> | null = null;

/** Clear cached backend so the next call recreates it. */
export function invalidateExploreBackend(): void {
  backendPromise = null;
}

function getExploreBackend(): Promise<ExploreBackend> {
  if (!backendPromise) {
    backendPromise = (
      useVercelSandbox()
        ? import("./explore-sandbox").then((m) =>
            m.createSandboxBackend(SEMANTIC_ROOT)
          )
        : createBashBackend(SEMANTIC_ROOT)
    ).catch((err) => {
      backendPromise = null; // allow retry on next call
      throw err;
    });
  }
  return backendPromise;
}

// --- Tool definition ---

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
        'A bash command to run, e.g. \'cat catalog.yml\', \'grep -r revenue entities/\', \'find . -name "*.yml"\''
      ),
  }),

  execute: async ({ command }) => {
    let backend: ExploreBackend;
    try {
      backend = await getExploreBackend();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[atlas] Explore backend initialization failed:", detail);
      return `Error: Explore tool is unavailable — ${detail}`;
    }

    try {
      const result = await backend.exec(command);

      if (result.exitCode !== 0) {
        return `Error (exit ${result.exitCode}):\n${result.stderr}`;
      }

      return result.stdout || "(no output)";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        "[atlas] Explore command failed:",
        detail,
        "| command:",
        command
      );
      return `Error: ${detail}`;
    }
  },
});
