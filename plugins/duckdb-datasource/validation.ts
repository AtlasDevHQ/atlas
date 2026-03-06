/**
 * DuckDB-specific forbidden SQL patterns.
 *
 * Statement-level commands (PRAGMA, ATTACH, DETACH, INSTALL, EXPORT, IMPORT,
 * CHECKPOINT, SET) are anchored to start-of-string to avoid false positives
 * on data values. File-reading functions use word-boundary matching since they
 * appear as function calls mid-query. LOAD is already blocked by base patterns.
 */
export const DUCKDB_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*(PRAGMA)\b/i,
  /^\s*(ATTACH|DETACH)\b/i,
  /^\s*(INSTALL)\b/i,
  /^\s*(EXPORT|IMPORT)\b/i,
  /^\s*(CHECKPOINT)\b/i,
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
