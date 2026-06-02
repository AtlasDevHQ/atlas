/**
 * Linear LazyPluginLoader builders (#2750).
 *
 * Two builders that each produce a {@link LinearPluginInstance}; the
 * `createLinearIssue` agent tool dispatches through whichever install
 * is enabled for the active workspace:
 *
 *   1. {@link createLinearOAuthLazyBuilder} — reads the access token
 *      from `integration_credentials` and runs Jira-style refresh +
 *      retry on 401. Bound to `catalog:linear`.
 *   2. {@link createLinearApiKeyLazyBuilder} — decrypts the personal
 *      API key from `workspace_plugins.config` and uses it as the
 *      bearer directly. No refresh path — a rotated key requires the
 *      admin to re-submit the install form. Bound to
 *      `catalog:linear-apikey`.
 *
 * Both builders share the {@link runIssueCreate} helper so the GraphQL
 * mutation lives in one place; refresh / retry semantics differ only
 * by builder.
 *
 * Cache eviction (OAuth path): on permanent refresh failure, the shared
 * {@link createOAuthRetry} harness evicts THIS instance from the lazy
 * loader before re-throwing `IntegrationReconnectRequiredError`. Same wire
 * as Salesforce / Jira — keeps the agent from cycling through 401 /
 * refresh / fail on every call.
 *
 * @see packages/api/src/lib/integrations/_shared/oauth-retry.ts — shared retry harness
 * @see packages/api/src/lib/plugins/lazy-loader.ts — generic loader
 * @see ./../install/linear-token-refresh.ts — refresh + reconnect surface
 * @see ./../jira/lazy-builder.ts — sibling reference implementation
 */

import { createLogger } from "@atlas/api/lib/logger";
import { readCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import { decryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import {
  refreshLinearToken,
  IntegrationReconnectRequiredError,
} from "@atlas/api/lib/integrations/install/linear-token-refresh";
import { createOAuthRetry } from "@atlas/api/lib/integrations/_shared/oauth-retry";
import {
  LINEAR_APIKEY_CATALOG_ID,
  LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
} from "@atlas/api/lib/integrations/install/linear-apikey-secret-schema";
import {
  type LazyPluginBuilder,
  type LazyPluginBuilderArgs,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";

const log = createLogger("integrations.linear.lazy-builder");

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// ---------------------------------------------------------------------------
// Shape returned by `createLinearIssue` — also the tool's result shape.
// ---------------------------------------------------------------------------

export interface LinearIssueCreateInput {
  readonly title: string;
  readonly description?: string;
  readonly teamId?: string;
  readonly teamKey?: string;
  readonly priority?: number;
  readonly labelIds?: readonly string[];
}

export interface LinearIssueCreateResult {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
  readonly title: string;
}

/** Public shape exposed by both lazy-built Linear plugin instances. */
export interface LinearPluginInstance extends PluginLike {
  createLinearIssue(
    args: LinearIssueCreateInput,
    timeoutMs?: number,
  ): Promise<LinearIssueCreateResult>;
}

// ---------------------------------------------------------------------------
// Errors — narrow enough for tool-side branching without string matching.
// ---------------------------------------------------------------------------

/**
 * Linear's GraphQL endpoint returned 401, signalling the bearer token
 * was rejected. The OAuth builder catches this to trigger a refresh +
 * retry; the API-key builder treats it as a hard "rotate your key"
 * surface to the agent.
 */
class LinearUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearUnauthorizedError";
  }
}

function isUnauthorizedError(err: unknown): boolean {
  return err instanceof LinearUnauthorizedError;
}

/**
 * Linear's GraphQL endpoint returned errors that aren't auth-related —
 * scope mismatch, mutation rejected, validation. Surface the message
 * to the tool so the agent can decide whether to retry with different
 * arguments.
 */
export class LinearGraphQLError extends Error {
  readonly _tag = "LinearGraphQLError" as const;
  readonly upstreamMessage: string;
  constructor(upstreamMessage: string) {
    super(`Linear GraphQL rejected the request: ${upstreamMessage}`);
    this.name = "LinearGraphQLError";
    this.upstreamMessage = upstreamMessage;
  }
}

/**
 * Linear API-key install row contains a config that doesn't decrypt to
 * an `api_key` field. Surfaces as a tool error so the admin re-submits
 * the install form with a fresh key.
 */
export class LinearApiKeyMissingError extends Error {
  readonly _tag = "LinearApiKeyMissingError" as const;
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(
      `Linear API-key install for workspace ${workspaceId} is missing the decrypted api_key field — disconnect + reinstall`,
    );
    this.name = "LinearApiKeyMissingError";
    this.workspaceId = workspaceId;
  }
}

// ---------------------------------------------------------------------------
// Shared GraphQL helper — both builders call this.
// ---------------------------------------------------------------------------

/**
 * Linear's `issueCreate` mutation. Resolves the team via either
 * `teamId` (UUID) or `teamKey` (e.g. "ENG"); when neither is provided
 * the mutation looks up the bearer's default team via the `viewer`'s
 * first team membership — agent tools should prefer explicit `teamKey`
 * for predictability.
 */
async function runIssueCreate(
  bearerToken: string,
  args: LinearIssueCreateInput,
  timeoutMs: number,
): Promise<LinearIssueCreateResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // ── Resolve the team if only `teamKey` was supplied ─────────────
  // Linear's `issueCreate` mutation takes `teamId` (UUID), not key.
  // For tools that pass `teamKey` (the user-facing identifier — `"ENG"`)
  // we issue a small lookup first. Skipped when `teamId` is provided.
  let teamId = args.teamId;
  if (!teamId && args.teamKey) {
    teamId = await resolveTeamIdByKey(bearerToken, args.teamKey, controller, timeoutMs);
  }

  const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
      }
    }
  `;
  const input: Record<string, unknown> = {
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(teamId ? { teamId } : {}),
    ...(typeof args.priority === "number" ? { priority: args.priority } : {}),
    ...(args.labelIds && args.labelIds.length > 0
      ? { labelIds: Array.from(args.labelIds) }
      : {}),
  };

  let resp: Response;
  try {
    resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: mutation, variables: { input } }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Linear issueCreate timed out", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) {
    throw new LinearUnauthorizedError(
      `Linear API returned 401 — bearer token rejected`,
    );
  }

  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 500);
    } catch {
      // best-effort body capture for log forensics
    }
    throw new Error(`Linear API returned HTTP ${resp.status}: ${body}`);
  }

  let parsed: {
    data?: {
      issueCreate?: {
        success?: boolean;
        issue?: {
          id?: string;
          identifier?: string;
          url?: string;
          title?: string;
        };
      };
    };
    errors?: ReadonlyArray<{ message?: string }>;
  };
  try {
    parsed = (await resp.json()) as typeof parsed;
  } catch (err) {
    throw new Error(
      `Linear API response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (parsed.errors && parsed.errors.length > 0) {
    const first = parsed.errors[0]?.message ?? "unknown_graphql_error";
    throw new LinearGraphQLError(first);
  }

  const issue = parsed.data?.issueCreate?.issue;
  if (parsed.data?.issueCreate?.success !== true || !issue?.id) {
    throw new LinearGraphQLError(
      "issueCreate returned success=false without an issue payload",
    );
  }

  return {
    id: issue.id,
    identifier: issue.identifier ?? "",
    url: issue.url ?? "",
    title: issue.title ?? args.title,
  };
}

async function resolveTeamIdByKey(
  bearerToken: string,
  teamKey: string,
  controller: AbortController,
  timeoutMs: number,
): Promise<string | undefined> {
  // Tight inner timeout sized to a fraction of the outer one. If the
  // lookup hangs we still want enough room for the mutation itself.
  const innerTimeoutMs = Math.max(2000, Math.floor(timeoutMs / 3));
  const innerController = new AbortController();
  const innerTimer = setTimeout(() => innerController.abort(), innerTimeoutMs);
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      signal: innerController.signal,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: `query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
        variables: { key: teamKey },
      }),
    });
    if (resp.status === 401) {
      // Bubble through the same 401-handling path as the mutation.
      throw new LinearUnauthorizedError(
        `Linear API returned 401 during teamKey lookup`,
      );
    }
    if (!resp.ok) {
      // Non-fatal: continue without teamId so issueCreate falls back to
      // the bearer's default team. Logged so an operator can correlate.
      log.warn(
        { teamKey, status: resp.status },
        "Linear teamKey lookup non-2xx — falling back to default team",
      );
      return undefined;
    }
    const parsed = (await resp.json()) as {
      data?: { teams?: { nodes?: Array<{ id?: string; key?: string }> } };
    };
    const node = parsed.data?.teams?.nodes?.[0];
    return typeof node?.id === "string" ? node.id : undefined;
  } catch (err) {
    if (err instanceof LinearUnauthorizedError) throw err;
    log.warn(
      {
        teamKey,
        err: err instanceof Error ? err.message : String(err),
      },
      "Linear teamKey lookup threw — falling back to default team",
    );
    return undefined;
  } finally {
    clearTimeout(innerTimer);
    // The outer controller is still ticking; clear the inner aborter
    // without aborting the outer.
    if (!controller.signal.aborted) {
      // no-op — kept for symmetry / explicit lifetime tracking
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth builder — bound to `catalog:linear`
// ---------------------------------------------------------------------------

export interface LinearOAuthLazyBuilderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

function readInstallStatus(config: Record<string, unknown>): string {
  const status = config.status;
  return typeof status === "string" ? status : "ok";
}

export function createLinearOAuthLazyBuilder(
  config: LinearOAuthLazyBuilderConfig,
): LazyPluginBuilder {
  return async (args: LazyPluginBuilderArgs): Promise<LinearPluginInstance> => {
    const { workspaceId, catalogId } = args;
    const installConfig = args.config;

    const status = readInstallStatus(installConfig);
    if (status === "reconnect_needed") {
      throw new IntegrationReconnectRequiredError({
        message: "Linear install needs to be reconnected — workspace_plugins.config.status is reconnect_needed.",
        workspaceId,
        platform: "linear",
        upstreamError: "install_marked_reconnect_needed",
      });
    }

    let bundle: CredentialBundle | null;
    try {
      bundle = await readCredentialBundle(workspaceId, catalogId);
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt Linear credentials — refusing to instantiate plugin",
      );
      throw err;
    }
    if (!bundle) {
      throw new Error(
        `LazyPluginLoader: Linear OAuth install row exists but integration_credentials row is missing for workspace ${workspaceId} — disconnect + reinstall`,
      );
    }

    // Shared retry harness: on a 401 it runs `refreshLinearToken` (which
    // writes the rotated refresh_token to `integration_credentials` and
    // clears reconnect_needed) and retries once on the refreshed token.
    // On permanent refresh failure it evicts THIS cached instance before
    // re-throwing — same wire as Salesforce / Jira.
    const withRetry = createOAuthRetry<string>({
      workspaceId,
      catalogId,
      platformLabel: "Linear",
      logger: log,
      initialContext: bundle.accessToken,
      isSessionExpired: isUnauthorizedError,
      reconnectErrorClass: IntegrationReconnectRequiredError,
      refreshContext: async () => {
        const refreshed = await refreshLinearToken({
          workspaceId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        });
        return refreshed.accessToken;
      },
    });

    const instance: LinearPluginInstance = {
      id: `linear:${workspaceId}`,
      types: ["action"] as const,
      version: "0.1.0",
      name: "Linear",
      config: { scope: bundle.scope, mode: "oauth" },

      async createLinearIssue(
        input: LinearIssueCreateInput,
        timeoutMs = 30_000,
      ): Promise<LinearIssueCreateResult> {
        return withRetry((accessToken) => runIssueCreate(accessToken, input, timeoutMs));
      },

      async teardown(): Promise<void> {
        // fetch-based — no socket pool to release. Mirrors Jira's
        // builder shape.
      },
    };

    log.info(
      { workspaceId, mode: "oauth", scope: bundle.scope },
      "Linear OAuth lazy plugin instantiated",
    );
    return instance;
  };
}

// ---------------------------------------------------------------------------
// API-key builder — bound to `catalog:linear-apikey`
// ---------------------------------------------------------------------------

/**
 * Error class equivalent to {@link IntegrationReconnectRequiredError} (the
 * OAuth-path reconnect surface) but for the API-key install mode. Not part
 * of the Effect-tagged-error union because the API-key install has no
 * refresh flow — the surface is "rotate your key", not "re-run OAuth". The
 * tool layer catches `instanceof` and maps to its `apikey_rejected` status.
 */
export class LinearApiKeyRejectedError extends Error {
  readonly _tag = "LinearApiKeyRejectedError" as const;
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(
      `Linear rejected the stored API key for workspace ${workspaceId}. Rotate the key in Linear settings and re-submit the install form.`,
    );
    this.name = "LinearApiKeyRejectedError";
    this.workspaceId = workspaceId;
  }
}

/**
 * Decrypt-failure error — mirror {@link EmailDecryptFailureError} shape
 * so the tool layer's catch surface is uniform. Tool-internal; lives
 * here rather than `effect/errors.ts` because the API-key path doesn't
 * touch the Effect error hierarchy.
 */
export class LinearApiKeyDecryptFailureError extends Error {
  readonly _tag = "LinearApiKeyDecryptFailureError" as const;
  readonly workspaceId: string;
  constructor(workspaceId: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Linear API-key install decrypt failed for workspace ${workspaceId}: ${causeMessage}`);
    this.name = "LinearApiKeyDecryptFailureError";
    this.workspaceId = workspaceId;
    if (cause instanceof Error) this.cause = cause;
  }
}

function readApiKey(decrypted: Record<string, unknown>): string | null {
  const v = decrypted.api_key;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function createLinearApiKeyLazyBuilder(): LazyPluginBuilder {
  return async (args: LazyPluginBuilderArgs): Promise<LinearPluginInstance> => {
    const { workspaceId } = args;
    const installConfig = args.config;

    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(installConfig, LINEAR_APIKEY_SECRET_FIELDS_SCHEMA);
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt Linear API-key install config — refusing to instantiate plugin",
      );
      throw new LinearApiKeyDecryptFailureError(workspaceId, err);
    }

    const apiKey = readApiKey(decrypted);
    if (!apiKey) {
      throw new LinearApiKeyMissingError(workspaceId);
    }

    const instance: LinearPluginInstance = {
      id: `linear-apikey:${workspaceId}`,
      types: ["action"] as const,
      version: "0.1.0",
      name: "Linear (API Key)",
      config: {
        mode: "apikey",
        // Surface the workspace_name for log forensics — never the key.
        workspaceName:
          typeof decrypted.workspace_name === "string" ? decrypted.workspace_name : null,
      },

      async createLinearIssue(
        input: LinearIssueCreateInput,
        timeoutMs = 30_000,
      ): Promise<LinearIssueCreateResult> {
        try {
          return await runIssueCreate(apiKey, input, timeoutMs);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            // API keys don't refresh — re-throw as a key-rotation surface.
            throw new LinearApiKeyRejectedError(workspaceId);
          }
          throw err;
        }
      },

      async teardown(): Promise<void> {
        // fetch-based — no socket pool to release.
      },
    };

    log.info(
      {
        workspaceId,
        mode: "apikey",
        workspaceName:
          typeof decrypted.workspace_name === "string" ? decrypted.workspace_name : null,
      },
      "Linear API-key lazy plugin instantiated",
    );
    return instance;
  };
}

/** Catalog ids both builders register against — exported for the tool dispatch. */
export { LINEAR_APIKEY_CATALOG_ID };
export { LINEAR_CATALOG_ID } from "@atlas/api/lib/integrations/install/linear-oauth-handler";
