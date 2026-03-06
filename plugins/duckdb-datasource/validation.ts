/**
 * DuckDB-specific forbidden SQL patterns.
 *
 * Extracted from packages/api/src/lib/tools/sql.ts — these patterns block
 * DuckDB-specific statements and functions beyond the base DML/DDL guard.
 */

// DuckDB-specific patterns — block PRAGMA, ATTACH, DETACH, INSTALL,
// EXPORT, IMPORT, CHECKPOINT, file-reading functions, and SET.
// Note: LOAD is already blocked by base FORBIDDEN_PATTERNS.
export const DUCKDB_FORBIDDEN_PATTERNS = [
  /\b(PRAGMA)\b/i,
  /\b(ATTACH|DETACH)\b/i,
  /\b(INSTALL)\b/i,
  /\b(EXPORT|IMPORT)\b/i,
  /\b(CHECKPOINT)\b/i,
  /\b(DESCRIBE|EXPLAIN|SHOW)\b/i,
  // Block file-reading table functions that can access the host filesystem
  /\b(read_csv_auto|read_csv|read_parquet|read_json|read_json_auto|read_text)\b/i,
  /\b(parquet_scan|csv_scan|json_scan)\b/i,
  // Block SET for configuration variables (DuckDB has no session-level read-only guard for :memory:).
  // Anchored to start-of-string (^\s*) to avoid false positives on column names
  // like "dataset" or data values containing "SET". The AST parser (layer 2) provides
  // secondary defense since SET is not a SELECT statement.
  /^\s*SET\b/i,
];
