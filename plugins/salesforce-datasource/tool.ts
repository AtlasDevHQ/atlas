/**
 * Salesforce SOQL query tool for the Atlas agent.
 *
 * Registered via the plugin's initialize() method into the tool registry.
 * Uses the PluginDBConnection from the connection registry instead of a
 * parallel Salesforce registry.
 */

import { tool } from "ai";
import { z } from "zod";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { validateSOQL, appendSOQLLimit, SENSITIVE_PATTERNS } from "./validation";

const ROW_LIMIT = parseInt(process.env.ATLAS_ROW_LIMIT ?? "1000", 10);
const QUERY_TIMEOUT = parseInt(
  process.env.ATLAS_QUERY_TIMEOUT ?? "30000",
  10,
);

/**
 * Create the querySalesforce AI SDK tool.
 *
 * Takes a query function and whitelist supplier so the tool is decoupled
 * from global registries — everything is injected by the plugin.
 */
export function createQuerySalesforceTool(opts: {
  getConnection: () => { query(soql: string, timeoutMs?: number): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> };
  getWhitelist: () => Set<string>;
  connectionId: string;
  logger?: PluginLogger;
}) {
  return tool({
    description: `Execute a read-only SOQL query against Salesforce. Only SELECT queries are allowed.

Rules:
- Always read the relevant entity schema from the semantic layer BEFORE writing SOQL
- Use exact field names from the schema — never guess
- SOQL does not support JOINs — use relationship queries instead (e.g. Account.Name)
- Include a LIMIT clause for large result sets
- If a query fails, fix the issue — do not retry the same SOQL`,

    inputSchema: z.object({
      soql: z.string().describe("The SELECT SOQL query to execute"),
      explanation: z
        .string()
        .describe("Brief explanation of what this query does and why"),
    }),

    execute: async ({ soql, explanation }) => {
      const conn = opts.getConnection();
      const allowed = opts.getWhitelist();

      // Validate SOQL
      const validation = validateSOQL(soql, allowed);
      if (!validation.valid) {
        opts.logger?.debug({ soql: soql.slice(0, 200), error: validation.error }, "SOQL validation rejected");
        return { success: false, error: validation.error };
      }

      // Auto-append LIMIT
      const querySoql = appendSOQLLimit(soql.trim(), ROW_LIMIT);

      const start = performance.now();
      try {
        const result = await conn.query(querySoql, QUERY_TIMEOUT);
        const durationMs = Math.round(performance.now() - start);
        const truncated = result.rows.length >= ROW_LIMIT;

        opts.logger?.debug({ durationMs, rowCount: result.rows.length }, "SOQL query executed");

        return {
          success: true,
          explanation,
          row_count: result.rows.length,
          columns: result.columns,
          rows: result.rows,
          truncated,
          durationMs,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        const message =
          err instanceof Error ? err.message : "Unknown Salesforce error";

        opts.logger?.warn({ durationMs, error: message }, "SOQL query failed");

        // Block errors that might expose connection details or internal state
        if (SENSITIVE_PATTERNS.test(message)) {
          return {
            success: false,
            error: "Salesforce query failed — check server logs for details.",
          };
        }

        return { success: false, error: message };
      }
    },
  });
}
