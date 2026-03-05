/**
 * Salesforce SOQL query tool for the Atlas agent.
 *
 * Parallel to executeSQL but for Salesforce objects via SOQL.
 * Uses the SalesforceDataSource instead of DBConnection.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  getSalesforceSource,
  listSalesforceSources,
} from "@atlas/api/lib/db/salesforce";
import { validateSOQL, appendSOQLLimit } from "./soql-validation";
import { getWhitelistedTables } from "@atlas/api/lib/semantic";
import { logQueryAudit } from "@atlas/api/lib/auth/audit";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("salesforce-tool");

const ROW_LIMIT = parseInt(process.env.ATLAS_ROW_LIMIT ?? "1000", 10);
const QUERY_TIMEOUT = parseInt(
  process.env.ATLAS_QUERY_TIMEOUT ?? "30000",
  10,
);

export const querySalesforce = tool({
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
    connectionId: z
      .string()
      .optional()
      .describe(
        "Target Salesforce connection ID. Omit for the default Salesforce connection.",
      ),
  }),

  execute: async ({ soql, explanation, connectionId }) => {
    // Resolve which Salesforce source to use
    const sources = listSalesforceSources();
    const connId = connectionId ?? (sources.length > 0 ? sources[0] : "default");

    let source;
    try {
      source = getSalesforceSource(connId);
    } catch {
      return {
        success: false,
        error: `Salesforce source "${connId}" is not registered. Available: ${sources.join(", ") || "(none)"}`,
      };
    }

    // Get whitelist for this connection
    const allowed = getWhitelistedTables(connId);

    // Validate SOQL
    const validation = validateSOQL(soql, allowed);
    if (!validation.valid) {
      logQueryAudit({
        sql: soql.slice(0, 2000),
        durationMs: 0,
        rowCount: null,
        success: false,
        error: `Validation rejected: ${validation.error}`,
      });
      return { success: false, error: validation.error };
    }

    // Auto-append LIMIT
    const querySoql = appendSOQLLimit(soql.trim(), ROW_LIMIT);

    const start = performance.now();
    try {
      const result = await source.query(querySoql, QUERY_TIMEOUT);
      const durationMs = Math.round(performance.now() - start);
      const truncated = result.rows.length >= ROW_LIMIT;

      try {
        logQueryAudit({
          sql: querySoql,
          durationMs,
          rowCount: result.rows.length,
          success: true,
        });
      } catch (auditErr) {
        log.warn({ err: auditErr }, "Failed to write query audit log");
      }

      return {
        success: true,
        explanation,
        row_count: result.rows.length,
        columns: result.columns,
        rows: result.rows,
        truncated,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const message =
        err instanceof Error ? err.message : "Unknown Salesforce error";

      try {
        logQueryAudit({
          sql: querySoql,
          durationMs,
          rowCount: null,
          success: false,
          error: message,
        });
      } catch (auditErr) {
        log.warn({ err: auditErr }, "Failed to write query audit log");
      }

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
