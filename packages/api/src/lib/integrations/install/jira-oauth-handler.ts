/**
 * `JiraOAuthInstallHandler` — second lazy OAuth integration (#2659).
 *
 * Mirrors {@link SalesforceOAuthInstallHandler}; the structural
 * differences with Atlassian's OAuth 2.0 3LO flow are:
 *
 *   1. **Two authorize hosts.** Authorize / token live at
 *      `https://auth.atlassian.com/{authorize,oauth/token}` regardless
 *      of which Atlassian Cloud the customer eventually picks — there
 *      is no per-tenant `loginUrl` to honour at start-install time.
 *   2. **`cloudid` discovery is a second hop.** After token exchange,
 *      the handler calls `GET https://api.atlassian.com/oauth/token/
 *      accessible-resources` with the bearer token to learn which
 *      Atlassian Cloud the user just connected. The first resource's
 *      `id` is persisted on `workspace_plugins.config.cloudid`. Per the
 *      #2659 issue body, one Atlas Workspace = one Atlassian Cloud, so
 *      we take `[0]` rather than offering a picker. Future multi-cloud
 *      semantics would surface a UI choice between install and persist.
 *   3. **`audience=api.atlassian.com` query param on `/authorize`.**
 *      Required by Atlassian 3LO; without it the dance redirects back
 *      with `invalid_request`.
 *   4. **Refresh-token rotation on every refresh.** Atlassian *rotates*
 *      refresh tokens (Salesforce sometimes returns one, sometimes
 *      not). The refresh flow in {@link ./jira-token-refresh.ts} writes
 *      the new `refresh_token` back to `integration_credentials` on
 *      every successful refresh; failing to do so wedges the install
 *      on the next refresh.
 *
 * Atomicity per ADR-0003 (two-store install metadata + credentials):
 *
 *   1. `workspace_plugins` row INSERT — install metadata (catalog
 *      binding + `cloudid` + scopes + status). Failure aborts.
 *   2. `integration_credentials` row INSERT/UPDATE — credentials.
 *      Failure here returns the install record with
 *      `credentialResult.written: false`, flips
 *      `workspace_plugins.config.status` to `"reconnect_needed"`, and
 *      the OAuth callback redirects to
 *      `/admin/integrations?reconnect=jira`. Re-running the dance
 *      retries step 2 (step 1 is an upsert under the unique index) and
 *      clears the status back to `"ok"` on success.
 *
 *   No roll-back of step 1 on step 2 failure — see ADR-0003.
 *
 * @see ../oauth-state-token.ts — state mint/verify primitives
 * @see ../credentials/store.ts — generic integration_credentials store
 * @see ./jira-token-refresh.ts — refresh-token rotation + reconnect surface
 * @see ./salesforce-oauth-handler.ts — first reference implementation (#2658)
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 * @see docs/adr/0005-integration-credentials-table.md
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { saveCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import { persistInstallRecord } from "./persist-form-install";
import type { WorkspaceId } from "@useatlas/types";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "./oauth-state-token";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.jira");

/** Catalog row id seeded by `catalog-seeder.ts::upsertEntry` as `catalog:${slug}`. */
export const JIRA_CATALOG_ID = "catalog:jira";

/** Catalog slug — the dispatch key, value bound into the state token. */
export const JIRA_SLUG: CatalogId = "jira";

/**
 * Atlassian OAuth 2.0 (3LO) endpoints. Hard-coded (no operator
 * override) because — unlike Salesforce — Atlassian doesn't expose a
 * sandbox login host; staging instances all go through the same
 * `auth.atlassian.com` front door.
 */
const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * Scopes requested at install time:
 *   - `read:jira-work`    — query issues + boards via JQL search.
 *   - `read:jira-user`    — resolve assignees / reporters to user
 *                           display names in result rows.
 *   - `offline_access`    — receive + rotate a `refresh_token`. Without
 *                           this Atlassian doesn't issue a refresh
 *                           token and the install would die after the
 *                           first access-token expiry.
 *
 * If the operator's App is configured with a tighter scope set,
 * Atlassian rejects the install dance with `invalid_scope`; the admin
 * sees the effective scope list in `workspace_plugins.config.scopes`.
 */
const JIRA_SCOPES = "read:jira-work read:jira-user offline_access";

/**
 * Operator-side Jira OAuth App config. Read once from env in
 * `register.ts` and passed in.
 */
export interface JiraOAuthHandlerConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Public-facing OAuth callback URL — must match a Callback URL
   * configured on the operator's Atlassian OAuth 2.0 (3LO) integration.
   */
  readonly redirectUri: string;
}

// ---------------------------------------------------------------------------
// Atlassian token-response shape (subset we consume)
// ---------------------------------------------------------------------------

interface JiraTokenSuccess {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly scope?: string;
}

interface JiraTokenFailure {
  readonly error: string;
  readonly error_description?: string;
}

type JiraTokenResponse = JiraTokenSuccess | JiraTokenFailure;

function isTokenSuccess(response: JiraTokenResponse): response is JiraTokenSuccess {
  return "access_token" in response && typeof response.access_token === "string";
}

interface AccessibleResource {
  readonly id: string;
  readonly url?: string;
  readonly name?: string;
  readonly scopes?: readonly string[];
}

/**
 * Hard timeout on the install-time Atlassian round-trips. A hung
 * endpoint would otherwise stall the OAuth callback request
 * indefinitely (the install caller is a synchronous HTTP handler).
 * 15s is generous for both `oauth/token` (typically <1s) and
 * `accessible-resources` (typically <500ms).
 */
const INSTALL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch with an AbortController-based timeout. Returns the Response on
 * success; the AbortError surface bubbles up so the caller's existing
 * `catch` block can wrap it as a `PlatformOAuthExchangeError`. We
 * don't catch+wrap here so the original `err.message` survives the
 * upstreamError forensics.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Token exchange — extracted so the refresh-token flow can reuse it
// ---------------------------------------------------------------------------

interface TokenExchangeArgs {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
}

/**
 * POST `auth.atlassian.com/oauth/token` with the auth code. Returns the
 * parsed JSON shape on success; throws `PlatformOAuthExchangeError` on
 * any non-2xx, network failure, or structurally invalid response.
 *
 * Atlassian's token endpoint takes a JSON body (not form-encoded like
 * Salesforce's). The `grant_type: authorization_code` shape is
 * documented at
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/.
 */
export async function exchangeAuthCodeForTokens(
  args: TokenExchangeArgs,
): Promise<JiraTokenSuccess> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: args.clientId,
          client_secret: args.clientSecret,
          code: args.code,
          redirect_uri: args.redirectUri,
        }),
      },
      INSTALL_FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        timedOut: isAbort,
      },
      isAbort
        ? "Atlassian token endpoint timed out — surfacing PlatformOAuthExchangeError"
        : "Atlassian token endpoint unreachable — surfacing PlatformOAuthExchangeError",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "Atlassian token endpoint timed out. Restart the install."
        : "Failed to reach Atlassian token endpoint. Restart the install.",
      platform: JIRA_SLUG,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: JiraTokenResponse;
  try {
    parsed = (await resp.json()) as JiraTokenResponse;
  } catch (err) {
    log.warn(
      {
        status: resp.status,
        err: err instanceof Error ? err.message : String(err),
      },
      "Atlassian token response body could not be parsed as JSON",
    );
    throw new PlatformOAuthExchangeError({
      message: "Atlassian returned an unparseable token response. Restart the install.",
      platform: JIRA_SLUG,
      upstreamError: `non-json ${resp.status}`,
    });
  }

  if (!resp.ok || !isTokenSuccess(parsed)) {
    const failure = parsed as JiraTokenFailure;
    throw new PlatformOAuthExchangeError({
      message: "Atlassian rejected the OAuth code. Restart the install from your Jira admin.",
      platform: JIRA_SLUG,
      upstreamError: failure.error ?? `http_${resp.status}`,
    });
  }

  return parsed;
}

/**
 * Fetch the list of Atlassian Clouds the user just connected to. The
 * first entry's `id` is the `cloudid` we persist (per the #2659 "one
 * Atlas Workspace = one Atlassian Cloud" rule). Returns the full list
 * so the caller can log scope + url for diagnostics.
 *
 * Throws `PlatformOAuthExchangeError` when Atlassian returns an empty
 * list (the OAuth dance technically succeeded but the user has no
 * Atlassian Clouds the App can reach — installing this credential
 * would orphan it).
 */
export async function fetchAccessibleResources(
  accessToken: string,
): Promise<readonly AccessibleResource[]> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      ACCESSIBLE_RESOURCES_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      INSTALL_FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        timedOut: isAbort,
      },
      isAbort
        ? "Atlassian accessible-resources endpoint timed out"
        : "Atlassian accessible-resources endpoint unreachable",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "Atlassian accessible-resources endpoint timed out. Restart the install."
        : "Failed to reach Atlassian accessible-resources endpoint. Restart the install.",
      platform: JIRA_SLUG,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  if (!resp.ok) {
    throw new PlatformOAuthExchangeError({
      message: "Atlassian rejected the accessible-resources request. Restart the install.",
      platform: JIRA_SLUG,
      upstreamError: `accessible_resources_http_${resp.status}`,
    });
  }

  let resources: readonly AccessibleResource[];
  try {
    resources = (await resp.json()) as readonly AccessibleResource[];
  } catch (err) {
    throw new PlatformOAuthExchangeError({
      message: "Atlassian accessible-resources returned an unparseable response. Restart the install.",
      platform: JIRA_SLUG,
      upstreamError: err instanceof Error ? err.message : String(err),
    });
  }

  if (!Array.isArray(resources) || resources.length === 0) {
    throw new PlatformOAuthExchangeError({
      message: "Atlassian returned no accessible Clouds for this OAuth grant. Install Atlas's app into a Jira Cloud workspace and restart.",
      platform: JIRA_SLUG,
      upstreamError: "no_accessible_resources",
    });
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class JiraOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  constructor(private readonly config: JiraOAuthHandlerConfig) {}

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, JIRA_SLUG);
    const url = new URL(AUTHORIZE_URL);
    // `audience=api.atlassian.com` is required by Atlassian 3LO — without
    // it the authorize endpoint redirects back with `invalid_request`.
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", JIRA_SCOPES);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", stateToken);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "consent");
    return { redirectUrl: url.toString(), stateToken };
  }

  async handleCallback(
    code: string,
    stateToken: string,
  ): Promise<{
    readonly workspaceId: WorkspaceId;
    readonly catalogId: CatalogId;
    readonly installRecord: InstallRecord;
    readonly credentialResult: CredentialResult;
  } | null> {
    // ── 1. Verify state — null on every failure mode ─────────────
    const verified = verifyOAuthStateToken(stateToken);
    if (!verified) return null;
    const workspaceId = verified.workspaceId as WorkspaceId;
    if (verified.catalogId !== JIRA_SLUG) {
      log.warn(
        { expected: JIRA_SLUG, got: verified.catalogId },
        "Jira OAuth callback received state bound to a different catalog — rejecting",
      );
      return null;
    }

    // ── 2. Exchange code for tokens ───────────────────────────────
    const tokens = await exchangeAuthCodeForTokens({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      code,
    });

    // ── 3. Discover cloudid ───────────────────────────────────────
    // Atlassian doesn't return the cloudid in the token response — it
    // comes from a separate accessible-resources call. We pick `[0]`
    // per the #2659 one-Atlas-Workspace = one-Atlassian-Cloud rule.
    // `fetchAccessibleResources` throws on empty, so destructuring +
    // explicit null guard sidesteps the non-null assertion (per
    // CLAUDE.md "minimize non-null assertions").
    const resources = await fetchAccessibleResources(tokens.access_token);
    const [primaryResource, ...otherResources] = resources;
    if (!primaryResource) {
      // Defensive — `fetchAccessibleResources` already rejects empty
      // arrays, but TS narrows the destructure to `T | undefined` so
      // we exhaustively handle it. Treating an empty array post-throw
      // as a fresh PlatformOAuthExchangeError keeps the user-facing
      // copy consistent with the upstream-empty branch.
      throw new PlatformOAuthExchangeError({
        message: "Atlassian returned no accessible Clouds for this OAuth grant. Install Atlas's app into a Jira Cloud workspace and restart.",
        platform: JIRA_SLUG,
        upstreamError: "no_accessible_resources_post_fetch",
      });
    }
    if (otherResources.length > 0) {
      // The #2659 rule binds one Atlas Workspace to one Atlassian
      // Cloud — but the OAuth grant may cover several. Log the picked
      // vs available so an operator dogfooding multi-Cloud setups can
      // see WHICH Cloud got bound without decrypting the credential
      // row or grepping the audit log. Future multi-Cloud semantics
      // would surface a picker between the OAuth callback and the
      // install write.
      log.info(
        {
          workspaceId,
          picked: { id: primaryResource.id, url: primaryResource.url },
          alsoAvailable: otherResources.map((r) => ({ id: r.id, url: r.url })),
        },
        "Atlassian OAuth grant covers multiple Clouds — bound to the first per one-Workspace = one-Cloud rule",
      );
    }
    const cloudid = primaryResource.id;

    const scopes = tokens.scope ?? JIRA_SCOPES;
    const tokenType = tokens.token_type ?? "Bearer";
    // Atlassian returns `expires_in` (seconds). Compute the absolute
    // expiry ms so the credential store doesn't need to remember when
    // it was issued.
    const expiresAt =
      typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : null;

    // ── 4. Install record — workspace_plugins INSERT (first store) ──
    // `cloudid` lives operator-visible alongside `status` so the admin
    // UI / lazy-builder can read it without decrypting the credential
    // bundle. `status: "ok"` is the default; refresh flow flips to
    // `"reconnect_needed"` on permanent failure.
    const installConfig: Record<string, unknown> = {
      cloudid,
      scopes,
      status: "ok",
      ...(primaryResource.url ? { site_url: primaryResource.url } : {}),
      ...(primaryResource.name ? { site_name: primaryResource.name } : {}),
    };
    const persistedId = await persistInstallRecord({
      workspaceId,
      catalogId: JIRA_CATALOG_ID,
      displayName: "Jira",
      log,
      config: installConfig,
      persistFailureMessage:
        "Failed to write workspace_plugins install record — aborting Jira install",
      failureLogFields: { cloudid },
    });

    const installRecord: InstallRecord = {
      // On a re-install the upsert RETURNING yields the existing row's
      // id, not a freshly-generated candidate — persistInstallRecord
      // returns the persisted one.
      id: persistedId,
      workspaceId,
      catalogId: JIRA_SLUG,
    };

    // ── 5. Credential — integration_credentials INSERT (second store) ──
    // `instanceUrl` carries the per-cloud API host (`api.atlassian.com/
    // ex/jira/<cloudid>`) so the lazy-builder can construct API URLs
    // without re-reading the install config. Per CredentialBundle's
    // shape, `instanceUrl` is the canonical cross-platform "where do I
    // call?" field.
    const bundle: CredentialBundle = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      tokenType,
      scope: scopes,
      instanceUrl: `https://api.atlassian.com/ex/jira/${cloudid}`,
    };

    try {
      await saveCredentialBundle(workspaceId, JIRA_CATALOG_ID, bundle);
      log.info(
        { workspaceId, cloudid, siteUrl: primaryResource.url },
        "Jira install completed (both stores written)",
      );
      return {
        workspaceId,
        catalogId: JIRA_SLUG,
        installRecord,
        credentialResult: { written: true },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, cloudid, err: errMessage },
        "Jira install record written but integration_credentials write failed — Reconnect required",
      );
      // Mirror Salesforce: flip `status: "reconnect_needed"` so the
      // admin card surfaces a persistent Reconnect CTA. Without this,
      // the OAuth callback's `?reconnect=jira` query param shows once
      // and then disappears on the next admin-page reload.
      try {
        await internalQuery(
          `UPDATE workspace_plugins
              SET config = config || jsonb_build_object('status', 'reconnect_needed')
            WHERE workspace_id = $1 AND catalog_id = $2`,
          [workspaceId, JIRA_CATALOG_ID],
        );
      } catch (statusErr) {
        log.warn(
          {
            workspaceId,
            err: statusErr instanceof Error ? statusErr.message : String(statusErr),
          },
          "Failed to mark Jira install as reconnect_needed after credential write failure",
        );
      }
      return {
        workspaceId,
        catalogId: JIRA_SLUG,
        installRecord,
        credentialResult: {
          written: false,
          reason: "Credential persist failed — admin should retry via Reconnect",
        },
      };
    }
  }
}
