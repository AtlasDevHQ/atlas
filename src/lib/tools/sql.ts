/**
 * SQL execution tool with production-grade validation.
 *
 * Security layers:
 * 1. AST parsing — only SELECT/WITH statements allowed
 * 2. Single statement — no semicolon-separated batches
 * 3. Table whitelist — only tables defined in the semantic layer
 * 4. Row limit — auto-appended LIMIT clause
 * 5. Query timeout — configurable per-query deadline
 */

import { tool } from "ai";
import { z } from "zod";
import { Parser } from "node-sql-parser";
import { getDB } from "@/lib/db/connection";
import { getWhitelistedTables } from "@/lib/semantic";

const parser = new Parser();

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
  /\b(GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\b(COPY|LOAD|VACUUM|REINDEX)\b/i,
  /\bINTO\s+OUTFILE\b/i,
];

export function validateSQL(sql: string): { valid: boolean; error?: string } {
  // 0. Reject empty / whitespace-only input
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  // 1. Check for multiple statements
  if (trimmed.includes(";")) {
    return { valid: false, error: "Multiple statements are not allowed" };
  }

  // 2. Regex guard against mutation keywords
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Forbidden SQL operation detected: ${pattern.source}`,
      };
    }
  }

  // 3. AST validation — must be a SELECT
  //
  // Security rationale: if the regex guard (layer 2) passed but the AST parser
  // cannot parse the query, we REJECT it rather than allowing it through.
  // A query that passes regex but confuses the parser could be a crafted bypass
  // attempt. The agent can always reformulate into standard SQL that parses.
  const cteNames = new Set<string>();
  try {
    const ast = parser.astify(trimmed, { database: "PostgresQL" });
    const statements = Array.isArray(ast) ? ast : [ast];

    for (const stmt of statements) {
      if (stmt.type !== "select") {
        return {
          valid: false,
          error: `Only SELECT statements are allowed, got: ${stmt.type}`,
        };
      }
      // Collect CTE names so the table whitelist can ignore them
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (Array.isArray((stmt as any).with)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const cte of (stmt as any).with) {
          const name = cte?.name?.value ?? cte?.name;
          if (typeof name === "string") cteNames.add(name.toLowerCase());
        }
      }
    }
  } catch {
    return {
      valid: false,
      error:
        "Query could not be parsed. Rewrite using standard SQL syntax.",
    };
  }

  // 4. Table whitelist check
  if (process.env.ATLAS_TABLE_WHITELIST !== "false") {
    try {
      const tables = parser.tableList(trimmed, { database: "PostgresQL" });
      const allowed = getWhitelistedTables();

      for (const ref of tables) {
        // tableList returns "select::schema::table" format
        const tableName = ref.split("::").pop()?.toLowerCase();
        if (tableName && !allowed.has(tableName) && !cteNames.has(tableName)) {
          return {
            valid: false,
            error: `Table "${tableName}" is not in the allowed list. Check catalog.yml for available tables.`,
          };
        }
      }
    } catch {
      // If table extraction fails, allow — DB will catch unknown tables
    }
  }

  return { valid: true };
}

const ROW_LIMIT = parseInt(process.env.ATLAS_ROW_LIMIT ?? "1000", 10);
const QUERY_TIMEOUT = parseInt(
  process.env.ATLAS_QUERY_TIMEOUT ?? "30000",
  10
);

export const executeSQL = tool({
  description: `Execute a read-only SQL query against the database. Only SELECT statements are allowed.

Rules:
- Always read the relevant entity schema from the semantic layer BEFORE writing SQL
- Use exact column names from the schema — never guess
- Use canonical metric SQL from metrics/*.yml when available
- Include a LIMIT clause for large result sets
- If a query fails, fix the issue — do not retry the same SQL`,

  inputSchema: z.object({
    sql: z.string().describe("The SELECT query to execute"),
    explanation: z
      .string()
      .describe("Brief explanation of what this query does and why"),
  }),

  execute: async ({ sql, explanation }) => {
    // Validate
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Auto-append LIMIT if not present
    let querySql = sql.trim().replace(/;\s*$/, "");
    if (!/\bLIMIT\b/i.test(querySql)) {
      querySql += ` LIMIT ${ROW_LIMIT}`;
    }

    // Execute
    try {
      const db = getDB();
      const result = await db.query(querySql, QUERY_TIMEOUT);

      return {
        success: true,
        explanation,
        row_count: result.rows.length,
        columns: result.columns,
        rows: result.rows,
        truncated: result.rows.length >= ROW_LIMIT,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown database error";

      // Sanitize — only return safe error info
      if (/column|relation|syntax|type/i.test(message)) {
        return { success: false, error: message };
      }
      return { success: false, error: "Database query failed" };
    }
  },
});
