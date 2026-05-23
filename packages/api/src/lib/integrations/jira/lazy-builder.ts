/**
 * Jira LazyPluginLoader builder (#2659).
 *
 * Second lazy integration plugin to wire through {@link
 * lazyPluginLoader}; mirrors the Salesforce builder's shape (#2658). On
 * first tool call per Workspace, the loader:
 *
 *   1. Reads `workspace_plugins.config` (passed in as `args.config`)
 *      to surface admin-visible state (`cloudid`, `status`).
 *   2. If `config.status === "reconnect_needed"`, the build refuses
 *      with `JiraReconnectRequiredError` so the agent loop surfaces a
 *      specific "this install needs Reconnect" message rather than
 *      silently failing with a 401.
 *   3. Reads `integration_credentials` for the bundle (already
 *      decrypted by the store helper).
 *   4. Constructs an instance that calls the Jira REST API via `fetch`
 *      against `https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3`.
 *      We use `fetch` rather than a Jira client library because:
 *        - Atlassian's official `@atlassian/jira-api-client` is a
 *          generated wrapper with a heavy dep tree (every endpoint is
 *          its own class); we use exactly one endpoint here.
 *        - The REST surface is straightforward — auth header + JQL
 *          body — and matches the rest of the codebase's pattern
 *          (Slack's OAuth handler also calls `fetch` directly).
 *        - Avoiding a new dep keeps the create-atlas template's
 *          `serverExternalPackages` list shorter.
 *   5. Returns a {@link PluginLike} carrying `queryJira(jql)`. Agent's
 *      Jira tool dispatches through this method.
 *
 * Refresh strategy: matches Salesforce — on 401, runs the refresh,
 * retries once. Atlassian rotates the refresh token on every refresh
 * (Salesforce sometimes returns one, sometimes not), but that detail
 * is hidden inside `refreshJiraToken` which writes the rotated value
 * back to `integration_credentials`.
 *
 * Cache eviction: on permanent refresh failure, `withRetry` evicts THIS
 * instance from `lazyPluginLoader` before re-throwing
 * `JiraReconnectRequiredError`. Same wire as Salesforce — keeps the
 * agent from cycling through 401 / refresh / fail on every call.
 *
 * @see packages/api/src/lib/plugins/lazy-loader.ts — generic loader
 * @see ./../install/jira-token-refresh.ts — refresh + reconnect surface
 * @see ./../salesforce/lazy-builder.ts — first reference implementation
 */

import { createLogger } from "@atlas/api/lib/logger";
import { readCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import {
  refreshJiraToken,
  JiraReconnectRequiredError,
} from "@atlas/api/lib/integrations/install/jira-token-refresh";
import {
  lazyPluginLoader,
  type LazyPluginBuilder,
  type LazyPluginBuilderArgs,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";

const log = createLogger("integrations.jira.lazy-builder");

export interface JiraQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Public shape exposed by the lazy-built Jira plugin instance. Agent
 * tooling calls `queryJira(jql)` with a JQL search expression; the
 * wrapper handles session-expired retries via {@link refreshJiraToken}.
 */
export interface JiraPluginInstance extends PluginLike {
  queryJira(jql: string, timeoutMs?: number): Promise<JiraQueryResult>;
}

/**
 * Operator-side Jira OAuth App credentials. The lazy-builder needs them
 * so it can run a refresh when the access token expires.
 */
export interface JiraLazyBuilderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
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

function readCloudid(config: Record<string, unknown>): string | null {
  const cloudid = config.cloudid;
  return typeof cloudid === "string" && cloudid.length > 0 ? cloudid : null;
}

/**
 * Treat any 401 from the Jira REST API as "session expired" — the
 * stored access token has expired and a refresh is warranted.
 */
function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof JiraUnauthorizedError) return true;
  if (!(err instanceof Error)) return false;
  return err.message.includes("401");
}

class JiraUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraUnauthorizedError";
  }
}

/**
 * Run a JQL search against Jira Cloud REST API v3. POSTs to
 * `/rest/api/3/search` with the JQL string + a request for the
 * standard `summary` / `status` / `assignee` fields. Returns a
 * tabular shape that lines up with the rest of Atlas's tool surface
 * (`columns` + `rows`).
 */
async function runJqlSearch(
  baseUrl: string,
  accessToken: string,
  jql: string,
  timeoutMs: number,
): Promise<JiraQueryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/rest/api/3/search`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jql,
        // Conservative defaults — JQL can match millions of issues. The
        // agent surface is for analysis, not bulk export. 100 is the
        // Jira-side default page size.
        maxResults: 100,
        fields: ["summary", "status", "assignee", "priority", "issuetype", "created", "updated"],
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Jira query timed out", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) {
    // 401 surfaces through `isSessionExpiredError` so the retry wrapper
    // runs a refresh + retry. Subclass so the wrapper can pin the type
    // without string matching.
    throw new JiraUnauthorizedError(
      `Jira API returned 401 — access token rejected`,
    );
  }

  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 500);
    } catch {
      // best-effort body capture for log forensics
    }
    throw new Error(`Jira API returned HTTP ${resp.status}: ${body}`);
  }

  let parsed: { issues?: ReadonlyArray<Record<string, unknown>> };
  try {
    parsed = (await resp.json()) as { issues?: ReadonlyArray<Record<string, unknown>> };
  } catch (err) {
    throw new Error(
      `Jira API response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const issues = parsed.issues ?? [];
  if (issues.length === 0) return { columns: [], rows: [] };

  // Project the nested Atlassian-Document-Format payload into a flat
  // table. The agent reads tables — keep this conservative; the full
  // ADF payload is available via a follow-up tool if the agent needs
  // it.
  const columns = ["key", "summary", "status", "assignee", "priority", "issuetype", "created", "updated"];
  const rows = issues.map((issue) => {
    const fields = (issue.fields as Record<string, unknown> | undefined) ?? {};
    return {
      key: issue.key as string | undefined,
      summary: fields.summary as string | undefined,
      status: stringOrName(fields.status),
      assignee: stringOrName(fields.assignee, "displayName"),
      priority: stringOrName(fields.priority),
      issuetype: stringOrName(fields.issuetype),
      created: fields.created as string | undefined,
      updated: fields.updated as string | undefined,
    };
  });
  return { columns, rows };
}

function stringOrName(value: unknown, key: string = "name"): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && key in (value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * Factory returning a {@link LazyPluginBuilder} closed over operator
 * Jira OAuth App config. Tests inject a custom config; boot wiring in
 * `register.ts` reads `process.env` once and passes the values in.
 */
export function createJiraLazyBuilder(
  config: JiraLazyBuilderConfig,
): LazyPluginBuilder {
  return async (args: LazyPluginBuilderArgs): Promise<JiraPluginInstance> => {
    const { workspaceId, catalogId } = args;
    const installConfig = args.config;

    const status = readInstallStatus(installConfig);
    if (status === "reconnect_needed") {
      throw new JiraReconnectRequiredError({
        message: "Jira install needs to be reconnected — workspace_plugins.config.status is reconnect_needed.",
        workspaceId,
        upstreamError: "install_marked_reconnect_needed",
      });
    }

    let bundle: CredentialBundle | null;
    try {
      bundle = await readCredentialBundle(workspaceId, catalogId);
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt Jira credentials — refusing to instantiate plugin",
      );
      throw err;
    }
    if (!bundle) {
      throw new Error(
        `LazyPluginLoader: Jira install row exists but integration_credentials row is missing for workspace ${workspaceId} — disconnect + reinstall`,
      );
    }

    // The OAuth handler writes `instanceUrl =
    // https://api.atlassian.com/ex/jira/<cloudid>` into the bundle.
    // Fall back to reconstructing from the install config's `cloudid`
    // when the bundle's value is empty — defensive, shouldn't happen
    // in practice.
    let activeBaseUrl: string;
    if (bundle.instanceUrl && bundle.instanceUrl.length > 0) {
      activeBaseUrl = bundle.instanceUrl;
    } else {
      const cloudid = readCloudid(installConfig);
      if (!cloudid) {
        throw new Error(
          `LazyPluginLoader: Jira install for workspace ${workspaceId} has no cloudid`,
        );
      }
      activeBaseUrl = `https://api.atlassian.com/ex/jira/${cloudid}`;
    }

    let activeAccessToken = bundle.accessToken;

    /**
     * Run a callback against the Jira API; on 401, refresh the token
     * (via {@link refreshJiraToken} — which writes the rotated
     * refresh_token to `integration_credentials` and clears
     * reconnect_needed) and retry once. On permanent refresh failure,
     * evict THIS cached instance before re-throwing.
     */
    async function withRetry<T>(fn: (baseUrl: string, accessToken: string) => Promise<T>): Promise<T> {
      try {
        return await fn(activeBaseUrl, activeAccessToken);
      } catch (err) {
        if (!isSessionExpiredError(err)) throw err;
        log.info({ workspaceId }, "Jira session expired — refreshing token");
        try {
          const refreshed = await refreshJiraToken({
            workspaceId,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          });
          activeAccessToken = refreshed.accessToken;
          if (refreshed.instanceUrl && refreshed.instanceUrl.length > 0) {
            activeBaseUrl = refreshed.instanceUrl;
          }
          return await fn(activeBaseUrl, activeAccessToken);
        } catch (refreshErr) {
          if (refreshErr instanceof JiraReconnectRequiredError) {
            // Fire-and-forget evict — see Salesforce builder for the
            // rationale. Tagged as void to silence the floating-promise
            // check.
            void lazyPluginLoader.evict(workspaceId, catalogId);
          }
          throw refreshErr;
        }
      }
    }

    const instance: JiraPluginInstance = {
      id: `jira:${workspaceId}`,
      types: ["datasource"] as const,
      version: "0.1.0",
      name: "Jira",
      config: { instanceUrl: activeBaseUrl, scope: bundle.scope },

      async queryJira(jql: string, timeoutMs = 30_000): Promise<JiraQueryResult> {
        return withRetry((baseUrl, accessToken) =>
          runJqlSearch(baseUrl, accessToken, jql, timeoutMs),
        );
      },

      async teardown(): Promise<void> {
        // fetch-based — no socket pool to release. Future refactors
        // that add a keep-alive agent stay backwards-compatible with
        // LazyPluginLoader's `evict` contract.
      },
    };

    log.info(
      { workspaceId, instanceUrl: activeBaseUrl, scope: bundle.scope },
      "Jira lazy plugin instantiated",
    );
    return instance;
  };
}
