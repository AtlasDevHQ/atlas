/**
 * Semantic layer exploration tool.
 *
 * Gives the agent read-only access to the semantic/ directory on disk.
 * No sandbox needed — these are static YAML files.
 *
 * Supports: ls, cat, grep, find (constrained to semantic/ root).
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

async function resolveSafePath(targetPath: string): Promise<string> {
  // Normalize and resolve relative to semantic root
  const resolved = path.resolve(SEMANTIC_ROOT, targetPath);

  // Prevent directory traversal
  if (!resolved.startsWith(SEMANTIC_ROOT)) {
    throw new Error("Access denied: path is outside the semantic directory");
  }

  return resolved;
}

export const explore = tool({
  description: `Read files from the semantic layer directory. Use this to understand the data model before writing SQL.

Available commands:
- ls [path]: List files and directories
- cat <path>: Read a file's contents
- grep <pattern> [path]: Search for text across files
- find <pattern>: Find files matching a glob pattern

The semantic directory contains:
- catalog.yml: Index of all entities and their descriptions
- entities/*.yml: Table schemas with columns, types, sample values, joins
- metrics/*.yml: Canonical metric definitions with authoritative SQL
- glossary.yml: Business term definitions and disambiguation

Always start by reading catalog.yml to understand what data is available.`,

  inputSchema: z.object({
    command: z.enum(["ls", "cat", "grep", "find"]),
    args: z
      .string()
      .describe(
        "Command arguments: path for ls/cat, 'pattern [path]' for grep, 'pattern' for find"
      ),
  }),

  execute: async ({ command, args }) => {
    try {
      switch (command) {
        case "ls": {
          const target = await resolveSafePath(args || ".");
          const entries = await fs.readdir(target, { withFileTypes: true });
          return entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join("\n");
        }

        case "cat": {
          const target = await resolveSafePath(args);
          const content = await fs.readFile(target, "utf-8");
          return content;
        }

        case "grep": {
          const parts = args.split(/\s+/);
          const pattern = parts[0];
          const searchPath = parts[1] || ".";
          const target = await resolveSafePath(searchPath);
          const regex = new RegExp(pattern, "gi");
          const results: string[] = [];

          async function searchDir(dir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                await searchDir(full);
              } else if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
                const content = await fs.readFile(full, "utf-8");
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (regex.test(lines[i])) {
                    const rel = path.relative(SEMANTIC_ROOT, full);
                    results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                  }
                }
              }
            }
          }

          await searchDir(target);
          return results.length > 0
            ? results.join("\n")
            : `No matches for "${pattern}"`;
        }

        case "find": {
          const pattern = args.toLowerCase();
          const results: string[] = [];

          async function findInDir(dir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.name.toLowerCase().includes(pattern)) {
                const rel = path.relative(SEMANTIC_ROOT, full);
                results.push(entry.isDirectory() ? `${rel}/` : rel);
              }
              if (entry.isDirectory()) await findInDir(full);
            }
          }

          await findInDir(SEMANTIC_ROOT);
          return results.length > 0
            ? results.join("\n")
            : `No files matching "${pattern}"`;
        }
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
