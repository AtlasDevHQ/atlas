/**
 * Salesforce DataSource Plugin — wraps Salesforce SOQL access via jsforce.
 *
 * Unlike SQL-based datasources (ClickHouse, Snowflake, DuckDB), Salesforce
 * uses SOQL and has a custom validation pipeline (validateSOQL) instead of
 * the standard node-sql-parser-based SQL validation.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { salesforcePlugin } from "@atlas/plugin-salesforce-datasource";
 *
 * export default defineConfig({
 *   plugins: [
 *     salesforcePlugin({ url: "salesforce://user:pass@login.salesforce.com?token=TOKEN" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginHealthResult, QueryValidationResult } from "@useatlas/plugin-sdk";
import {
  createSalesforceConnection,
  parseSalesforceURL,
  extractHost,
} from "./connection";
import type { SalesforceConnection } from "./connection";
import { validateSOQL, SOQL_FORBIDDEN_PATTERNS } from "./validation";
import { createQuerySalesforceTool } from "./tool";

const SalesforceConfigSchema = z.object({
  /** Salesforce connection URL (salesforce://user:pass@login.salesforce.com?token=TOKEN). */
  url: z
    .string()
    .min(1, "Salesforce URL must not be empty")
    .refine(
      (u) => u.startsWith("salesforce://"),
      "URL must start with salesforce://",
    )
    .superRefine((u, ctx) => {
      try {
        parseSalesforceURL(u);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});

export type SalesforcePluginConfig = z.infer<typeof SalesforceConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildSalesforcePlugin(
  config: SalesforcePluginConfig,
): AtlasDatasourcePlugin<SalesforcePluginConfig> {
  const sfConfig = parseSalesforceURL(config.url);
  let cachedConn: SalesforceConnection | undefined;

  function getOrCreateConnection(): SalesforceConnection {
    if (!cachedConn) {
      cachedConn = createSalesforceConnection(sfConfig);
    }
    return cachedConn;
  }

  return {
    id: "salesforce-datasource",
    type: "datasource" as const,
    version: "0.1.0",
    name: "Salesforce DataSource",
    config,

    connection: {
      create: () => getOrCreateConnection(),
      dbType: "salesforce",
      validate(query: string): QueryValidationResult {
        // Use an empty whitelist here — the actual whitelist is applied
        // in the querySalesforce tool which has access to the semantic layer.
        // This validator handles the structural checks (SELECT-only, no DML).
        const result = validateSOQL(query, new Set(["*"]));
        return {
          valid: result.valid,
          reason: result.error,
        };
      },
    },

    entities: [],

    dialect: [
      "This datasource uses Salesforce SOQL (Salesforce Object Query Language).",
      "- SOQL is NOT SQL — it queries Salesforce objects, not database tables.",
      "- No JOINs — use relationship queries instead (e.g. `SELECT Account.Name FROM Contact`).",
      "- Parent-to-child: subquery in SELECT (e.g. `SELECT Id, (SELECT LastName FROM Contacts) FROM Account`).",
      "- Child-to-parent: dot notation (e.g. `SELECT Account.Name FROM Contact`).",
      "- Aggregate functions: COUNT(), SUM(), AVG(), MIN(), MAX(), COUNT_DISTINCT().",
      "- GROUP BY and HAVING are supported.",
      "- Use LIMIT to restrict result sets.",
      "- Date literals: YESTERDAY, TODAY, LAST_WEEK, THIS_MONTH, LAST_N_DAYS:n, etc.",
      "- No wildcards in field lists — always list specific fields (no `SELECT *`).",
      "- Use `querySalesforce` tool (not `executeSQL`) for Salesforce queries.",
    ].join("\n"),

    async initialize(ctx) {
      ctx.logger.info(`Salesforce datasource plugin initialized (${extractHost(config.url)})`);

      // Register the querySalesforce tool
      const sfTool = createQuerySalesforceTool({
        getConnection: () => getOrCreateConnection(),
        getWhitelist: () => {
          // Build whitelist from the semantic layer entities registered for this connection
          try {
            const tables = ctx.connections.list();
            // Return a permissive set — the whitelist is populated by the semantic layer
            return new Set(tables);
          } catch {
            return new Set<string>();
          }
        },
        connectionId: "salesforce",
      });

      ctx.tools.register({
        name: "querySalesforce",
        description: "Execute a read-only SOQL query against Salesforce",
        tool: sfTool,
      });
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      try {
        const conn = getOrCreateConnection();
        await conn.listObjects();
        return {
          healthy: true,
          latencyMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },

    async teardown(): Promise<void> {
      if (cachedConn) {
        await cachedConn.close();
        cachedConn = undefined;
      }
    },
  };
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * Validates config via Zod at call time, then builds the plugin.
 *
 * @example
 * ```typescript
 * plugins: [salesforcePlugin({ url: "salesforce://user:pass@login.salesforce.com?token=TOKEN" })]
 * ```
 */
export const salesforcePlugin = createPlugin({
  configSchema: SalesforceConfigSchema,
  create: buildSalesforcePlugin,
});

export { createSalesforceConnection, parseSalesforceURL, extractHost } from "./connection";
export type { SalesforceConfig, SalesforceConnection, SObjectInfo, SObjectField, SObjectDescribe } from "./connection";
export { validateSOQL, appendSOQLLimit, SOQL_FORBIDDEN_PATTERNS } from "./validation";
export { createQuerySalesforceTool } from "./tool";
