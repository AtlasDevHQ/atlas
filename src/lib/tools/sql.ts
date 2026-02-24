/**
 * SQL execution tool with production-grade validation.
 *
 * Validation layers (in validateSQL):
 * 0. Empty check — reject empty/whitespace-only input
 * 1. Regex mutation guard — quick reject of DML/DDL keywords
 * 2. AST parse — node-sql-parser (PostgreSQL or SQLite mode, auto-detected), SELECT-only, single statement
 * 3. Table whitelist — only tables defined in the semantic layer (CTE names excluded)
 *
 * Applied during execution:
 * 4. Auto LIMIT — appended to every query (default 1000)
 * 5. Statement timeout — configurable per-query deadline
 */

import { tool } from "ai";
import { z } from "zod";
import { Parser } from "node-sql-parser";
import { getDB, detectDBType } from "@/lib/db/connection";
import { getWhitelistedTables } from "@/lib/semantic";

const parser = new Parser();

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
  /\b(GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\b(COPY|LOAD|VACUUM|REINDEX)\b/i,
  /\bINTO\s+OUTFILE\b/i,
  /\b(PRAGMA|ATTACH|DETACH)\b/i,
];

function parserDatabase(): "PostgresQL" | "Sqlite" {
  const dbType = detectDBType();
  switch (dbType) {
    case "sqlite": return "Sqlite";
    case "postgres": return "PostgresQL";
    default: {
      const _exhaustive: never = dbType;
      throw new Error(`Unknown database type: ${_exhaustive}`);
    }
  }
}

export function validateSQL(sql: string): { valid: boolean; error?: string } {
  // 0. Reject empty / whitespace-only input
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  // 1. Regex guard against mutation keywords
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Forbidden SQL operation detected: ${pattern.source}`,
      };
    }
  }

  // 2. AST validation — must be a single SELECT
  //
  // Security rationale: if the regex guard (layer 1) passed but the AST parser
  // cannot parse the query, we REJECT it rather than allowing it through.
  // A query that passes regex but confuses the parser could be a crafted bypass
  // attempt. The agent can always reformulate into standard SQL that parses.
  const cteNames = new Set<string>();
  try {
    const ast = parser.astify(trimmed, { database: parserDatabase() });
    const statements = Array.isArray(ast) ? ast : [ast];

    // Single-statement check — reject batched queries
    if (statements.length > 1) {
      return { valid: false, error: "Multiple statements are not allowed" };
    }

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
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    return {
      valid: false,
      error: `Query could not be parsed.${detail ? ` ${detail}.` : ""} Rewrite using standard SQL syntax.`,
    };
  }

  // 3. Table whitelist check
  if (process.env.ATLAS_TABLE_WHITELIST !== "false") {
    try {
      const tables = parser.tableList(trimmed, { database: parserDatabase() });
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
      // Table extraction uses the same parser that just succeeded in step 2.
      // If it fails here, reject to avoid bypassing the whitelist.
      return {
        valid: false,
        error: "Could not verify table permissions. Rewrite using standard SQL syntax.",
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
      const sensitivePatterns = /password|connection string|pg_hba\.conf|SSL|certificate|SQLITE_CANTOPEN|SQLITE_CORRUPT|SQLITE_IOERR|SQLITE_READONLY|SQLITE_FULL|database is locked|unable to open|\/[^\s]+\.db/i;
      if (sensitivePatterns.test(message)) {
        return { success: false, error: "Database query failed — check server logs for details." };
      }

      // Surface the full DB error to the agent for self-correction
      // (includes column-not-found, syntax, timeout, type mismatch, etc.)
      const dbErr = err as { hint?: string; position?: string };
      let detail = message;
      if (dbErr.hint) {
        detail += ` — Hint: ${dbErr.hint}`;
      }
      if (dbErr.position) {
        detail += ` (at character ${dbErr.position})`;
      }
      return { success: false, error: detail };
    }
  },
});
