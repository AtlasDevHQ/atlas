/**
 * Ratchet against `--help` drift (#4472): `SUBCOMMAND_HELP` in lib/help.ts is
 * static text, and bin/atlas.ts intercepts `--help` before handlers run — so
 * when a handler grows a flag, the stale help text is what users see. Caught
 * once by the 2026-07-10 docs audit (`--api-key` missing on four commands,
 * five canonical-eval flags absent); this test makes the drift class fail CI.
 *
 * Flags are extracted from each handler's source with the same quoted-literal
 * patterns the handlers actually parse with (`=== "--x"`, `getFlag(args,
 * "--x")`, `args.includes("--x")`, value-flag Set literals). A flag literal a
 * handler parses must be mentioned in its SUBCOMMAND_HELP entry.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { SUBCOMMAND_HELP } from "../../lib/help";

const CLI_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Commands whose handler source is scanned against their help entry. */
const COMMAND_SOURCES: Record<string, string> = {
  query: "src/commands/query.ts",
  sql: "src/commands/sql.ts",
  metric: "src/commands/metric.ts",
  datasource: "src/commands/datasource.ts",
  "canonical-eval": "bin/canonical-eval-run.ts",
};

/**
 * `--help`/`-h` are intercepted globally in bin/atlas.ts before any handler
 * runs, so handlers checking for them defensively don't need a help entry.
 */
const GLOBAL_FLAGS = new Set(["--help"]);

/**
 * Extract the `--flag` literals a source file parses. Matches the concrete
 * parsing constructs used across the CLI (strict equality against an arg,
 * getFlag lookups, args.includes membership, and Set/array literals of
 * value-taking flags) rather than every `--x` substring, so prose in error
 * messages that references other commands' flags can't create false demands.
 */
function extractParsedFlags(source: string): Set<string> {
  const patterns = [
    /===\s*"(--[a-z][a-z-]*)"/g,
    /getFlag\(\s*args,\s*"(--[a-z][a-z-]*)"/g,
    /args\.includes\(\s*"(--[a-z][a-z-]*)"/g,
    /"(--[a-z][a-z-]*)"\s*[,\]]/g,
  ];
  const flags = new Set<string>();
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const flag = m[1];
      if (flag && !GLOBAL_FLAGS.has(flag)) flags.add(flag);
    }
  }
  return flags;
}

/** Every flag string mentioned anywhere in a help entry (flags list + usage). */
function helpMentions(command: string): string {
  const entry = SUBCOMMAND_HELP[command];
  if (!entry) return "";
  return [
    entry.usage,
    ...(entry.flags ?? []).map((f) => f.flag),
    ...(entry.subcommands ?? []).map((s) => s.name),
  ].join("\n");
}

describe("SUBCOMMAND_HELP tracks the flags handlers actually parse", () => {
  for (const [command, relPath] of Object.entries(COMMAND_SOURCES)) {
    test(`${command}: every parsed flag is mentioned in its help entry`, () => {
      const source = fs.readFileSync(path.join(CLI_ROOT, relPath), "utf8");
      const parsed = extractParsedFlags(source);
      // The extractor going blind (refactor away from the matched parsing
      // constructs) must fail loudly, not pass vacuously.
      expect(parsed.size).toBeGreaterThan(0);
      const mentions = helpMentions(command);
      expect(mentions).not.toBe("");
      const missing = [...parsed].filter((f) => !mentions.includes(f));
      expect(
        missing,
        `${relPath} parses flags absent from SUBCOMMAND_HELP["${command}"] — update lib/help.ts`,
      ).toEqual([]);
    });
  }

  test("query/sql/metric/datasource all document --api-key", () => {
    for (const command of ["query", "sql", "metric", "datasource"]) {
      expect(
        (SUBCOMMAND_HELP[command]?.flags ?? []).some((f) =>
          f.flag.startsWith("--api-key"),
        ),
        `SUBCOMMAND_HELP["${command}"] must list --api-key`,
      ).toBe(true);
    }
  });
});
