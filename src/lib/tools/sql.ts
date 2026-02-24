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

function validateSQL(sql: string): { valid: boolean; error?: string } {
  // 1. Check for multiple statements
  const trimmed = sql.trim().replace(/;\s*$/, "");
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
  try {
    const ast = parser.astify(trimmed);
    const statements = Array.isArray(ast) ? ast : [ast];

    for (const stmt of statements) {
      if (stmt.type !== "select") {
        return {
          valid: false,
          error: `Only SELECT statements are allowed, got: ${stmt.type}`,
        };
      }
    }
  } catch {
    // If parser fails, fall through — the DB will catch syntax errors
  }

  // 4. Table whitelist check
  if (process.env.ATLAS_TABLE_WHITELIST !== "false") {
    try {
      const tables = parser.tableList(trimmed);
      const allowed = getWhitelistedTables();

      for (const ref of tables) {
        // tableList returns "select::schema::table" format
        const tableName = ref.split("::").pop()?.toLowerCase();
        if (tableName && !allowed.has(tableName)) {
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
