/**
 * SQL execution tool with production-grade validation.
 *
 * Security layers:
 * 1. Single-statement check — no semicolon-separated batches
 * 2. Regex mutation guard — quick reject of DML/DDL keywords
 * 3. AST parsing — only SELECT/WITH statements allowed
 * 4. Table whitelist — only tables defined in the semantic layer
 * 5. Row limit — auto-appended LIMIT clause
 * 6. Query timeout — configurable per-query deadline
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
  // Security: if the parser fails, we REJECT the query. A crafted query that
  // confuses the parser must not bypass the SELECT-only check.
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
    return {
      valid: false,
      error: "Could not parse the SQL statement. Check the syntax and try again.",
    };
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
      // Table extraction uses the same parser that just succeeded in step 3.
      // If it fails here, reject to avoid bypassing the whitelist.
      return {
        valid: false,
        error: "Could not validate table references. Simplify the query and try again.",
      };
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
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Auto-append LIMIT if not present
    let querySql = sql.trim().replace(/;\s*$/, "");
    if (!/\bLIMIT\b/i.test(querySql)) {
      querySql += ` LIMIT ${ROW_LIMIT}`;
    }

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

      console.error("[atlas] SQL execution failed:", message);

      // Block errors that might expose connection details or internal state
      if (/password|connection string|pg_hba\.conf|SSL|certificate/i.test(message)) {
        return { success: false, error: "Database query failed — check server logs for details." };
      }

      // Surface the full Postgres error to the agent for self-correction
      // (includes column-not-found, syntax, timeout, type mismatch, etc.)
      const pgErr = err as { hint?: string; position?: string };
      let detail = message;
      if (pgErr.hint) {
        detail += ` — Hint: ${pgErr.hint}`;
      }
      if (pgErr.position) {
        detail += ` (at character ${pgErr.position})`;
      }
      return { success: false, error: detail };
    }
  },
});
