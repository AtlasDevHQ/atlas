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
 *      with `IntegrationReconnectRequiredError` (`platform: "jira"`) so
 *      the agent loop surfaces a specific "this install needs Reconnect"
 *      message rather than silently failing with a 401.
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
 * Refresh strategy: matches Salesforce — the shared {@link
 * createOAuthRetry} harness catches a 401, runs the refresh, and retries
 * once. Atlassian rotates the refresh token on every refresh (Salesforce
 * sometimes returns one, sometimes not), but that detail is hidden inside
 * `refreshJiraToken` which writes the rotated value back to
 * `integration_credentials`.
 *
 * Cache eviction: on permanent refresh failure, the retry harness evicts
 * THIS instance from the lazy loader before re-throwing
 * `IntegrationReconnectRequiredError`. Same wire as Salesforce — keeps the
 * agent from cycling through 401 / refresh / fail on every call.
 *
 * @see packages/api/src/lib/integrations/_shared/oauth-retry.ts — shared retry harness
 * @see packages/api/src/lib/plugins/lazy-loader.ts — generic loader
 * @see ./../install/jira-token-refresh.ts — refresh + reconnect surface
 * @see ./../salesforce/lazy-builder.ts — first reference implementation
 */

import { createLogger } from "@atlas/api/lib/logger";
import { readCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import {
  refreshJiraToken,
  IntegrationReconnectRequiredError,
} from "@atlas/api/lib/integrations/install/jira-token-refresh";
import { createOAuthRetry } from "@atlas/api/lib/integrations/_shared/oauth-retry";
import {
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
 * The lazy-OAuth retry context for Jira — the cloud-aware base URL plus
 * the live access token. The shared {@link createOAuthRetry} harness
 * swaps a fresh copy in after a successful mid-flight refresh.
 */
interface JiraCallContext {
  readonly baseUrl: string;
  readonly accessToken: string;
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
 *
 * Class-only check: `runJqlSearch` is the single 401 source and it
 * throws `JiraUnauthorizedError` exclusively. A previous string-match
 * fallback (`err.message.includes("401")`) was dropped because it
 * could match unrelated errors (e.g. a `4011` HTTP code, or a body
 * payload that happens to contain "401") and trigger spurious
 * refreshes.
 */
function isSessionExpiredError(err: unknown): boolean {
  return err instanceof JiraUnauthorizedError;
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
      throw new IntegrationReconnectRequiredError({
        message: "Jira install needs to be reconnected — workspace_plugins.config.status is reconnect_needed.",
        workspaceId,
        platform: "jira",
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
    let initialBaseUrl: string;
    if (bundle.instanceUrl && bundle.instanceUrl.length > 0) {
      initialBaseUrl = bundle.instanceUrl;
    } else {
      const cloudid = readCloudid(installConfig);
      if (!cloudid) {
        throw new Error(
          `LazyPluginLoader: Jira install for workspace ${workspaceId} has no cloudid`,
        );
      }
      initialBaseUrl = `https://api.atlassian.com/ex/jira/${cloudid}`;
    }

    // Shared retry harness: on a 401 it runs `refreshJiraToken` (which
    // writes the rotated refresh_token to `integration_credentials` and
    // clears reconnect_needed) and retries once against the refreshed
    // context. Atlassian's refresh may omit a new base URL, so
    // `refreshContext` falls back to the prior one. On permanent refresh
    // failure the harness evicts THIS cached instance before re-throwing.
    const withRetry = createOAuthRetry<JiraCallContext>({
      workspaceId,
      catalogId,
      platformLabel: "Jira",
      logger: log,
      initialContext: { baseUrl: initialBaseUrl, accessToken: bundle.accessToken },
      isSessionExpired: isSessionExpiredError,
      reconnectErrorClass: IntegrationReconnectRequiredError,
      refreshContext: async (current) => {
        const refreshed = await refreshJiraToken({
          workspaceId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        });
        const baseUrl =
          refreshed.instanceUrl && refreshed.instanceUrl.length > 0
            ? refreshed.instanceUrl
            : current.baseUrl;
        return { baseUrl, accessToken: refreshed.accessToken };
      },
    });

    const instance: JiraPluginInstance = {
      id: `jira:${workspaceId}`,
      types: ["datasource"] as const,
      version: "0.1.0",
      name: "Jira",
      config: { instanceUrl: initialBaseUrl, scope: bundle.scope },

      async queryJira(jql: string, timeoutMs = 30_000): Promise<JiraQueryResult> {
        return withRetry((ctx) => runJqlSearch(ctx.baseUrl, ctx.accessToken, jql, timeoutMs));
      },

      async teardown(): Promise<void> {
        // fetch-based — no socket pool to release. Future refactors
        // that add a keep-alive agent stay backwards-compatible with
        // LazyPluginLoader's `evict` contract.
      },
    };

    log.info(
      { workspaceId, instanceUrl: initialBaseUrl, scope: bundle.scope },
      "Jira lazy plugin instantiated",
    );
    return instance;
  };
}
