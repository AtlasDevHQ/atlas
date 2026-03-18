/**
 * Audit log analyzer for `atlas learn`.
 *
 * Reads successful SQL queries from the internal DB audit_log table,
 * parses each via node-sql-parser, and extracts structural patterns:
 * table usage, column usage, join pairs, and aggregation patterns.
 *
 * This is offline batch analysis — no runtime overhead.
 */

import { Parser } from "node-sql-parser";

const parser = new Parser();

// ── Types ──────────────────────────────────────────────────────────

export interface AuditRow {
  sql: string;
  row_count: number | null;
  tables_accessed: string[] | null;
  columns_accessed: string[] | null;
}

/** A join relationship observed between two tables. */
export interface ObservedJoin {
  fromTable: string;
  toTable: string;
  /** Raw ON clause expression, best-effort extracted. */
  onClause: string | null;
  count: number;
}

/** A query pattern extracted from audit log. */
export interface ObservedPattern {
  /** Original SQL with whitespace collapsed to single spaces. */
  sql: string;
  /** Tables referenced in this query. */
  tables: string[];
  /** Number of times this pattern appeared. */
  count: number;
  /** Primary table this pattern should be associated with. */
  primaryTable: string;
  /** Human-readable description derived from the query structure. */
  description: string;
}

/** Column alias usage observed in queries. */
export interface ObservedAlias {
  alias: string;
  /** The SQL expression this alias refers to. */
  expression: string;
  /** Tables this alias appeared with. */
  tables: string[];
  count: number;
}

/** Complete analysis result from the audit log. */
export interface AnalysisResult {
  totalQueries: number;
  /** Table → usage count. */
  tableUsage: Map<string, number>;
  /** "tableA::tableB" (sorted) → ObservedJoin. */
  joins: Map<string, ObservedJoin>;
  /** Deduplicated query patterns above the frequency threshold. */
  patterns: ObservedPattern[];
  /** Column alias → ObservedAlias. */
  aliases: ObservedAlias[];
}

// ── Audit log query ────────────────────────────────────────────────

/**
 * Fetch successful queries from the audit log.
 * Uses the internal DB pool directly — caller must ensure DATABASE_URL is set.
 */
export async function fetchAuditLog(
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  options: { limit?: number; since?: string } = {},
): Promise<AuditRow[]> {
  const limit = options.limit ?? 1000;
  const params: unknown[] = [limit];
  let whereClause = "WHERE success = true AND sql IS NOT NULL";

  if (options.since) {
    whereClause += " AND timestamp >= $2";
    params.push(options.since);
  }

  const result = await pool.query(
    `SELECT sql, row_count, tables_accessed, columns_accessed
     FROM audit_log
     ${whereClause}
     ORDER BY timestamp DESC
     LIMIT $1`,
    params,
  );

  return result.rows.map((r) => ({
    sql: r.sql as string,
    row_count: r.row_count as number | null,
    tables_accessed: parseJsonbArray(r.tables_accessed),
    columns_accessed: parseJsonbArray(r.columns_accessed),
  }));
}

function parseJsonbArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) { console.debug("parseJsonbArray: failed to parse JSON string", err instanceof Error ? err.message : String(err)); }
  }
  return null;
}

// ── SQL parsing helpers ────────────────────────────────────────────

interface ParsedQuery {
  tables: string[];
  columns: string[];
  joinPairs: Array<{ from: string; to: string; on: string | null }>;
  hasGroupBy: boolean;
  hasAggregation: boolean;
  aliases: Array<{ alias: string; expression: string }>;
}

/**
 * Parse a SQL query and extract structural information.
 * Returns null if parsing fails (best-effort — audit log may contain
 * queries from different dialects).
 */
function parseQuery(sql: string): ParsedQuery | null {
  // Try PostgreSQL first, then MySQL
  for (const dialect of ["PostgresQL", "MySQL"] as const) {
    let ast;
    try {
      ast = parser.astify(sql, { database: dialect });
    } catch {
      continue; // Try next dialect
    }

    const stmt = Array.isArray(ast) ? ast[0] : ast;
    if (!stmt || stmt.type !== "select") return null;

    // Cast through unknown — node-sql-parser's Select type lacks index signature
    const stmtObj = stmt as unknown as Record<string, unknown>;
    const tables = extractTablesFromAst(stmt);
    const columns = extractColumnsFromAst(stmt);
    const joinPairs = extractJoinsFromAst(stmtObj);
    const hasGroupBy = !!stmtObj.groupby;
    const hasAggregation = detectAggregation(stmtObj);
    const aliases = extractAliases(stmtObj);

    return { tables, columns, joinPairs, hasGroupBy, hasAggregation, aliases };
  }
  return null;
}

function extractTablesFromAst(ast: unknown): string[] {
  try {
    const refs = parser.tableList(parser.sqlify(ast as Parameters<typeof parser.sqlify>[0]), { database: "PostgresQL" });
    return [...new Set(
      refs.map((ref) => {
        const parts = ref.split("::");
        return parts.pop()?.toLowerCase() ?? "";
      }).filter(Boolean),
    )];
  } catch (err) {
    console.debug("extractTablesFromAst: failed to extract tables", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function extractColumnsFromAst(ast: unknown): string[] {
  try {
    const refs = parser.columnList(parser.sqlify(ast as Parameters<typeof parser.sqlify>[0]), { database: "PostgresQL" });
    return [...new Set(
      refs.map((ref) => {
        const parts = ref.split("::");
        const col = parts.pop() ?? "";
        if (col === "(.*)") return "*";
        return col.toLowerCase();
      }).filter(Boolean),
    )];
  } catch (err) {
    console.debug("extractColumnsFromAst: failed to extract columns", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function extractJoinsFromAst(stmt: Record<string, unknown>): Array<{ from: string; to: string; on: string | null }> {
  const results: Array<{ from: string; to: string; on: string | null }> = [];
  const from = stmt.from as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(from)) return results;

  for (let i = 0; i < from.length; i++) {
    const item = from[i]!;
    if (item.join && item.table) {
      // Left side is the previous table in the FROM clause (handles multi-join chains)
      const leftTable = (i > 0 ? from[i - 1]?.table : from[0]?.table) as string | undefined;
      const rightTable = item.table as string;
      if (leftTable && rightTable) {
        let onClause: string | null = null;
        try {
          if (item.on) {
            onClause = parser.exprToSQL(item.on as Parameters<typeof parser.exprToSQL>[0]);
          }
        } catch (err) { console.debug("extractJoinsFromAst: failed to convert ON clause", err instanceof Error ? err.message : String(err)); }
        results.push({
          from: leftTable.toLowerCase(),
          to: rightTable.toLowerCase(),
          on: onClause,
        });
      }
    }
  }
  return results;
}

function detectAggregation(stmt: Record<string, unknown>): boolean {
  const sql = JSON.stringify(stmt).toLowerCase();
  return /\b(count|sum|avg|min|max)\s*\(/.test(sql);
}

function extractAliases(stmt: Record<string, unknown>): Array<{ alias: string; expression: string }> {
  const aliases: Array<{ alias: string; expression: string }> = [];
  const columns = stmt.columns as unknown;
  if (!Array.isArray(columns)) return aliases;

  for (const col of columns) {
    if (col.as && col.expr) {
      try {
        const expr = parser.exprToSQL(col.expr as Parameters<typeof parser.exprToSQL>[0]);
        if (expr && col.as !== expr) {
          aliases.push({ alias: String(col.as).toLowerCase(), expression: expr });
        }
      } catch (err) { console.debug("extractAliases: failed to convert alias expression", err instanceof Error ? err.message : String(err)); }
    }
  }
  return aliases;
}

// ── Pattern normalization ──────────────────────────────────────────

/**
 * Normalize SQL for pattern deduplication.
 * Collapses whitespace, removes LIMIT/OFFSET, lowercases.
 */
function normalizeSQL(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")                    // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")            // strip block comments
    .replace(/\s+/g, " ")                        // collapse whitespace
    .replace(/\bLIMIT\s+\d+/gi, "")              // remove LIMIT
    .replace(/\bOFFSET\s+\d+/gi, "")             // remove OFFSET
    .trim()
    .toLowerCase();
}

/**
 * Generate a human-readable description for a query pattern.
 */
function describePattern(parsed: ParsedQuery): string {
  const parts: string[] = [];

  if (parsed.hasAggregation && parsed.hasGroupBy) {
    parts.push("Aggregation");
  } else if (parsed.hasAggregation) {
    parts.push("Summary");
  }

  if (parsed.joinPairs.length > 0) {
    const joinedTables = parsed.joinPairs.map((j) => j.to);
    parts.push(`joining ${joinedTables.join(", ")}`);
  }

  if (parsed.tables.length > 0) {
    parts.push(`on ${parsed.tables[0]}`);
  }

  return parts.length > 0 ? parts.join(" ") : "Query pattern";
}

// ── Main analysis ──────────────────────────────────────────────────

/** Minimum number of occurrences for a pattern to be proposed. */
const MIN_PATTERN_COUNT = 2;

/**
 * Analyze audit log entries and extract structural patterns.
 *
 * @param rows - Audit log rows (successful queries only).
 * @returns Aggregated analysis result.
 */
export function analyzeQueries(rows: AuditRow[]): AnalysisResult {
  const tableUsage = new Map<string, number>();
  const joinMap = new Map<string, ObservedJoin>();
  const patternMap = new Map<string, { sql: string; tables: string[]; count: number; parsed: ParsedQuery }>();
  const aliasMap = new Map<string, { expression: string; tables: Set<string>; count: number }>();

  for (const row of rows) {
    // Guard: skip rows with null/non-string sql (can arrive from corrupted audit log rows)
    if (!row.sql || typeof row.sql !== "string") {
      continue;
    }

    // Use pre-computed tables_accessed if available, otherwise parse
    let tables: string[] = Array.isArray(row.tables_accessed) ? row.tables_accessed : [];
    let parsed: ParsedQuery | null = null;

    if (tables.length === 0) {
      parsed = parseQuery(row.sql);
      if (!parsed) continue;
      tables = parsed.tables;
    }

    // Table usage
    for (const table of tables) {
      tableUsage.set(table, (tableUsage.get(table) ?? 0) + 1);
    }

    // Parse for detailed analysis if not already done
    if (!parsed) {
      parsed = parseQuery(row.sql);
    }
    if (!parsed) continue;

    // Join discovery
    for (const join of parsed.joinPairs) {
      const key = [join.from, join.to].sort().join("::");
      const existing = joinMap.get(key);
      if (existing) {
        existing.count++;
        if (!existing.onClause && join.on) {
          existing.onClause = join.on;
        }
      } else {
        joinMap.set(key, {
          fromTable: join.from,
          toTable: join.to,
          onClause: join.on,
          count: 1,
        });
      }
    }

    // Pattern extraction (normalize for dedup)
    const normalized = normalizeSQL(row.sql);
    const existing = patternMap.get(normalized);
    if (existing) {
      existing.count++;
    } else {
      patternMap.set(normalized, {
        sql: row.sql.replace(/\s+/g, " ").trim(),
        tables: parsed.tables,
        count: 1,
        parsed,
      });
    }

    // Alias extraction
    for (const alias of parsed.aliases) {
      const existing = aliasMap.get(alias.alias);
      if (existing) {
        existing.count++;
        for (const t of parsed.tables) existing.tables.add(t);
      } else {
        aliasMap.set(alias.alias, {
          expression: alias.expression,
          tables: new Set(parsed.tables),
          count: 1,
        });
      }
    }
  }

  // Filter patterns by frequency threshold
  const patterns: ObservedPattern[] = [];
  for (const [, entry] of patternMap) {
    if (entry.count >= MIN_PATTERN_COUNT) {
      patterns.push({
        sql: entry.sql,
        tables: entry.tables,
        count: entry.count,
        primaryTable: entry.tables[0] ?? "unknown",
        description: describePattern(entry.parsed),
      });
    }
  }
  patterns.sort((a, b) => b.count - a.count);

  // Filter aliases by frequency
  const aliases: ObservedAlias[] = [];
  for (const [alias, entry] of aliasMap) {
    if (entry.count >= MIN_PATTERN_COUNT) {
      aliases.push({
        alias,
        expression: entry.expression,
        tables: [...entry.tables],
        count: entry.count,
      });
    }
  }
  aliases.sort((a, b) => b.count - a.count);

  return {
    totalQueries: rows.length,
    tableUsage,
    joins: joinMap,
    patterns,
    aliases,
  };
}
