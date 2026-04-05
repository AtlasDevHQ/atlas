/**
 * searchAuditLog tool — query audit log for patterns involving specific tables/columns.
 *
 * Queries the internal database (audit_log + learned_patterns tables).
 * Requires internal DB to be configured.
 */

import { tool } from "ai";
import { z } from "zod";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { connections } from "@atlas/api/lib/db/connection";

const log = createLogger("tool:search-audit-log");

export const searchAuditLog = tool({
  description:
    "Search the audit log for query patterns involving specific tables or columns. Returns normalized SQL patterns with frequency counts. Requires internal database (DATABASE_URL).",

  inputSchema: z.object({
    table: z
      .string()
      .optional()
      .describe("Filter by table name (matches tables_accessed JSONB array)"),
    column: z
      .string()
      .optional()
      .describe("Filter by column name (matches columns_accessed JSONB array)"),
    minCount: z
      .number()
      .optional()
      .describe("Minimum query count to include (default 1)"),
    since: z
      .string()
      .optional()
      .describe("Only include queries after this ISO date"),
  }),

  execute: async ({ table, column, minCount, since }) => {
    if (!hasInternalDB()) {
      return {
        error:
          "Internal database not configured. Set DATABASE_URL to enable audit log search.",
      };
    }

    try {
      // Org scoping
      const reqCtx = getRequestContext();
      const orgId = connections.isOrgPoolingEnabled()
        ? reqCtx?.user?.activeOrganizationId
        : undefined;

      const whereParts: string[] = ["success = true", "deleted_at IS NULL"];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (orgId) {
        params.push(orgId);
        whereParts.push(`org_id = $${paramIdx}`);
        paramIdx++;
      }

      if (table) {
        params.push(JSON.stringify([table]));
        whereParts.push(`tables_accessed @> $${paramIdx}::jsonb`);
        paramIdx++;
      }

      if (column) {
        params.push(JSON.stringify([column]));
        whereParts.push(`columns_accessed @> $${paramIdx}::jsonb`);
        paramIdx++;
      }

      if (since) {
        params.push(since);
        whereParts.push(`timestamp >= $${paramIdx}::timestamptz`);
        paramIdx++;
      }

      const threshold = minCount ?? 1;

      const sql = `
        SELECT
          sql AS normalized_sql,
          COUNT(*) AS count,
          MAX(timestamp) AS last_seen,
          tables_accessed
        FROM audit_log
        WHERE ${whereParts.join(" AND ")}
        GROUP BY sql, tables_accessed
        HAVING COUNT(*) >= ${threshold}
        ORDER BY COUNT(*) DESC
        LIMIT 50
      `;

      const rows = await internalQuery<{
        normalized_sql: string;
        count: string;
        last_seen: string;
        tables_accessed: string[] | string | null;
      }>(sql, params);

      // Look up pattern status from learned_patterns for each query
      const patterns = rows.map((row) => {
        let tables: string[] = [];
        try {
          if (typeof row.tables_accessed === "string") {
            tables = JSON.parse(row.tables_accessed) as string[];
          } else if (Array.isArray(row.tables_accessed)) {
            tables = row.tables_accessed;
          }
        } catch {
          // intentionally ignored: malformed tables_accessed JSON
        }

        return {
          normalizedSql:
            row.normalized_sql.length > 500
              ? row.normalized_sql.slice(0, 500) + "..."
              : row.normalized_sql,
          count: parseInt(String(row.count), 10),
          lastSeen: String(row.last_seen),
          tables,
          status: "not_tracked" as const,
        };
      });

      return { patterns };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), table, column },
        "searchAuditLog failed",
      );
      return {
        error: `Failed to search audit log: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
