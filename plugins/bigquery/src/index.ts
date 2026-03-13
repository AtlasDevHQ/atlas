/**
 * BigQuery DataSource Plugin for Atlas.
 *
 * Connects to Google BigQuery via the @google-cloud/bigquery client library.
 * Supports service account JSON key files, inline credentials objects, and
 * Application Default Credentials (ADC) for GCP-native environments.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { bigqueryPlugin } from "@useatlas/bigquery";
 *
 * export default defineConfig({
 *   plugins: [
 *     bigqueryPlugin({
 *       projectId: "my-gcp-project",
 *       keyFilename: "/path/to/service-account.json",
 *       dataset: "analytics",
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult, PluginLogger, PluginHooks, QueryHookContext, QueryHookMutation } from "@useatlas/plugin-sdk";
import {
  createBigQueryConnection,
  extractProjectId,
} from "./connection";
import { BIGQUERY_FORBIDDEN_PATTERNS } from "./validation";
import { estimateQueryCost, formatBytes } from "./cost-estimator";

const CostApprovalMode = z.enum(["auto", "always", "threshold"]);

const BigQueryConfigSchema = z.object({
  /** GCP project ID. When omitted, inferred from credentials or ADC. */
  projectId: z.string().optional(),
  /** Default dataset for unqualified table references. */
  dataset: z.string().optional(),
  /** Geographic location for query jobs (e.g. "US", "EU", "us-east1"). */
  location: z.string().optional(),
  /** Path to a service account JSON key file. */
  keyFilename: z.string().optional(),
  /** Service account credentials object (contents of the JSON key file). */
  credentials: z.record(z.string(), z.unknown()).optional(),
  /**
   * Cost approval mode for BigQuery queries.
   * - "auto": execute immediately, include cost metadata in the result
   * - "threshold" (default): auto-approve under costThreshold, require approval above
   * - "always": every query requires user approval with cost estimate
   */
  costApproval: CostApprovalMode.optional().default("threshold"),
  /** USD cost threshold for "threshold" mode. Queries above this require approval. Default $1.00. */
  costThreshold: z.number().optional().default(1.0),
});

/**
 * BigQuery config type. Uses `z.input` so both the `bigqueryPlugin()` factory
 * (which applies Zod defaults) and direct `buildBigQueryPlugin()` callers work
 * without requiring cost fields to be explicitly passed.
 */
export type BigQueryConfig = z.input<typeof BigQueryConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildBigQueryPlugin(
  config: BigQueryConfig,
): AtlasDatasourcePlugin<BigQueryConfig> {
  let log: PluginLogger | undefined;

  const costApproval = config.costApproval ?? "threshold";
  const costThreshold = config.costThreshold ?? 1.0;

  const hooks: PluginHooks = {
    beforeQuery: [
      {
        matcher: (ctx: QueryHookContext) => ctx.connectionId === "bigquery-datasource",
        handler: async (ctx: QueryHookContext): Promise<QueryHookMutation | void> => {
          const estimate = await estimateQueryCost(ctx.sql, config);

          if (!estimate) {
            log?.warn("BigQuery dry-run failed — proceeding without cost estimate");
            return;
          }

          const { bytesScanned, estimatedCostUsd } = estimate;
          const costStr = `$${estimatedCostUsd.toFixed(4)}`;
          const bytesStr = formatBytes(bytesScanned);

          // Attach cost metadata for the tool result
          if (ctx.metadata) {
            ctx.metadata.estimatedCostUsd = estimatedCostUsd;
            ctx.metadata.bytesScanned = bytesScanned;
          }

          if (costApproval === "auto") {
            return;
          }

          if (costApproval === "threshold" && estimatedCostUsd <= costThreshold) {
            return;
          }

          // Over threshold or "always" mode — reject with cost info
          throw new Error(
            `This query will scan ~${bytesStr} (~${costStr}). Approve to execute.`,
          );
        },
      },
    ],
  };

  return {
    id: "bigquery-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "BigQuery DataSource",
    config,

    connection: {
      create: () =>
        createBigQueryConnection({
          projectId: config.projectId,
          dataset: config.dataset,
          location: config.location,
          keyFilename: config.keyFilename,
          credentials: config.credentials,
          logger: log,
        }),
      dbType: "bigquery",
      parserDialect: "BigQuery",
      forbiddenPatterns: BIGQUERY_FORBIDDEN_PATTERNS,
    },

    entities: [],

    dialect: [
      "This datasource uses Google BigQuery Standard SQL.",
      "- Use backtick-quoted identifiers for table references: `project.dataset.table`.",
      "- Use DATE_TRUNC(date_expr, MONTH) for date truncation.",
      "- Use TIMESTAMP_TRUNC() for timestamps, DATETIME_TRUNC() for datetimes.",
      "- Use COUNTIF(condition) instead of COUNT(CASE WHEN ... END).",
      "- Use SAFE_DIVIDE(a, b) to avoid division-by-zero errors.",
      "- Use UNNEST(array_column) to flatten arrays (in FROM or JOIN clause).",
      "- Use FORMAT_DATE/FORMAT_TIMESTAMP for date formatting.",
      "- Use IFNULL(expr, default) or COALESCE() for null handling.",
      "- Use EXCEPT() and REPLACE() with SELECT * to exclude or transform columns.",
      "- Do not use Legacy SQL syntax — Standard SQL is the default.",
      "- When a cost estimate is available, mention it to the user.",
    ].join("\n"),

    hooks,

    async initialize(ctx) {
      log = ctx.logger;
      ctx.logger.info(`BigQuery datasource plugin initialized (project: ${extractProjectId(config)})`);
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createBigQueryConnection({
          projectId: config.projectId,
          dataset: config.dataset,
          keyFilename: config.keyFilename,
          credentials: config.credentials,
          location: config.location,
        });
        // SELECT 1 processes 0 bytes in BigQuery — effectively free.
        await conn.query("SELECT 1", 5000);
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
      } finally {
        if (conn) {
          await conn.close();
        }
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
 * plugins: [bigqueryPlugin({ projectId: "my-project", dataset: "analytics" })]
 * ```
 */
export const bigqueryPlugin = createPlugin({
  configSchema: BigQueryConfigSchema,
  create: buildBigQueryPlugin,
});

export { createBigQueryConnection, extractProjectId } from "./connection";
export { BIGQUERY_FORBIDDEN_PATTERNS } from "./validation";
export { estimateQueryCost, formatBytes } from "./cost-estimator";
export type { CostEstimate } from "./cost-estimator";
