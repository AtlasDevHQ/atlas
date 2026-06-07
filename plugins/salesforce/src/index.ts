/**
 * Salesforce DataSource Plugin — wraps Salesforce SOQL access via jsforce.
 *
 * Unlike SQL-based datasources (ClickHouse, Snowflake, DuckDB), Salesforce
 * uses SOQL and has a custom validation pipeline (validateSOQL) instead of
 * the standard node-sql-parser-based SQL validation.
 *
 * Two registration modes:
 *
 * 1. Static config-defined datasource (self-host / operator-baked) — pass a
 *    `url` and the plugin wires a single connection at boot:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { salesforcePlugin } from "@useatlas/salesforce";
 *
 * export default defineConfig({
 *   plugins: [
 *     salesforcePlugin({ url: "salesforce://user:pass@login.salesforce.com?token=TOKEN" }),
 *   ],
 * });
 * ```
 *
 * 2. Adapter-only (SaaS per-workspace) — pass no `url` and the plugin registers
 *    purely as an adapter, so customers add their own Salesforce per workspace
 *    via Admin → Connections (DB-stored, encrypted). No operator env var, no
 *    static datasource:
 * ```typescript
 * export default defineConfig({
 *   plugins: [salesforcePlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginHealthResult, PluginLogger, QueryValidationResult } from "@useatlas/plugin-sdk";
import {
  createSalesforceConnection,
  parseSalesforceURL,
  extractHost,
} from "./connection";
import type { SalesforceConnection } from "./connection";
import { validateSOQLStructure } from "./validation";
import { createQuerySalesforceTool } from "./tool";

/**
 * Strict schema for a fully-specified Salesforce connection. A `url` is
 * required. Used by `connection.createFromConfig` to validate the decrypted
 * per-(workspace, install) config of a DB-stored datasource (which always
 * carries a url) before building the connection.
 */
const SalesforceConnectionConfigSchema = z.object({
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

/**
 * Lenient config-time schema — every field optional so the plugin can be
 * registered as an ADAPTER ONLY: `salesforcePlugin({})` parses, registering the
 * plugin so its `createFromConfig` is available to the datasource bridge for
 * DB-stored per-workspace installs (the SaaS model), with no static datasource.
 * A `url`, when supplied, is still validated for scheme + credentials.
 */
const SalesforceConfigSchema = SalesforceConnectionConfigSchema.partial();

export type SalesforcePluginConfig = z.infer<typeof SalesforceConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildSalesforcePlugin(
  config: SalesforcePluginConfig,
): AtlasDatasourcePlugin<SalesforcePluginConfig> {
  let cachedConn: SalesforceConnection | undefined;
  let log: PluginLogger | undefined;

  // When a static url is configured the plugin wires a config-defined
  // connection at boot; without one it is registered adapter-only. The url is
  // only parsed where present — never on the adapter-only build path.
  const staticUrl = config.url;
  const hasStaticConfig = !!staticUrl;

  /**
   * Cached singleton for the STATIC datasource — jsforce session is stateful,
   * so we reuse the connection. Only reachable when a static url is configured.
   */
  function getOrCreateConnection(): SalesforceConnection {
    if (!staticUrl) {
      throw new Error(
        "Salesforce datasource is adapter-only — no static connection. Use createFromConfig for per-workspace datasources.",
      );
    }
    if (!cachedConn) {
      cachedConn = createSalesforceConnection(parseSalesforceURL(staticUrl), log);
    }
    return cachedConn;
  }

  const connection: AtlasDatasourcePlugin<SalesforcePluginConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from
    // the per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      const parsed = SalesforceConnectionConfigSchema.parse(runtimeConfig);
      // Parse the runtime url here (never at build time) — surfaces parser
      // errors as a thrown error for the datasource bridge to handle.
      return createSalesforceConnection(parseSalesforceURL(parsed.url), log);
    },
    dbType: "salesforce",
    validate(query: string): QueryValidationResult {
      // Structural checks only (SELECT-only, no DML, no semicolons).
      // Object whitelist is applied in the querySalesforce tool which
      // has access to the semantic layer. Url-independent — present in both
      // static and adapter-only modes.
      const result = validateSOQLStructure(query);
      return {
        valid: result.valid,
        reason: result.error,
      };
    },
  };

  if (hasStaticConfig) {
    connection.create = () => getOrCreateConnection();
  }

  return {
    id: "salesforce-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Salesforce DataSource",
    config,

    connection,

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
      // Mode-aware: the dedicated `querySalesforce` tool is only registered in
      // static mode (see initialize). In adapter-only / SaaS per-workspace mode
      // the per-workspace connection is queried via `executeSQL`, routed through
      // the bridge-built connection that carries this plugin's SOQL `validate`.
      staticUrl
        ? "- Use `querySalesforce` tool (not `executeSQL`) for Salesforce queries."
        : "- Use `executeSQL` for Salesforce queries (per-workspace mode — the connection enforces SOQL validation).",
    ].join("\n"),

    async initialize(ctx) {
      log = ctx.logger;
      if (staticUrl) {
        ctx.logger.info(`Salesforce datasource plugin initialized (${extractHost(staticUrl)})`);
      } else {
        ctx.logger.info(
          "Salesforce datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }

      // Register the querySalesforce tool ONLY in static-datasource mode. The
      // tool is hardwired to the static connection (`getOrCreateConnection()` /
      // `connectionId: "salesforce"`), so in adapter-only mode it would throw on
      // every call. SaaS per-workspace Salesforce datasources are queried via
      // the standard `executeSQL` path, routed through the bridge-built
      // connection (which carries this plugin's SOQL `validate`).
      if (staticUrl) {
        const sfTool = createQuerySalesforceTool({
          getConnection: () => getOrCreateConnection(),
          getWhitelist: () => {
            try {
              const tables = ctx.connections.list();
              return new Set(tables);
            } catch (err) {
              ctx.logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "Failed to load Salesforce object whitelist — queries may be rejected",
              );
              return new Set<string>();
            }
          },
          connectionId: "salesforce",
          logger: ctx.logger,
        });

        ctx.tools.register({
          name: "querySalesforce",
          description: "Execute a read-only SOQL query against Salesforce",
          tool: sfTool,
        });
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!staticUrl) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
      const start = performance.now();
      try {
        const conn = getOrCreateConnection();
        let timer: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          conn.listObjects().then(() => "ok" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 5000);
          }),
        ]).finally(() => clearTimeout(timer!));
        const latencyMs = Math.round(performance.now() - start);
        if (result === "timeout") {
          return { healthy: false, message: "Health check timed out after 5000ms", latencyMs };
        }
        return { healthy: true, latencyMs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.warn(`Health check failed: ${message}`);
        return {
          healthy: false,
          message,
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },

    async teardown(): Promise<void> {
      if (cachedConn) {
        try {
          await cachedConn.close();
        } catch (err) {
          log?.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to close Salesforce connection during teardown",
          );
        }
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
 * // Static datasource (self-host):
 * plugins: [salesforcePlugin({ url: "salesforce://user:pass@login.salesforce.com?token=TOKEN" })]
 * // Adapter-only (SaaS — customers bring their own per workspace):
 * plugins: [salesforcePlugin({})]
 * ```
 */
export const salesforcePlugin = createPlugin({
  configSchema: SalesforceConfigSchema,
  create: buildSalesforcePlugin,
});

export { createSalesforceConnection, parseSalesforceURL, extractHost } from "./connection";
export type { SalesforceConfig, SalesforceConnection, SObjectInfo, SObjectField, SObjectDescribe } from "./connection";
export { validateSOQL, validateSOQLStructure, appendSOQLLimit, SOQL_FORBIDDEN_PATTERNS, SENSITIVE_PATTERNS } from "./validation";
export { createQuerySalesforceTool } from "./tool";
