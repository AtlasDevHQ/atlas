/**
 * ClickHouse-specific forbidden SQL patterns.
 *
 * Extracted from packages/api/src/lib/tools/sql.ts — admin/mutation
 * commands unique to ClickHouse that are not covered by the base
 * FORBIDDEN_PATTERNS in the core SQL validator.
 *
 * These patterns are registered via the plugin's `forbiddenPatterns`
 * field and applied as an additional regex guard during SQL validation.
 */

export const CLICKHOUSE_FORBIDDEN_PATTERNS: RegExp[] = [
  /\b(SYSTEM)\b/i,
  /\b(KILL)\b/i,
  /\b(ATTACH|DETACH)\b/i,
  /\b(RENAME)\b/i,
  /\b(EXCHANGE)\b/i,
  /\b(SHOW|DESCRIBE|EXPLAIN|USE)\b/i,
];
