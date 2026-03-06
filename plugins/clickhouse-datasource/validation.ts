/**
 * ClickHouse-specific forbidden SQL patterns.
 *
 * Statement-level admin commands (SYSTEM, KILL, ATTACH, DETACH, RENAME,
 * EXCHANGE) are anchored to start-of-string to avoid false positives on
 * data values (e.g. WHERE action = 'kill', FROM system.query_log).
 *
 * SHOW/DESCRIBE/EXPLAIN/USE use word-boundary matching since they are
 * less likely to appear as data values and blocking them mid-query
 * (e.g. subquery EXPLAIN) is intentional.
 */
export const CLICKHOUSE_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*(SYSTEM)\b/i,
  /^\s*(KILL)\b/i,
  /^\s*(ATTACH|DETACH)\b/i,
  /^\s*(RENAME)\b/i,
  /^\s*(EXCHANGE)\b/i,
  /\b(SHOW|DESCRIBE|EXPLAIN|USE)\b/i,
];
