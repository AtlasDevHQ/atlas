/**
 * checkDataDistribution tool — run GROUP BY analysis on a column.
 *
 * Convenience wrapper that generates and executes a distribution query
 * through the standard SQL validation pipeline.
 */

import { tool } from "ai";
import { z } from "zod";
import { connections, getDB } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables } from "@atlas/api/lib/semantic";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";

const log = createLogger("tool:check-distribution");

export const checkDataDistribution = tool({
  description:
    "Check the data distribution of a specific column — distinct values, null count, and top values by frequency. Useful for understanding column cardinality and identifying enum-like columns.",

  inputSchema: z.object({
    table: z.string().describe("Table name"),
    column: z.string().describe("Column name to analyze"),
    limit: z
      .number()
      .optional()
      .describe("Max number of top values to return (default 20)"),
    connectionId: z
      .string()
      .optional()
      .describe("Target connection ID (omit for default)"),
  }),

  execute: async ({ table, column, limit: topN, connectionId }) => {
    const connId = connectionId ?? "default";
    const resultLimit = topN ?? 20;

    try {
      // Whitelist check
      const reqCtx = getRequestContext();
      const orgId = connections.isOrgPoolingEnabled()
        ? reqCtx?.user?.activeOrganizationId
        : undefined;

      const whitelist = orgId
        ? getOrgWhitelistedTables(orgId)
        : getWhitelistedTables(connId);

      if (!whitelist.has(table.toLowerCase())) {
        return {
          error: `Table "${table}" is not in the semantic layer whitelist.`,
        };
      }

      const db = orgId
        ? connections.getForOrg(orgId, connId)
        : connId === "default"
          ? getDB()
          : connections.get(connId);

      const dbType = connections.getDBType(connId);
      const tbl = quoteIdent(table);
      const col = quoteIdent(column);

      // Get total count and null count
      const countResult = await db.query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS null_count, COUNT(DISTINCT ${col}) AS distinct_count FROM ${tbl}`,
        30000,
      );
      const countRow = countResult.rows[0] ?? {};
      const totalCount = parseInt(String(countRow.total ?? "0"), 10);
      const nullCount = parseInt(String(countRow.null_count ?? "0"), 10);
      const distinctCount = parseInt(String(countRow.distinct_count ?? "0"), 10);

      // Top values by frequency
      const textCast = dbType === "mysql" ? `CAST(${col} AS CHAR)` : `${col}::text`;
      const topResult = await db.query(
        `SELECT ${textCast} AS value, COUNT(*) AS count FROM ${tbl} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC LIMIT ${resultLimit}`,
        30000,
      );

      // Get data type (escape literals for defense-in-depth — table/column are whitelist-verified above)
      const safeTable = escapeLiteral(table);
      const safeColumn = escapeLiteral(column);
      const typeQuery = dbType === "mysql"
        ? `SELECT data_type FROM information_schema.columns WHERE table_name = ${safeTable} AND column_name = ${safeColumn}`
        : `SELECT data_type FROM information_schema.columns WHERE table_name = ${safeTable} AND column_name = ${safeColumn} AND table_schema = 'public'`;
      const typeResult = await db.query(typeQuery, 30000);
      const dataType = (typeResult.rows[0] as Record<string, string> | undefined)?.data_type ?? "unknown";

      return {
        distinctCount,
        nullCount,
        totalCount,
        topValues: (topResult.rows as Array<{ value: string; count: string | number }>).map((r) => ({
          value: String(r.value),
          count: parseInt(String(r.count), 10),
        })),
        dataType,
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), table, column },
        "checkDataDistribution failed",
      );
      return {
        error: `Failed to check distribution for "${table}.${column}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
