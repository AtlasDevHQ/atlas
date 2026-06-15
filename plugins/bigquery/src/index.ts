/**
 * BigQuery DataSource Plugin for Atlas.
 *
 * Connects to Google BigQuery via the @google-cloud/bigquery client library.
 * Supports service account JSON key files, inline credentials objects, and
 * Application Default Credentials (ADC) for GCP-native environments.
 *
 * Two registration modes:
 *
 * 1. Static config-defined datasource (self-host / operator-baked) — pass a
 *    `projectId` and the plugin wires a single connection at boot:
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
 *
 * 2. Adapter-only (SaaS per-workspace) — pass no `projectId` and the plugin
 *    registers purely as an adapter, so customers add their own BigQuery
 *    project per workspace via Admin → Connections (DB-stored, encrypted). No
 *    operator config, no static datasource:
 * ```typescript
 * export default defineConfig({
 *   plugins: [bigqueryPlugin({})],
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
import { listBigQueryObjects, profileBigQuery } from "./profiler";
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
 * Strict runtime schema for a DB-stored (admin-UI-registered) BigQuery
 * datasource install. The config-time {@link BigQueryConfigSchema} leaves
 * `projectId` optional so the plugin can register as an ADAPTER ONLY
 * (`bigqueryPlugin({})` parses), but a per-(workspace, install) datasource
 * must identify a concrete project — credentials may still come from a
 * keyFilename, inline credentials, or ADC, but the project is mandatory.
 * Used by `connection.createFromConfig` so a runtime config missing
 * `projectId` is REJECTED.
 */
const BigQueryRuntimeConfigSchema = BigQueryConfigSchema.extend({
  projectId: z.string().min(1, "BigQuery projectId must not be empty"),
});

/**
 * Normalize a DB-stored BigQuery datasource config into the connection factory's
 * field shape. The Admin → Connections catalog form
 * (`seed-builtin-datasource-catalog.ts`) collects `service_account_json` (the raw
 * key JSON, as a string) + `project_id` (snake_case); the connection factory and
 * {@link BigQueryRuntimeConfigSchema} use `credentials` (object) + `projectId`
 * (camelCase). Map the form shape onto the factory shape WITHOUT clobbering
 * explicit camelCase values (so a programmatic `createFromConfig` caller passing
 * `projectId`/`credentials` directly still works). Without this, every
 * admin-installed BigQuery datasource would be rejected by the runtime schema
 * (missing `projectId`) and never register as a live connection.
 */
function normalizeBigQueryRuntimeConfig(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (out.projectId === undefined && typeof out.project_id === "string") {
    out.projectId = out.project_id;
  }
  if (
    out.credentials === undefined &&
    out.keyFilename === undefined &&
    typeof out.service_account_json === "string" &&
    out.service_account_json.trim().length > 0
  ) {
    try {
      out.credentials = JSON.parse(out.service_account_json);
    } catch (err) {
      throw new Error(
        `BigQuery service_account_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return out;
}

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

  // A static config-defined BigQuery datasource is identified by ANY connection
  // field: an explicit projectId, a keyFilename, or inline credentials. Unlike
  // the url-based datasources, BigQuery can run static with NO projectId — the
  // project is inferred from the key/credentials or Application Default
  // Credentials (createBigQueryConnection omits projectId in that case). Only
  // when none of these is present does the plugin register adapter-only (SaaS
  // per-workspace — datasources are DB-stored, added via Admin → Connections).
  const hasStaticConfig = !!(config.projectId || config.keyFilename || config.credentials);

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

  const connection: AtlasDatasourcePlugin<BigQueryConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from the
    // per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict runtime schema (projectId required).
    // Always available — this is the SaaS per-workspace path and the only path
    // in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      // Normalize the catalog form's snake_case / service_account_json shape onto
      // the factory's camelCase / credentials shape before validating.
      const parsed = BigQueryRuntimeConfigSchema.parse(
        normalizeBigQueryRuntimeConfig(runtimeConfig),
      );
      return createBigQueryConnection({
        projectId: parsed.projectId,
        dataset: parsed.dataset,
        location: parsed.location,
        keyFilename: parsed.keyFilename,
        credentials: parsed.credentials,
        logger: log,
      });
    },
    dbType: "bigquery",
    parserDialect: "BigQuery",
    forbiddenPatterns: BIGQUERY_FORBIDDEN_PATTERNS,
    // Introspection half of the datasource contract (ADR-0017). The host
    // resolves `profile` off the registry (same predicate as `createFromConfig`)
    // and feeds it into SemanticGenerator's profiler seam; the CLI consumes
    // these exports directly. Both run read-only and never full-scan a table —
    // structure/row-counts come from INFORMATION_SCHEMA metadata, sampling is
    // LIMIT-bounded (BigQuery bills by bytes scanned).
    listObjects: listBigQueryObjects,
    profile: profileBigQuery,
  };

  // When any static connection field is configured the plugin wires a
  // config-defined connection at boot; without one it is registered adapter-only.
  // `config.projectId` may be undefined here (key/credentials/ADC supply it) —
  // createBigQueryConnection handles an absent projectId.
  if (hasStaticConfig) {
    connection.create = () =>
      createBigQueryConnection({
        projectId: config.projectId,
        dataset: config.dataset,
        location: config.location,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
        logger: log,
      });
  }

  return {
    id: "bigquery-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "BigQuery DataSource",
    config,

    connection,

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
      if (hasStaticConfig) {
        ctx.logger.info(`BigQuery datasource plugin initialized (project: ${extractProjectId(config)})`);
      } else {
        ctx.logger.info(
          "BigQuery datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!hasStaticConfig) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
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
 * // Static datasource (self-host):
 * plugins: [bigqueryPlugin({ projectId: "my-project", dataset: "analytics" })]
 * // Adapter-only (SaaS — customers bring their own per workspace):
 * plugins: [bigqueryPlugin({})]
 * ```
 */
export const bigqueryPlugin = createPlugin({
  configSchema: BigQueryConfigSchema,
  create: buildBigQueryPlugin,
});

export { createBigQueryConnection, extractProjectId, parseBigQueryUrl } from "./connection";
export type { BigQueryConnectionConfig } from "./connection";
export { listBigQueryObjects, profileBigQuery } from "./profiler";
export { BIGQUERY_FORBIDDEN_PATTERNS } from "./validation";
export { estimateQueryCost, formatBytes, _resetCachedClient } from "./cost-estimator";
export type { CostEstimate } from "./cost-estimator";
