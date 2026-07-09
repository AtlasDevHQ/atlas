/**
 * Salesforce LazyPluginLoader builder (#2658).
 *
 * The first lazy integration plugin to wire through {@link
 * lazyPluginLoader}. On first tool call per Workspace, the loader:
 *
 *   1. Reads `workspace_plugins.config` (passed in as `args.config`)
 *      to surface admin-visible state (`instance_url`, `status`).
 *   2. If `config.status === "reconnect_needed"`, the build refuses
 *      with `IntegrationReconnectRequiredError` (`platform: "salesforce"`)
 *      so the agent loop surfaces a specific "this install needs
 *      Reconnect" message rather than silently failing with a 401.
 *   3. Reads `integration_credentials` for the bundle (already
 *      decrypted by the store helper).
 *   4. Constructs a jsforce Connection in OAuth-token mode (skipping
 *      username/password login).
 *   5. Returns a {@link PluginLike} carrying a `query(soql)` method.
 *      The agent's `querySalesforce` tool (../salesforce-tool.ts, #3311)
 *      dispatches through this method.
 *
 * Refresh strategy: the builder does NOT pro-actively refresh on
 * `expires_at`. Instead, the shared {@link createOAuthRetry} harness
 * wraps each `query`, catches Salesforce's INVALID_SESSION_ID error,
 * runs the refresh, and retries once. This matches the existing
 * static-config plugin's `withSessionRetry` pattern and means a stale
 * `expires_at` (Salesforce's session timeout is operator-configurable
 * and we don't trust the cached value) doesn't trigger spurious
 * refreshes.
 *
 * Cache eviction: on permanent refresh failure (`invalid_grant` and
 * friends), the retry harness evicts THIS instance from the lazy loader
 * before re-throwing `IntegrationReconnectRequiredError`. The next
 * tool-call rebuilds from the fresh `workspace_plugins.config`
 * (which now carries `status: "reconnect_needed"` thanks to the
 * refresh flow's UPDATE) and the build short-circuits to that same
 * reconnect error at the status check — the agent sees a specific
 * "Reconnect" error instead of cycling through INVALID_SESSION_ID /
 * refresh / fail on every call until process restart.
 *
 * @see packages/api/src/lib/integrations/_shared/oauth-retry.ts — shared retry harness
 * @see packages/api/src/lib/plugins/lazy-loader.ts — generic loader
 * @see ./../install/salesforce-token-refresh.ts — refresh + reconnect surface
 * @see ../salesforce-tool.ts — the agent `querySalesforce` tool that consumes this (#3311)
 */

import { createLogger } from "@atlas/api/lib/logger";
import { readCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import {
  refreshSalesforceToken,
  IntegrationReconnectRequiredError,
} from "@atlas/api/lib/integrations/install/salesforce-token-refresh";
import { createOAuthRetry } from "@atlas/api/lib/integrations/_shared/oauth-retry";
import {
  type LazyPluginBuilder,
  type LazyPluginBuilderArgs,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";
import type { LiveConnectionListOptions, LiveConnectionProfileOptions } from "@atlas/api/lib/effect/semantic-generator";
import {
  listSalesforceOAuthObjects,
  profileSalesforceOAuth,
  type SalesforceDescribeSurface,
} from "@atlas/api/lib/integrations/salesforce/oauth-introspection";

const log = createLogger("integrations.salesforce.lazy-builder");

export interface SalesforceQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Public shape exposed by the lazy-built Salesforce plugin instance.
 * Agent tooling calls `query` with a SOQL statement; the wrapper
 * handles session-expired retries via {@link refreshSalesforceToken}.
 */
export interface SalesforcePluginInstance extends PluginLike {
  query(soql: string, timeoutMs?: number): Promise<SalesforceQueryResult>;
  /**
   * Introspection as a capability of the live OAuth connection (#3667, ADR-0017
   * universalization). `listObjects`/`profile` run over the SAME OAuth `jsforce`
   * session `query` uses (refresh-retried), so the unified
   * `resolveLiveConnection` profiles Salesforce end-to-end over MCP without the
   * `createFromConfig` bridge (ADR-0014). A mid-profile `INVALID_SESSION_ID`
   * refreshes once and, on permanent failure, surfaces a reconnect-required.
   */
  listObjects(options?: LiveConnectionListOptions): Promise<DatabaseObject[]>;
  profile(options?: LiveConnectionProfileOptions): Promise<ProfilingResult>;
}

/**
 * Operator-side Salesforce credentials. Same shape as the OAuth
 * install handler's config — the lazy-builder needs them so it can
 * run a refresh when the access token expires.
 */
export interface SalesforceLazyBuilderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly loginUrl?: string;
}

/**
 * Status field stored on `workspace_plugins.config.status`. Mirrors
 * the OAuth handler's seed value (`"ok"`) and the refresh flow's
 * flipped value (`"reconnect_needed"`).
 */
function readInstallStatus(config: Record<string, unknown>): string {
  const status = config.status;
  return typeof status === "string" ? status : "ok";
}

function readInstanceUrl(config: Record<string, unknown>): string | null {
  const url = config.instance_url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Minimal slice of the jsforce `Connection` surface the builder uses —
 * just enough to keep the lazy-OAuth `withRetry` context typed (jsforce
 * itself is an untyped optional peer dep loaded via {@link requireJsforce}).
 */
interface JsforceConnection {
  query(soql: string): Promise<{ records?: Record<string, unknown>[] }>;
  // Describe surface used by the OAuth introspection (#3667). jsforce is an
  // untyped optional peer dep, so these are structural.
  describeGlobal(): Promise<{ sobjects?: ReadonlyArray<{ name?: string; queryable?: boolean }> }>;
  describe(objectName: string): Promise<{ fields?: readonly Record<string, unknown>[] }>;
}

/**
 * jsforce import shim. Mirrors the static-config plugin's pattern:
 * jsforce is an optional peer dep, so the require is wrapped in a
 * try/catch that throws a clear error if the operator hasn't
 * installed it.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function requireJsforce(): any {
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    return require("jsforce");
  } catch {
    throw new Error(
      "Salesforce integration requires the jsforce package. Install with: bun add jsforce",
    );
  }
}

function isSessionExpiredError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("INVALID_SESSION_ID") ||
    msg.includes("Session expired") ||
    msg.includes("session has expired")
  );
}

/**
 * Factory that returns a {@link LazyPluginBuilder} closed over the
 * operator-side Connected App config. Tests inject a custom config;
 * the boot wiring in `register.ts` reads `process.env` once and
 * passes the values in.
 */
export function createSalesforceLazyBuilder(
  config: SalesforceLazyBuilderConfig,
): LazyPluginBuilder {
  return async (args: LazyPluginBuilderArgs): Promise<SalesforcePluginInstance> => {
    const { workspaceId, catalogId } = args;
    const installConfig = args.config;

    const status = readInstallStatus(installConfig);
    if (status === "reconnect_needed") {
      throw new IntegrationReconnectRequiredError({
        message: "Salesforce install needs to be reconnected — workspace_plugins.config.status is reconnect_needed.",
        workspaceId,
        platform: "salesforce",
        upstreamError: "install_marked_reconnect_needed",
      });
    }

    let bundle: CredentialBundle | null;
    try {
      bundle = await readCredentialBundle(workspaceId, catalogId);
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt Salesforce credentials — refusing to instantiate plugin",
      );
      throw err;
    }
    if (!bundle) {
      throw new Error(
        `LazyPluginLoader: Salesforce install row exists but integration_credentials row is missing for workspace ${workspaceId} — disconnect + reinstall`,
      );
    }

    // Prefer the instance_url stored in the credential bundle (written
    // by the OAuth handler at install time). Fall back to the
    // operator-visible copy in `workspace_plugins.config` only if the
    // bundle's value is empty — that case shouldn't happen in practice
    // but stays harmless.
    const instanceUrl =
      bundle.instanceUrl && bundle.instanceUrl.length > 0
        ? bundle.instanceUrl
        : readInstanceUrl(installConfig);
    if (!instanceUrl) {
      throw new Error(
        `LazyPluginLoader: Salesforce install for workspace ${workspaceId} has no instance_url`,
      );
    }

    const jsforce = requireJsforce();
    // jsforce Connection accepts `{ instanceUrl, accessToken }` to skip
    // the login step entirely — exactly what we want post-OAuth-dance.
    // The shared retry harness owns the live connection: on
    // INVALID_SESSION_ID it runs `refreshSalesforceToken` (which writes
    // to `integration_credentials` and clears reconnect_needed), rebuilds
    // the connection on the rotated token, and retries once. On permanent
    // refresh failure it evicts THIS cached instance before re-throwing,
    // so the next tool call rebuilds from the fresh
    // `workspace_plugins.config` and short-circuits to the reconnect
    // error at the status check.
    const withRetry = createOAuthRetry<JsforceConnection>({
      workspaceId,
      catalogId,
      platformLabel: "Salesforce",
      logger: log,
      initialContext: new jsforce.Connection({ instanceUrl, accessToken: bundle.accessToken }),
      isSessionExpired: isSessionExpiredError,
      reconnectErrorClass: IntegrationReconnectRequiredError,
      refreshContext: async () => {
        const refreshed = await refreshSalesforceToken({
          workspaceId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          loginUrl: config.loginUrl,
        });
        return new jsforce.Connection({
          // Fall back to the install-resolved instanceUrl if the refresh
          // response omits one — never rebuild the connection without a host.
          instanceUrl: refreshed.instanceUrl ?? instanceUrl,
          accessToken: refreshed.accessToken,
        });
      },
    });

    // Describe/query surface for the OAuth introspection (#3667). Each call is
    // refresh-retried, so a stale token refreshes on the FIRST call (effectively
    // a host-side pre-refresh: `listObjects`/`describeGlobal` runs first in a
    // profile, validating the session before the per-object loop) and a
    // mid-profile `INVALID_SESSION_ID` refreshes once more; a permanent failure
    // throws `IntegrationReconnectRequiredError`, which the unified resolver maps
    // to an actionable reconnect-required. Tokens stay inside these closures.
    const describeSurface = {
      describeGlobal: () => withRetry((c) => c.describeGlobal()),
      describe: (objectName: string) => withRetry((c) => c.describe(objectName)),
      query: async (soql: string) => {
        const result = await withRetry((c) => c.query(soql));
        return result.records ?? [];
      },
      // jsforce is an untyped optional peer dep — its describe shapes are
      // structurally compatible with SalesforceDescribeSurface but TS can't
      // verify the optional-field narrowing across the `unknown` boundary.
    } as unknown as SalesforceDescribeSurface;

    const instance: SalesforcePluginInstance = {
      id: `salesforce:${workspaceId}`,
      types: ["datasource"] as const,
      version: "0.1.0",
      name: "Salesforce",
      config: { instanceUrl, scope: bundle.scope },

      listObjects(): Promise<DatabaseObject[]> {
        return listSalesforceOAuthObjects(describeSurface);
      },

      profile(options: LiveConnectionProfileOptions = {}): Promise<ProfilingResult> {
        return profileSalesforceOAuth(describeSurface, options);
      },

      async query(soql: string, timeoutMs = 30_000): Promise<SalesforceQueryResult> {
        return withRetry(async (c) => {
          let timer: ReturnType<typeof setTimeout>;
          const result = await Promise.race([
            c.query(soql),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Salesforce query timed out")),
                timeoutMs,
              );
            }),
          ]).finally(() => clearTimeout(timer!));

          const records = result.records ?? [];
          if (records.length === 0) return { columns: [], rows: [] };
          const columns = Object.keys(records[0]).filter((k) => k !== "attributes");
          const rows = records.map((rec) => {
            const out: Record<string, unknown> = {};
            for (const col of columns) out[col] = rec[col];
            return out;
          });
          return { columns, rows };
        });
      },

      async teardown(): Promise<void> {
        // jsforce in OAuth-token mode holds no socket — there's
        // nothing to release. The teardown hook is here so future
        // refactors that add a pool stay backwards-compatible with the
        // LazyPluginLoader's `evict` contract.
      },
    };

    log.info(
      { workspaceId, instanceUrl, scope: bundle.scope },
      "Salesforce lazy plugin instantiated",
    );
    return instance;
  };
}
