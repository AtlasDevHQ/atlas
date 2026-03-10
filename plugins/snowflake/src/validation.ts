/**
 * Snowflake-specific forbidden SQL patterns.
 *
 * These patterns supplement the base `FORBIDDEN_PATTERNS` in
 * `packages/api/src/lib/tools/sql.ts`, which already blocks common DML/DDL
 * keywords (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, COPY,
 * LOAD, GRANT, REVOKE, EXEC, EXECUTE, CALL, etc.). The patterns here cover
 * Snowflake-specific statements not caught by the base set.
 *
 * All patterns are anchored to start-of-statement (`^\s*`) to avoid
 * false-positives on data values in WHERE clauses and string literals
 * (e.g. WHERE title = 'Please explain the billing issue').
 */
export const SNOWFLAKE_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*(PUT|GET|LIST|REMOVE|RM)\b/i,
  /^\s*(MERGE)\b/i,
  /^\s*(SHOW|DESCRIBE|DESC|EXPLAIN|USE)\b/i,
];
