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
 * 2. Adapter-only (`salesforcePlugin({})`) — pass no `url` and the plugin
 *    registers purely as an adapter exposing `createFromConfig`, modelling a
 *    credential-form (url-bearing) Salesforce datasource on the #3253 bridge.
 *
 *    DORMANT: per #3302 / ADR-0014, Atlas connects Salesforce via OAuth
 *    (`SalesforceOAuthInstallHandler` → tokens in `integration_credentials`,
 *    connection built from those tokens via the `LazyPluginLoader`), NOT via the
 *    datasource bridge. The bridge therefore intentionally SKIPS `salesforce`
 *    (`HANDLER_MANAGED_DATASOURCE_DBTYPES`), so this mode is not wired in any
 *    current Atlas deployment — `salesforcePlugin({})` is no longer registered
 *    in the deploy `atlas.config.ts` files. It is retained as an SDK seam should a
 *    future credential-form Salesforce-datasource path be desired (#3302 option
 *    a):
 * ```typescript
 * export default defineConfig({
 *   plugins: [salesforcePlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin, warnIfStructuralOnly } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginHealthResult, PluginLogger, QueryValidationResult } from "@useatlas/plugin-sdk";
import {
  createSalesforceConnection,
  parseSalesforceURL,
  extractHost,
} from "./connection";
import type { SalesforceConnection } from "./connection";
import { listSalesforceObjects, profileSalesforce } from "./profiler";
import { validateSOQLStructure } from "./validation";
import { createQuerySalesforceTool, SOQL_WHITELIST_SUBJECT } from "./tool";

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
 * plugin so its `createFromConfig` is exposed as a (DORMANT) credential-form
 * bridge seam, with no static datasource. Per #3302 / ADR-0014 the datasource
 * bridge SKIPS `salesforce` (Atlas uses OAuth — see the header), so this is not
 * the SaaS path and is unused in any current deployment; it's kept for a
 * possible future credential-form path. A `url`, when supplied, is still
 * validated for scheme + credentials.
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

  // The static connection registers in the ConnectionRegistry under this plugin
  // id (wiring.ts `registerDirect(plugin.id, …)`), which is also the
  // connectionId the semantic-layer whitelist (`getWhitelistedTables`) keys on.
  // The querySalesforce tool's object whitelist must use the same id.
  const DATASOURCE_ID = "salesforce-datasource";

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
    // Credential-form (url-bearing) datasource seam: build a connection from a
    // per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. DORMANT — the datasource bridge
    // skips `salesforce` (Atlas uses OAuth instead; see the header + ADR-0014),
    // so no Atlas deployment currently routes here. Kept for a future
    // credential-form path (#3302 option a) and self-host wiring.
    createFromConfig: (runtimeConfig) => {
      const parsed = SalesforceConnectionConfigSchema.parse(runtimeConfig);
      // Parse the runtime url here (never at build time) — surfaces parser
      // errors as a thrown error for the datasource bridge to handle.
      const built = createSalesforceConnection(parseSalesforceURL(parsed.url), log);
      // #3667 — introspection is a capability OF the built connection, bound to
      // the `salesforce://` creds that built it (the host's unified resolver
      // consumes these; no url/config re-resolution). Read-only (describe + a
      // bounded COUNT(Id) SELECT, no DML). NOTE: this credential-form path is
      // DORMANT for Atlas (the bridge skips salesforce → OAuth, ADR-0014); the
      // OAuth path exposes its own introspection via the LazyPluginLoader. This
      // serves the CLI's `atlas init` salesforce:// url + future self-host wiring.
      return {
        ...built,
        listObjects: (o) =>
          listSalesforceObjects({ url: parsed.url, ...(o?.schema !== undefined ? { schema: o.schema } : {}) }),
        profile: (o) =>
          profileSalesforce({
            url: parsed.url,
            ...(o?.schema !== undefined ? { schema: o.schema } : {}),
            selectedTables: o?.selectedTables,
            prefetchedObjects: o?.prefetchedObjects,
            progress: o?.progress,
            logger: o?.logger,
          }),
      };
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
    // Introspection (listObjects / profile) is a capability of the BUILT
    // connection (createFromConfig above), bound to the salesforce:// creds that
    // built it — the one home MCP, the wizard, and the CLI all consume (ADR-0017
    // / #3670). Atlas's Salesforce stays on OAuth (ADR-0014; the LazyPluginLoader
    // exposes its own introspection). No connection-namespace profiler exports.
  };

  if (hasStaticConfig) {
    connection.create = () => getOrCreateConnection();
  }

  return {
    id: DATASOURCE_ID,
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
      // static mode (see initialize). The adapter-only branch below describes
      // the DORMANT credential-form bridge path (#3302 option a / ADR-0014);
      // because the bridge skips `salesforce`, it is unreachable in any current
      // Atlas deployment. SaaS per-workspace Salesforce is OAuth-installed and
      // its connection is built via the `LazyPluginLoader` from the OAuth
      // tokens — not `executeSQL` through this adapter.
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
      // every call. SaaS per-workspace Salesforce is NOT served by this plugin
      // registration at all — it installs via OAuth and its connection is built
      // per workspace by the `LazyPluginLoader` from the OAuth session (see
      // integrations/salesforce/lazy-builder.ts).
      if (staticUrl) {
        const sfTool = createQuerySalesforceTool({
          getConnection: () => getOrCreateConnection(),
          // The object MEMBERSHIP whitelist is the semantic layer's object names
          // for this connection — `ctx.connections.tables(id)`, the same source
          // the SQL pipeline validates against in self-host/static mode (#3307).
          // `ctx.connections.list()` would be wrong: it returns CONNECTION IDs,
          // never object names like "Account", so validateSOQL would reject
          // every legitimate query. Empty-layer (structural-only) vs
          // scan-failure (fail-closed) handling (#3243/#3313) is owned by the
          // SDK's `gateOnSemanticWhitelist` inside the tool, which also builds the Set.
          getWhitelist: () => ctx.connections.tables(DATASOURCE_ID),
          logger: ctx.logger,
        });

        ctx.tools.register({
          name: "querySalesforce",
          description: "Execute a read-only SOQL query against Salesforce",
          tool: sfTool,
        });

        // One-time operator signal (#3313): empty whitelist → STRUCTURAL-ONLY
        // warning; scan failure → fail-closed-until-recovery warning. The
        // policy and copy live in the SDK's semantic-whitelist module.
        warnIfStructuralOnly(
          SOQL_WHITELIST_SUBJECT,
          () => ctx.connections.tables(DATASOURCE_ID),
          ctx.logger,
        );
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
          conn.listSObjects().then(() => "ok" as const),
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
 * // Adapter-only (DORMANT credential-form bridge seam — #3302 / ADR-0014;
 * // the bridge skips salesforce, so this is unused in current deployments.
 * // SaaS Salesforce connects via OAuth, not this registration):
 * plugins: [salesforcePlugin({})]
 * ```
 */
export const salesforcePlugin = createPlugin({
  configSchema: SalesforceConfigSchema,
  create: buildSalesforcePlugin,
});

export { createSalesforceConnection, parseSalesforceURL, extractHost } from "./connection";
export type { SalesforceConfig, SalesforceConnection, SObjectInfo, SObjectField, SObjectDescribe } from "./connection";
export { listSalesforceObjects, profileSalesforce } from "./profiler";
export { validateSOQL, validateSOQLStructure, appendSOQLLimit, SOQL_FORBIDDEN_PATTERNS, SENSITIVE_PATTERNS } from "./validation";
export { createQuerySalesforceTool } from "./tool";
