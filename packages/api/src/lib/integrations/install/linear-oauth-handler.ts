/**
 * `LinearOAuthInstallHandler` — third lazy OAuth integration (#2750).
 *
 * Mirrors {@link JiraOAuthInstallHandler}; Linear-specific structural
 * differences:
 *
 *   1. **Single authorize host.** Authorize at `linear.app/oauth/authorize`
 *      and exchange at `api.linear.app/oauth/token`. No per-tenant
 *      `loginUrl` (unlike Salesforce) and no `cloudid` second hop (unlike
 *      Atlassian) — the workspace is implicit in the OAuth grant.
 *   2. **Token endpoint is `application/x-www-form-urlencoded`.** Salesforce
 *      uses form-encoded too; Atlassian uses JSON. Linear matches Salesforce.
 *   3. **Refresh tokens rotate on every refresh.** Like Atlassian, the
 *      refresh flow MUST persist the new `refresh_token` back to
 *      `integration_credentials` — see {@link ./linear-token-refresh.ts}.
 *   4. **`actor=user` vs `actor=app` scope choice.** Linear's OAuth supports
 *      acting AS the granting user (`actor=user`, default) or AS the OAuth
 *      App itself (`actor=app`). We default to `actor=user` so issues
 *      created by Atlas attribute to the workspace admin who installed —
 *      not a generic "Atlas Bot" user that customers would have to
 *      separately discover and manage permissions for. The trade-off:
 *      access dies if the granting user is deactivated. Workspace admins
 *      can rotate by reinstalling.
 *   5. **`/viewer` discovery is a second hop.** After token exchange, the
 *      handler calls `POST api.linear.app/graphql` with `query { viewer
 *      { organization { id urlKey name } } }` to learn which Linear
 *      workspace was granted. The id + name persist on
 *      `workspace_plugins.config` for admin-UI display; no cloud-id-style
 *      routing identifier is needed for subsequent API calls.
 *
 * Atomicity per ADR-0003 (two-store install metadata + credentials) is
 * identical to Jira's: install row INSERT first, credential bundle
 * INSERT second, partial-failure flips
 * `workspace_plugins.config.status` to `"reconnect_needed"`.
 *
 * @see ../oauth-state-token.ts — state mint/verify primitives
 * @see ../credentials/store.ts — generic integration_credentials store
 * @see ./linear-token-refresh.ts — refresh-token rotation + reconnect surface
 * @see ./jira-oauth-handler.ts — sibling reference implementation (#2659)
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 * @see docs/adr/0005-integration-credentials-table.md
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { WorkspaceId } from "@useatlas/types";
import { mintOAuthStateToken } from "./oauth-state-token";
import { verifyCallbackState } from "./oauth-callback-verify";
import { writeCredentialWithReconnectFallback } from "./oauth-reconnect";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.linear");

/** Catalog row id seeded by `catalog-seeder.ts::upsertEntry` as `catalog:${slug}`. */
export const LINEAR_CATALOG_ID = "catalog:linear";

/** Catalog slug — the dispatch key, value bound into the state token. */
export const LINEAR_SLUG: CatalogId = "linear";

/**
 * Linear OAuth 2.0 endpoints. Hard-coded (no operator override) —
 * Linear doesn't expose region-specific hosts.
 */
const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Scopes requested at install time:
 *   - `read`        — read issues, projects, users via GraphQL. Required
 *                     for the `viewer` discovery hop and for any future
 *                     "look up the issue you just created" agent flows.
 *   - `write`       — create issues. The base "write" scope covers
 *                     `issueCreate` mutations.
 *   - `issues:create` — Linear's narrow per-action scope. Granted
 *                     redundantly with `write` so a future Linear
 *                     scope-tightening doesn't break Atlas without
 *                     re-issuing the OAuth dance.
 *
 * If the operator's App is configured with a tighter scope set, Linear
 * rejects the install with `invalid_scope`; the admin sees the effective
 * scope list in `workspace_plugins.config.scopes`.
 *
 * Format note: Linear's `/oauth/authorize` expects the `scope` param as a
 * **comma-separated** list (Linear-specific — distinct from the OAuth 2.0
 * spec's space-separated convention used by Slack/Atlassian). Linear's
 * `/oauth/token` response, conversely, echoes scopes as a **space-separated**
 * string (per their docs, for apps created after Dec 1 2023). We keep one
 * source of truth and serialize per-side.
 */
const LINEAR_SCOPES = ["read", "write", "issues:create"] as const;
const LINEAR_AUTHORIZE_SCOPE = LINEAR_SCOPES.join(",");
const LINEAR_DEFAULT_TOKEN_SCOPE = LINEAR_SCOPES.join(" ");

/**
 * Operator-side Linear OAuth App config. Read once from env in
 * `register.ts` and passed in.
 */
export interface LinearOAuthHandlerConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Public-facing OAuth callback URL — must match a Callback URL
   * configured on the operator's Linear OAuth Application.
   */
  readonly redirectUri: string;
}

// ---------------------------------------------------------------------------
// Linear token-response shape (subset we consume)
// ---------------------------------------------------------------------------

interface LinearTokenSuccess {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly scope?: string;
}

interface LinearTokenFailure {
  readonly error: string;
  readonly error_description?: string;
}

type LinearTokenResponse = LinearTokenSuccess | LinearTokenFailure;

function isTokenSuccess(response: LinearTokenResponse): response is LinearTokenSuccess {
  return "access_token" in response && typeof response.access_token === "string";
}

interface LinearViewerResponse {
  readonly data?: {
    readonly viewer?: {
      readonly id?: string;
      readonly name?: string;
      readonly email?: string;
      readonly organization?: {
        readonly id?: string;
        readonly urlKey?: string;
        readonly name?: string;
      };
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

/**
 * Hard timeout on the install-time Linear round-trips. A hung endpoint
 * would otherwise stall the OAuth callback request indefinitely. 15s is
 * generous for both `/oauth/token` (typically <1s) and `/graphql`
 * viewer query (typically <500ms).
 */
const INSTALL_FETCH_TIMEOUT_MS = 15_000;

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
// Token exchange — exposed so the refresh flow can call it too
// ---------------------------------------------------------------------------

interface TokenExchangeArgs {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
}

/**
 * POST `api.linear.app/oauth/token` with the auth code. Returns the
 * parsed JSON shape on success; throws `PlatformOAuthExchangeError`
 * on any non-2xx, network failure, or structurally invalid response.
 *
 * Linear's token endpoint takes form-encoded body (Salesforce-shaped,
 * not JSON-shaped like Atlassian). Documented at
 * https://developers.linear.app/docs/oauth/authentication.
 */
export async function exchangeAuthCodeForTokens(
  args: TokenExchangeArgs,
): Promise<LinearTokenSuccess> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
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
        ? "Linear token endpoint timed out — surfacing PlatformOAuthExchangeError"
        : "Linear token endpoint unreachable — surfacing PlatformOAuthExchangeError",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "Linear token endpoint timed out. Restart the install."
        : "Failed to reach Linear token endpoint. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: LinearTokenResponse;
  try {
    parsed = (await resp.json()) as LinearTokenResponse;
  } catch (err) {
    log.warn(
      {
        status: resp.status,
        err: err instanceof Error ? err.message : String(err),
      },
      "Linear token response body could not be parsed as JSON",
    );
    throw new PlatformOAuthExchangeError({
      message: "Linear returned an unparseable token response. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: `non-json ${resp.status}`,
    });
  }

  if (!resp.ok || !isTokenSuccess(parsed)) {
    const failure = parsed as LinearTokenFailure;
    throw new PlatformOAuthExchangeError({
      message: "Linear rejected the OAuth code. Restart the install from your Linear admin.",
      platform: LINEAR_SLUG,
      upstreamError: failure.error ?? `http_${resp.status}`,
    });
  }

  return parsed;
}

interface ViewerInfo {
  readonly userId: string | null;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly organizationUrlKey: string | null;
}

/**
 * Fetch the granting user + their Linear workspace via the GraphQL
 * `viewer` query. Returns a structurally validated subset for persistence
 * on `workspace_plugins.config`. Tolerates missing inner fields (Linear
 * may evolve the schema); only an outright transport / parse failure
 * throws.
 *
 * The handler does NOT depend on a non-null `organizationId` — Linear
 * always returns one in practice but the lazy builder doesn't require it
 * to call the API (the bearer token implicitly scopes to the granting
 * workspace). The id is persisted for admin-UI display, not for routing.
 */
export async function fetchLinearViewer(
  accessToken: string,
): Promise<ViewerInfo> {
  const query = `query { viewer { id name email organization { id urlKey name } } }`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query }),
      },
      INSTALL_FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn(
      { err: err instanceof Error ? err.message : String(err), timedOut: isAbort },
      isAbort
        ? "Linear /graphql viewer query timed out"
        : "Linear /graphql viewer query unreachable",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "Linear API timed out while confirming the install. Restart the install."
        : "Failed to reach Linear API while confirming the install. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  if (!resp.ok) {
    throw new PlatformOAuthExchangeError({
      message: "Linear rejected the viewer-confirmation request. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: `viewer_http_${resp.status}`,
    });
  }

  let parsed: LinearViewerResponse;
  try {
    parsed = (await resp.json()) as LinearViewerResponse;
  } catch (err) {
    throw new PlatformOAuthExchangeError({
      message: "Linear viewer query returned an unparseable response. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: err instanceof Error ? err.message : String(err),
    });
  }

  if (parsed.errors && parsed.errors.length > 0) {
    const first = parsed.errors[0]?.message ?? "unknown_graphql_error";
    throw new PlatformOAuthExchangeError({
      message: "Linear API rejected the viewer confirmation. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: `graphql:${first}`,
    });
  }

  const viewer = parsed.data?.viewer;
  if (!viewer) {
    throw new PlatformOAuthExchangeError({
      message: "Linear API returned no viewer for this OAuth grant. Restart the install.",
      platform: LINEAR_SLUG,
      upstreamError: "no_viewer",
    });
  }

  return {
    userId: typeof viewer.id === "string" ? viewer.id : null,
    userName: typeof viewer.name === "string" ? viewer.name : null,
    userEmail: typeof viewer.email === "string" ? viewer.email : null,
    organizationId:
      typeof viewer.organization?.id === "string" ? viewer.organization.id : null,
    organizationName:
      typeof viewer.organization?.name === "string" ? viewer.organization.name : null,
    organizationUrlKey:
      typeof viewer.organization?.urlKey === "string" ? viewer.organization.urlKey : null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class LinearOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  constructor(private readonly config: LinearOAuthHandlerConfig) {}

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, LINEAR_SLUG);
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", LINEAR_AUTHORIZE_SCOPE);
    url.searchParams.set("state", stateToken);
    // `prompt=consent` forces Linear's consent screen on every install —
    // even for an admin who has previously granted Atlas access. Without
    // it, Linear silently re-uses the prior grant and the customer admin
    // never sees what Atlas is asking for on a re-install.
    url.searchParams.set("prompt", "consent");
    // `actor=user` is the default but we set it explicitly so the
    // attribution semantic is on the URL (audit-grep-able). Atlas
    // creates issues that attribute to the granting user, not to a
    // separate "Atlas Bot" user. See the file header for the trade-off.
    url.searchParams.set("actor", "user");
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
    // ── 1. Verify state + catalog binding (shared seam) ──────────
    const verified = verifyCallbackState(
      stateToken,
      LINEAR_SLUG,
      log,
      "Linear OAuth callback received state bound to a different catalog — rejecting",
    );
    if (!verified) return null;
    const { workspaceId } = verified;

    // ── 2. Exchange code for tokens ───────────────────────────────
    const tokens = await exchangeAuthCodeForTokens({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      code,
    });

    // ── 3. Discover viewer + organization ────────────────────────
    // Used purely for admin-UI display ("Connected to <Linear workspace name>")
    // and forensics. The bearer token implicitly scopes API calls to the
    // granting workspace, so no routing identifier is needed.
    const viewer = await fetchLinearViewer(tokens.access_token);

    const scopes = tokens.scope ?? LINEAR_DEFAULT_TOKEN_SCOPE;
    const tokenType = tokens.token_type ?? "Bearer";
    const expiresAt =
      typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : null;

    // ── 4. Install record — workspace_plugins INSERT (first store) ──
    // Operator-visible fields land in `config`; the credential bundle
    // (access + refresh token) lands in `integration_credentials` in
    // step 5. Status seeds as `"ok"`; the refresh flow flips it to
    // `"reconnect_needed"` on permanent failure.
    //
    // Per migration 0092 (#2739) the INSERT names `pillar` and
    // `install_id` explicitly — pillar='action' for Linear (Atlas writes
    // to Linear, not chat) and `install_id` is the same UUID as `id`
    // because action-pillar installs are singletons per (workspace,
    // catalog) under the partial unique index
    // `workspace_plugins_singleton`. Newer pattern than Jira's
    // pre-0092 trigger-derived shape (see discord-static-bot-handler.ts
    // for the same explicit-pillar idiom in newer code).
    const installId = crypto.randomUUID();
    const installConfig: Record<string, unknown> = {
      scopes,
      status: "ok",
      ...(viewer.organizationId ? { organization_id: viewer.organizationId } : {}),
      ...(viewer.organizationName ? { organization_name: viewer.organizationName } : {}),
      ...(viewer.organizationUrlKey ? { organization_url_key: viewer.organizationUrlKey } : {}),
      ...(viewer.userId ? { user_id: viewer.userId } : {}),
      ...(viewer.userName ? { user_name: viewer.userName } : {}),
      ...(viewer.userEmail ? { user_email: viewer.userEmail } : {}),
    };
    try {
      await internalQuery(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'action', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true`,
        [installId, workspaceId, LINEAR_CATALOG_ID, JSON.stringify(installConfig)],
      );
    } catch (err) {
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to write workspace_plugins install record — aborting Linear install",
      );
      throw err;
    }

    const installRecord: InstallRecord = {
      id: installId,
      workspaceId,
      catalogId: LINEAR_SLUG,
    };

    // ── 5. Credential — integration_credentials INSERT (second store) ──
    // `instanceUrl` is the Linear GraphQL endpoint. There's no per-
    // tenant variation today; the field is populated so the bundle
    // shape stays uniform across platforms (Jira / Salesforce both
    // carry a per-tenant URL here).
    const bundle: CredentialBundle = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      tokenType,
      scope: scopes,
      instanceUrl: GRAPHQL_URL,
    };

    // Persist the credential bundle (ADR-0003 SECOND write) with the
    // shared fail-closed Reconnect fallback: a credential-write failure
    // flips `status: "reconnect_needed"` so the admin card surfaces a
    // persistent Reconnect CTA (without it the callback's `?reconnect=linear`
    // query param shows once then vanishes on the next page load).
    return writeCredentialWithReconnectFallback({
      workspaceId,
      catalogId: LINEAR_CATALOG_ID,
      slug: LINEAR_SLUG,
      bundle,
      installRecord,
      log,
      displayName: "Linear",
      successLogFields: {
        organizationId: viewer.organizationId,
        organizationName: viewer.organizationName,
      },
    });
  }
}
