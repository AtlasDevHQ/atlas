/**
 * profileTable tool — get column cardinality, nulls, distributions, and sample values.
 *
 * Delegates to the enhanced profiler. Subject to the same table whitelist as executeSQL.
 */

import { tool } from "ai";
import { z } from "zod";
import { connections, getDB, isConnectionVisibleInMode } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables } from "@atlas/api/lib/semantic";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";

const log = createLogger("tool:profile-table");

export const profileTable = tool({
  description: "Profile a table to get column cardinality, null rates, data types, and sample values. Only tables in the semantic layer can be profiled.",

  inputSchema: z.object({
    table: z.string().describe("Table name to profile"),
    columns: z
      .array(z.string())
      .optional()
      .describe("Specific columns to profile (omit for all columns)"),
    connectionId: z
      .string()
      .optional()
      .describe("Target connection ID (omit for default)"),
  }),

  execute: async ({ table, columns, connectionId }) => {
    const connId = connectionId ?? "default";

    try {
      // Whitelist + mode visibility check
      const reqCtx = getRequestContext();
      const atlasMode = reqCtx?.atlasMode ?? "published";
      const authOrgId = reqCtx?.user?.activeOrganizationId;
      const poolOrgId = connections.isOrgPoolingEnabled() ? authOrgId : undefined;

      // Mode isolation: reject non-visible connections before touching pools.
      // Mirrors the gate in executeSQL.
      if (authOrgId) {
        const visible = await isConnectionVisibleInMode(authOrgId, connId, atlasMode);
        if (!visible) {
          return {
            error: `Connection "${connId}" is not available in ${atlasMode} mode.`,
          };
        }
      }

      const whitelist = authOrgId
        ? getOrgWhitelistedTables(authOrgId, connId, atlasMode)
        : getWhitelistedTables(connId);

      if (!whitelist.has(table.toLowerCase())) {
        return {
          error: `Table "${table}" is not in the semantic layer whitelist. Only tables defined in entity YAML files can be profiled.`,
        };
      }

      // Get connection info
      const db = poolOrgId
        ? connections.getForOrg(poolOrgId, connId)
        : connId === "default"
          ? getDB()
          : connections.get(connId);

      const dbType = connections.getDBType(connId);

      // Profile using direct SQL queries through the connection
      const rowCountResult = await db.query(
        `SELECT COUNT(*) AS cnt FROM ${quoteIdent(table)}`,
        30000,
      );
      const rowCount = parseInt(String(rowCountResult.rows[0]?.cnt ?? "0"), 10);

      // Get column info (table name is whitelist-verified above, escape for defense-in-depth)
      const safeTable = escapeLiteral(table);
      const columnInfoSql = dbType === "mysql"
        ? `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ${safeTable} ORDER BY ordinal_position`
        : `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ${safeTable} AND table_schema = 'public' ORDER BY ordinal_position`;

      const colInfoResult = await db.query(columnInfoSql, 30000);
      const allColumns = colInfoResult.rows as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>;

      // Filter to requested columns if specified
      const targetColumns = columns
        ? allColumns.filter((c) => columns.includes(c.column_name))
        : allColumns;

      // Profile each column
      const profiledColumns = await Promise.all(
        targetColumns.map(async (col) => {
          try {
            const colName = quoteIdent(col.column_name);
            const tableName = quoteIdent(table);

            // Combined query: distinct count, null count, min, max
            const textCast = dbType === "mysql" ? `CAST(${colName} AS CHAR)` : `${colName}::text`;
            const statsResult = await db.query(
              `SELECT COUNT(DISTINCT ${colName}) AS distinct_count, SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count, MIN(${textCast}) AS min_val, MAX(${textCast}) AS max_val FROM ${tableName}`,
              30000,
            );
            const stats = statsResult.rows[0] ?? {};

            // Top values
            const topResult = await db.query(
              `SELECT ${textCast} AS val, COUNT(*) AS cnt FROM ${tableName} WHERE ${colName} IS NOT NULL GROUP BY ${colName} ORDER BY cnt DESC LIMIT 10`,
              30000,
            );

            const distinctCount = parseInt(String(stats.distinct_count ?? "0"), 10);
            const nullCount = parseInt(String(stats.null_count ?? "0"), 10);

            return {
              name: col.column_name,
              sqlType: col.data_type,
              nullRate: rowCount > 0 ? nullCount / rowCount : 0,
              distinctCount,
              topValues: (topResult.rows as Array<{ val: string; cnt: string | number }>).map((r) => ({
                value: String(r.val),
                count: parseInt(String(r.cnt), 10),
              })),
              minValue: stats.min_val != null ? String(stats.min_val) : undefined,
              maxValue: stats.max_val != null ? String(stats.max_val) : undefined,
            };
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err), column: col.column_name, table },
              "Failed to profile column",
            );
            return {
              name: col.column_name,
              sqlType: col.data_type,
              nullRate: null,
              distinctCount: null,
              topValues: [],
              error: `Failed to profile: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }),
      );

      return { rowCount, columns: profiledColumns };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), table },
        "profileTable failed",
      );
      return {
        error: `Failed to profile table "${table}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

function quoteIdent(name: string): string {
  // Simple identifier quoting — prevents SQL injection in column/table names
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeLiteral(value: string): string {
  // Escape single quotes for use in SQL string literals
  return `'${value.replace(/'/g, "''")}'`;
}
