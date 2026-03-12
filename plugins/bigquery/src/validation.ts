/**
 * BigQuery-specific forbidden SQL patterns.
 *
 * These patterns supplement the base `FORBIDDEN_PATTERNS` in
 * `packages/api/src/lib/tools/sql.ts`, which blocks common DML/DDL and
 * administrative keywords. The patterns here cover BigQuery-specific
 * statements not caught by the base set.
 *
 * All patterns are anchored to start-of-statement (`^\s*`) to avoid
 * false-positives on mid-query data values (e.g. WHERE action = 'merge').
 * The core pipeline strips SQL comments before testing these patterns.
 */
export const BIGQUERY_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*(MERGE)\b/i,
  /^\s*(EXPORT\s+DATA)\b/i,
  /^\s*(DECLARE|SET|BEGIN|ASSERT|RAISE)\b/i,
];
