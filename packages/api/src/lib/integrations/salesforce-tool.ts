/**
 * `querySalesforce` agent tool — OAuth per-Workspace path (#3311).
 *
 * The counterpart to the static-config `querySalesforce` tool in
 * `@useatlas/salesforce` (`plugins/salesforce/src/tool.ts`). That tool is
 * registered ONLY when a static `salesforce://…` url is configured (self-host);
 * it is hardwired to one boot-time connection. The SaaS / OAuth path installs
 * Salesforce per Workspace via `SalesforceOAuthInstallHandler` (tokens in
 * `integration_credentials`) and builds a connection on demand through the
 * {@link lazyPluginLoader}. Until this tool landed, the OAuth-built instance's
 * `query(soql)` had no consumer — an OAuth-installed Salesforce datasource was
 * installable but **not queryable by the agent** (the bug this fixes).
 *
 * This is a per-Workspace lazy-plugin tool in the `sendEmail` (#2698) /
 * `createLinearIssue` (#2750) mould: registered globally (so it's discoverable
 * across Workspaces), with the install gate running at execute time inside the
 * `getOrInstantiate(workspaceId, catalog:salesforce)` call.
 *
 * Security layers, in order:
 *   1. **Object whitelist resolve** — the semantic-layer object names for the
 *      Salesforce connection (org-scoped in SaaS, filesystem-backed self-host).
 *      A scan FAILURE FAILS CLOSED (`scan_unavailable`); a legitimately-empty
 *      layer falls back to SOQL structural-only (mirrors the static tool, #3313).
 *   2. **SOQL validation** — `validateSOQL` (SELECT-only, no DML, no semicolons,
 *      object whitelist). A core-local copy of the canonical static-path
 *      validator (./salesforce/soql-validation.ts) — core can't import the
 *      `@useatlas/salesforce` plugin package (the create-atlas scaffold excludes
 *      workspace plugins), so the identical semantics are duplicated, not shared.
 *   3. **Auto LIMIT** — `appendSOQLLimit` (`ATLAS_ROW_LIMIT` resolved lazily per
 *      call via `getSetting`, matching the SQL tool; default 1000, #3400).
 *
 * Status discriminants surfaced to the agent (so it can self-correct or stop):
 *   - **`ok`** — happy path; carries columns + rows.
 *   - **`no_workspace`** — request had no `activeOrganizationId`.
 *   - **`no_install`** — no enabled `catalog:salesforce` `workspace_plugins` row.
 *   - **`scan_unavailable`** — semantic-layer scan failed; refused (fail-closed).
 *   - **`invalid_query`** — SOQL validation rejected the query.
 *   - **`reconnect_required`** — OAuth refresh failed permanently / install marked
 *     `reconnect_needed`; remediation is Reconnect at /admin/integrations.
 *   - **`misconfigured`** — install row present but no lazy builder registered
 *     (boot-DAG / operator-side issue).
 *   - **`query_failure`** — credential decrypt, instantiation, or the query
 *     itself threw. Messages scrubbed so credentials don't leak to the agent.
 *
 * @see ./salesforce/lazy-builder.ts — builds the per-Workspace OAuth instance
 * @see ./install/salesforce-oauth-handler.ts — OAuth install + SALESFORCE_CATALOG_ID
 * @see ./linear-tool.ts / ./email-tool.ts — per-Workspace lazy-plugin tool pattern
 * @see ../tools/registry.ts — `defaultRegistry` registration site (OAuth-gated)
 */

import { tool } from "ai";
import { z } from "zod";

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  classifyLazyInstantiateError,
  resolveLazyPluginToolDeps,
  type LazyPluginToolDeps,
} from "./_shared/lazy-plugin-tool";
import type { SalesforcePluginInstance } from "./salesforce/lazy-builder";
import { SALESFORCE_CATALOG_ID } from "./install/salesforce-oauth-handler";
import { IntegrationReconnectRequiredError } from "./install/salesforce-token-refresh";
import { validateSOQL, appendSOQLLimit, SENSITIVE_PATTERNS } from "./salesforce/soql-validation";

const log = createLogger("integrations.salesforce.tool");

let lastWarnedRowLimit: string | undefined;

/**
 * Read row limit from settings cache (workspace DB override > platform DB
 * override > env var > default). Resolved per call — not frozen at module
 * import — so admin overrides take effect without a restart (#3400), and
 * `orgId` threads the workspace tier (#3406). Copies `getRowLimit()` in
 * `tools/sql.ts` exactly so SQL and SOQL auto-LIMIT share one vocabulary
 * of truth (parity Rule 3).
 */
function getRowLimit(orgId?: string): number {
  const raw = getSetting("ATLAS_ROW_LIMIT", orgId) ?? "1000";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== lastWarnedRowLimit) {
      log.warn({ value: raw }, "Invalid ATLAS_ROW_LIMIT value; using default 1000");
      lastWarnedRowLimit = raw;
    }
    return 1000;
  }
  return n;
}

let lastWarnedQueryTimeout: string | undefined;

/**
 * Read query timeout from settings cache (workspace DB override > platform
 * DB override > env var > default). Resolved per call — not frozen at
 * module import — so admin overrides take effect without a restart (#3402),
 * and `orgId` threads the workspace tier (#3406). Copies `getQueryTimeout()`
 * in `tools/sql.ts` exactly so SQL and SOQL query timeouts share one
 * vocabulary of truth (parity Rule 3).
 */
function getQueryTimeout(orgId?: string): number {
  const raw = getSetting("ATLAS_QUERY_TIMEOUT", orgId) ?? "30000";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== lastWarnedQueryTimeout) {
      log.warn({ value: raw }, "Invalid ATLAS_QUERY_TIMEOUT value; using default 30000ms");
      lastWarnedQueryTimeout = raw;
    }
    return 30000;
  }
  return n;
}

/**
 * Semantic-layer connection id the Salesforce object whitelist keys on. Matches
 * the static plugin's `DATASOURCE_ID` so the self-host filesystem path reads the
 * same entity YAMLs.
 *
 * CAVEAT (deferred to the profiler-seam work, PRD #3303 / #3326 item 2): the
 * OAuth/SaaS path has no entity profiling wired yet, so the org whitelist under
 * this key is always empty → structural-only (fail-OPEN to SELECT-only/no-DML,
 * never fail-closed). SaaS Salesforce object profiling lands with the datasource
 * profiler seam (provisionally v0.0.14), which decides how org entities are
 * keyed (likely the per-install connection id, not this static-mode constant) —
 * revisit this binding there for per-object enforcement to actually apply.
 */
const SALESFORCE_CONNECTION_ID = "salesforce-datasource";

export const QUERY_SALESFORCE_DESCRIPTION = `### Query Salesforce (SOQL)
Use querySalesforce to run a read-only SOQL query against the workspace's connected Salesforce org:
- Always read the relevant entity schema from the semantic layer BEFORE writing SOQL
- Use exact field/object names from the schema — never guess
- SOQL is NOT SQL: no JOINs — use relationship queries (e.g. \`SELECT Account.Name FROM Contact\`)
- Only SELECT is allowed; include a LIMIT for large result sets
- The Salesforce integration must be installed (OAuth) for the workspace at /admin/integrations`;

/**
 * Test seam — production calls go through the singleton `lazyPluginLoader` and
 * the request-context-derived whitelist. Tests inject fakes so the execute path
 * runs without booting the loader or the semantic layer. Base loader/context
 * seams come from the shared lazy-plugin-tool scaffolding (#3326).
 */
export interface QuerySalesforceToolDeps extends LazyPluginToolDeps {
  /**
   * Resolve the Salesforce object whitelist. MUST throw when a semantic-layer
   * directory scan failed so the tool can fail closed (`scan_unavailable`); a
   * legitimately-empty layer returns `[]` → structural-only.
   */
  readonly resolveWhitelist?: () => Promise<Set<string>>;
}

const QuerySalesforceInput = z.object({
  soql: z.string().min(1, "soql must not be empty").describe("The SELECT SOQL query to execute"),
  explanation: z
    .string()
    .describe("Brief explanation of what this query does and why"),
});

type QuerySalesforceExecuteResult =
  | {
      status: "ok";
      explanation: string;
      row_count: number;
      columns: readonly string[];
      rows: readonly Record<string, unknown>[];
      truncated: boolean;
      durationMs: number;
    }
  | { status: "no_workspace"; message: string }
  | { status: "no_install"; message: string }
  | { status: "scan_unavailable"; message: string }
  | { status: "invalid_query"; message: string }
  | { status: "reconnect_required"; message: string }
  | { status: "misconfigured"; message: string; requestId: string | undefined }
  | { status: "query_failure"; message: string; requestId: string | undefined };

/**
 * Default whitelist resolution, mirroring `executeSQL` (tools/sql.ts): org-scoped
 * (DB-backed) when an org context exists, else filesystem-backed STRICT (throws
 * `SemanticLayerScanError` on a scan failure → fail closed). An empty set in
 * either branch means structural-only.
 */
async function defaultResolveWhitelist(): Promise<Set<string>> {
  // Lazy-import the semantic barrel at execute time (never at module eval).
  // The barrel is imported broadly and pulls a heavy graph; deferring it keeps
  // this tool — which sits in the eagerly-built `defaultRegistry` graph — off
  // that surface, matching the barrel's own "imported broadly" design note.
  const { loadOrgWhitelist, getOrgWhitelistedTables, getWhitelistedTablesStrict } =
    await import("@atlas/api/lib/semantic");
  const ctx = getRequestContext();
  const orgId = ctx?.user?.activeOrganizationId;
  if (orgId) {
    // Cache-guarded: O(1) after the first load for this org.
    await loadOrgWhitelist(orgId, ctx?.atlasMode);
    return getOrgWhitelistedTables(orgId, SALESFORCE_CONNECTION_ID, ctx?.atlasMode);
  }
  // Self-host: strict accessor throws on a directory-scan failure so the tool
  // fails closed instead of silently widening to structural-only (#3243/#3313).
  return getWhitelistedTablesStrict(SALESFORCE_CONNECTION_ID);
}

export function createQuerySalesforceTool(deps: QuerySalesforceToolDeps = {}) {
  const { loader, resolveWorkspaceId, resolveRequestId } = resolveLazyPluginToolDeps(deps);
  const resolveWhitelist = deps.resolveWhitelist ?? defaultResolveWhitelist;

  return tool({
    description:
      "Execute a read-only SOQL query against the workspace's OAuth-connected Salesforce org. SELECT-only.",
    inputSchema: QuerySalesforceInput,
    execute: async ({ soql, explanation }): Promise<QuerySalesforceExecuteResult> => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) {
        log.warn(
          { requestId: resolveRequestId() },
          "querySalesforce invoked with no active workspaceId",
        );
        return {
          status: "no_workspace",
          message:
            "No workspace is selected for this request. Open a workspace-scoped session before querying Salesforce.",
        };
      }

      // ── 1. Resolve the object whitelist (fail CLOSED on scan failure) ──
      let allowed: Set<string>;
      try {
        allowed = await resolveWhitelist();
      } catch (err) {
        log.error(
          { workspaceId, err: err instanceof Error ? err.message : String(err) },
          "querySalesforce refused — semantic layer unavailable (scan failed)",
        );
        return {
          status: "scan_unavailable",
          message:
            "The semantic layer is temporarily unavailable (its scan failed), so object access cannot be verified. Refusing the query to avoid unsafe access — retry once it recovers.",
        };
      }
      if (allowed.size === 0) {
        // Debug, not warn: an empty whitelist is the EXPECTED steady state for
        // OAuth Salesforce today (no entity profiling wired yet), so this fires
        // on every query — warn-level would be pure log noise. Structural-only
        // still enforces SELECT-only / no-DML; it only skips per-object membership.
        log.debug(
          { workspaceId },
          "querySalesforce running in structural-only mode — empty semantic-layer whitelist (no per-object allow-list).",
        );
      }

      // ── 2. SOQL validation (shared with the static plugin tool) ──
      const validation = validateSOQL(soql, allowed);
      if (!validation.valid) {
        log.debug(
          { workspaceId, soql: soql.slice(0, 200), error: validation.error },
          "querySalesforce SOQL validation rejected",
        );
        return {
          status: "invalid_query",
          message: validation.error ?? "SOQL query rejected by validation.",
        };
      }

      // ── 3. Auto-append LIMIT (row limit resolved lazily per call, #3400;
      // workspace tier via the resolved workspaceId, #3406) ──
      const rowLimit = getRowLimit(workspaceId);
      const querySoql = appendSOQLLimit(soql.trim(), rowLimit);

      // ── 4. Instantiate the per-Workspace OAuth Salesforce instance ──
      let instance: SalesforcePluginInstance;
      try {
        const raw = await loader.getOrInstantiate(workspaceId, SALESFORCE_CATALOG_ID);
        instance = raw as SalesforcePluginInstance;
      } catch (err) {
        switch (classifyLazyInstantiateError(err)) {
          case "install_not_found": {
            log.info(
              { workspaceId },
              "querySalesforce rejected — workspace has no Salesforce OAuth install",
            );
            return {
              status: "no_install",
              message:
                "Install the Salesforce integration at /admin/integrations before querying. No workspace_plugins row is enabled for catalog:salesforce.",
            };
          }
          case "reconnect_required": {
            log.warn(
              { workspaceId, err: err instanceof Error ? err.message : String(err) },
              "querySalesforce aborted — Salesforce OAuth install needs Reconnect",
            );
            return {
              status: "reconnect_required",
              message:
                "Salesforce install needs to be reconnected. Open /admin/integrations and click Reconnect on the Salesforce card.",
            };
          }
          case "builder_missing": {
            const requestId = resolveRequestId();
            log.error(
              { workspaceId, requestId, err: err instanceof Error ? err.message : String(err) },
              "querySalesforce aborted — Salesforce lazy builder not registered (boot DAG issue)",
            );
            return {
              status: "misconfigured",
              message: `Salesforce integration is installed but no builder is registered for catalog:salesforce. This is a deploy-side configuration issue (SALESFORCE_CLIENT_ID/SECRET likely unset); contact your operator. Request id ${requestId ?? "<unset>"}.`,
              requestId,
            };
          }
          case "unknown": {
            // Credential decrypt failure, missing bundle / instance_url, or
            // construction error — surfaced as query_failure so the agent stops
            // looping. These can carry auth/credential substrings (decrypt errors,
            // INVALID_CLIENT_ID, …), so gate on SENSITIVE_PATTERNS exactly like the
            // query-execution branch below — `errorMessage()` only strips
            // connection-string userinfo, not those tokens.
            const requestId = resolveRequestId();
            const instErr = err instanceof Error ? err.message : String(err);
            log.error(
              { workspaceId, requestId, err: instErr },
              "querySalesforce aborted — failed to instantiate Salesforce plugin",
            );
            if (SENSITIVE_PATTERNS.test(instErr)) {
              return {
                status: "query_failure",
                message: `Could not initialise the Salesforce integration — check server logs for details. Request id ${requestId ?? "<unset>"}.`,
                requestId,
              };
            }
            return {
              status: "query_failure",
              message: `Could not initialise the Salesforce integration: ${errorMessage(err)}`,
              requestId,
            };
          }
        }
      }

      // ── 5. Execute the query ──
      const start = performance.now();
      try {
        // Query timeout resolved lazily per call (#3402), workspace tier
        // via the resolved workspaceId (#3406), like the row limit.
        const result = await instance.query(querySoql, getQueryTimeout(workspaceId));
        const durationMs = Math.round(performance.now() - start);
        const truncated = result.rows.length >= rowLimit;
        log.debug(
          { workspaceId, durationMs, rowCount: result.rows.length },
          "querySalesforce executed",
        );
        return {
          status: "ok",
          explanation,
          row_count: result.rows.length,
          columns: result.columns,
          rows: result.rows,
          truncated,
          durationMs,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        const requestId = resolveRequestId();
        if (err instanceof IntegrationReconnectRequiredError) {
          log.warn(
            { workspaceId, err: err.message },
            "querySalesforce: Salesforce OAuth refresh failed permanently mid-call",
          );
          return {
            status: "reconnect_required",
            message:
              "Salesforce OAuth refresh failed permanently. Open /admin/integrations and click Reconnect on the Salesforce card.",
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ workspaceId, requestId, durationMs, error: message }, "querySalesforce query failed");
        // Block errors that might expose connection details or internal state.
        if (SENSITIVE_PATTERNS.test(message)) {
          return {
            status: "query_failure",
            message: `Salesforce query failed — check server logs for details. Request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        return {
          status: "query_failure",
          message: `Salesforce query failed: ${errorMessage(err)}`,
          requestId,
        };
      }
    },
  });
}

/**
 * True when the Salesforce OAuth path is wired (operator-side Connected App
 * env present). Gates global registration of this tool so it does NOT shadow
 * the static-config `querySalesforce` tool in self-host static-url mode (which
 * never sets these). Mirrors the `register.ts` OAuth-handler gate.
 */
export function isSalesforceOAuthConfigured(): boolean {
  return !!(process.env.SALESFORCE_CLIENT_ID && process.env.SALESFORCE_CLIENT_SECRET);
}

/** Production tool instance, registered with `defaultRegistry` in `tools/registry.ts`. */
export const querySalesforceTool = createQuerySalesforceTool();
