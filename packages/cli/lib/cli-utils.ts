/**
 * Shared CLI utilities used across multiple command handlers.
 *
 * Extracted from atlas.ts to reduce monolith size and enable
 * reuse without circular dependencies.
 */

import * as path from "path";
import type { DBType } from "@atlas/api/lib/db/connection";
import type { ProfileError, ProfileLogger } from "@atlas/api/lib/profiler";

// --- Constants ---

export const SEMANTIC_DIR = path.resolve("semantic");
export const ENTITIES_DIR = path.join(SEMANTIC_DIR, "entities");

// --- CLI profile logger ---

/** Adapts the profiler's structured logger to CLI console output. */
export const cliProfileLogger: ProfileLogger = {
  info(_obj, msg) {
    console.log(`  ${msg}`);
  },
  warn(obj, msg) {
    const ctx = [obj.table, obj.column].filter(Boolean).join(".");
    console.warn(
      `  Warning: ${msg}${ctx ? ` (${ctx})` : ""}${obj.err ? `: ${obj.err}` : ""}`,
    );
  },
  error(obj, msg) {
    const ctx = [obj.table, obj.column].filter(Boolean).join(".");
    console.error(
      `  ${msg}${ctx ? ` (${ctx})` : ""}${obj.err ? `: ${obj.err}` : ""}`,
    );
  },
};

// --- Identifier validation ---

const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(value: string, label: string): void {
  if (!VALID_SQL_IDENTIFIER.test(value)) {
    console.error(
      `Error: Invalid ${label} "${value}". Must contain only letters, digits, and underscores, and start with a letter or underscore.`,
    );
    process.exit(1);
  }
}

export function validateSchemaName(schema: string): void {
  validateIdentifier(schema, "schema name");
}

// --- Flag parsing ---

/**
 * Extract the value of a CLI flag from args.
 * Returns undefined if the flag is not present or has no value.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.startsWith("--")) return undefined;
  return value;
}

/**
 * Parse a --flag that requires a value and validate it as a safe identifier.
 * Returns the value if present, undefined if the flag was not used at all.
 * Exits with an error if the flag was used without a value or with an invalid one.
 */
export function requireFlagIdentifier(
  args: string[],
  flag: string,
  label: string,
): string | undefined {
  const value = getFlag(args, flag);
  if (!value && args.includes(flag)) {
    console.error(
      `Error: ${flag} requires a value (e.g., ${flag} warehouse).`,
    );
    process.exit(1);
  }
  if (value) validateIdentifier(value, label);
  return value;
}

// --- DB type detection ---

/** CLI-local DB type detection -- supports all URL schemes (core + plugin databases). */
export function detectDBType(url: string): DBType {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://"))
    return "postgres";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "mysql";
  if (url.startsWith("clickhouse://") || url.startsWith("clickhouses://"))
    return "clickhouse";
  if (url.startsWith("snowflake://")) return "snowflake";
  if (url.startsWith("duckdb://")) return "duckdb";
  if (url.startsWith("salesforce://")) return "salesforce";
  const scheme = url.split("://")[0] || "(empty)";
  throw new Error(
    `Unsupported database URL scheme "${scheme}://". ` +
      "Supported: postgresql://, mysql://, clickhouse://, snowflake://, duckdb://, salesforce://.",
  );
}

// --- Profiling error logging ---

/** Log a warning summary for profiling errors (first 5 + overflow). CLI-specific: uses console.warn formatting rather than the profiler's structured logger. */
export function logProfilingErrors(
  errors: ProfileError[],
  total: number,
): void {
  const pct = Math.round((errors.length / total) * 100);
  console.warn(
    `\nWarning: ${errors.length}/${total} tables (${pct}%) failed to profile:`,
  );
  const preview = errors.slice(0, 5);
  for (const e of preview) {
    console.warn(`  - ${e.table}: ${e.error}`);
  }
  if (errors.length > 5) {
    console.warn(`  ... and ${errors.length - 5} more`);
  }
}
