/**
 * Snowflake-specific forbidden SQL patterns.
 *
 * Extracted from packages/api/src/lib/tools/sql.ts — these patterns block
 * Snowflake-specific statements that bypass the base DML/DDL regex guard.
 *
 * PUT/GET/LIST/REMOVE/RM are anchored to start-of-string (not word-boundary)
 * because they are common words in data values (e.g. WHERE name = 'Get Ready').
 * MERGE/SHOW/DESCRIBE/EXPLAIN/USE use word-boundary since they rarely
 * appear as data values.
 */
export const SNOWFLAKE_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*(PUT|GET|LIST|REMOVE|RM)\b/i,
  /\b(MERGE)\b/i,
  /\b(SHOW|DESCRIBE|EXPLAIN|USE)\b/i,
];
