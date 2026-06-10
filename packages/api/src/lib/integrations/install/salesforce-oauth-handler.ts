/**
 * `SalesforceOAuthInstallHandler` — first lazy OAuth integration (#2658).
 *
 * Implements {@link OAuthPlatformInstallHandler} for Salesforce. Parallel
 * to {@link SlackOAuthInstallHandler}, with two structural differences
 * that establish the pattern future OAuth integrations (Jira / etc.)
 * reuse:
 *
 *   1. Credentials persist in the dedicated `integration_credentials`
 *      table (encrypted JSON blob: access_token + refresh_token +
 *      expires_at + instance_url + scope + token_type) rather than
 *      `chat_cache`. The `integration_credentials` table lands in
 *      migration 0089 with this slice — see ADR-0005.
 *   2. The install record's `workspace_plugins.config` JSONB carries
 *      operator-visible Salesforce fields (`instance_url`, `org_id`,
 *      `org_user_id`, `scopes`, `status`). `instance_url` doubles in
 *      both stores intentionally — admin-UI reads need it without
 *      decrypting the credential bundle, and the plugin needs it
 *      inside the bundle to make API calls.
 *
 * Atomicity per ADR-0003 (two-store install metadata + credentials):
 *
 *   1. `workspace_plugins` row INSERT — install metadata, FK to
 *      `plugin_catalog`. Failure aborts the flow; without it the
 *      credential is unreachable.
 *   2. `integration_credentials` row INSERT/UPDATE — credentials.
 *      Failure here returns the install record with
 *      `credentialResult.written: false`, flips
 *      `workspace_plugins.config.status` to `"reconnect_needed"` so the
 *      admin card surfaces a persistent Reconnect CTA, and the OAuth
 *      callback route redirects to
 *      `/admin/integrations?reconnect=salesforce`. Re-running the dance
 *      retries step 2 (step 1 is an upsert under the unique index) and
 *      clears the status back to `"ok"` on success.
 *
 *   No roll-back of step 1 on step 2 failure — see ADR-0003.
 *
 * Salesforce OAuth specifics:
 *
 *   - Authorize endpoint: `<loginUrl>/services/oauth2/authorize`
 *   - Token endpoint:     `<loginUrl>/services/oauth2/token`
 *   - Per-tenant `instance_url` returned in the token response —
 *     required for every subsequent API call. The login host vs. the
 *     instance host can differ (admin signs in via login.salesforce.com,
 *     but their data lives on na139.my.salesforce.com); always use
 *     `instance_url` from the token exchange, never the login host.
 *   - Scopes: `api refresh_token offline_access` — `api` for SOQL,
 *     `refresh_token` to receive one, `offline_access` to keep it.
 *   - Refresh: `grant_type=refresh_token` with the stored refresh token.
 *     On refresh_token revocation (e.g. admin revoked the Connected App)
 *     Salesforce returns `invalid_grant` and the install must be
 *     flagged `status: "reconnect_needed"` in `workspace_plugins.config`.
 *     Refresh-token rotation lives in `./salesforce-token-refresh.ts`.
 *
 * @see ../oauth-state-token.ts — state mint/verify primitives
 * @see ../credentials/store.ts — generic integration_credentials store
 * @see ./salesforce-token-refresh.ts — refresh-token rotation + reconnect surface
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 * @see docs/adr/0005-integration-credentials-table.md
 */

import { Data } from "effect";
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

const log = createLogger("integrations.install.salesforce");

/** Catalog row id seeded by `catalog-seeder.ts::upsertEntry` as `catalog:${slug}`. */
export const SALESFORCE_CATALOG_ID = "catalog:salesforce";

/** Catalog slug — the dispatch key, value bound into the state token. */
export const SALESFORCE_SLUG: CatalogId = "salesforce";

/**
 * Default access-token lifetime (ms). Salesforce does NOT return
 * `expires_in` in the token response — the operator configures session
 * timeout per Connected App, and the value isn't surfaced over OAuth.
 * 2h is conservative for the common case; the refresh flow doesn't
 * trust this value — it only uses it as a "should I pre-emptively
 * refresh?" hint. The actual session expiry is detected at query time
 * via `INVALID_SESSION_ID` and triggers refresh + retry inline.
 *
 * Re-exported by `./salesforce-token-refresh.ts` so both the install
 * handler and the refresh flow use the same constant.
 */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * Scopes requested at install time:
 *   - `api`              — make SOQL / REST API calls.
 *   - `refresh_token`    — receive a refresh_token in the token response.
 *   - `offline_access`   — keep the refresh_token valid when the user
 *                          isn't actively logged in.
 *
 * If the operator's Connected App is configured with a tighter scope
 * set, Salesforce will downgrade silently; the admin sees the
 * effective scope list in `workspace_plugins.config.scopes`.
 */
const SALESFORCE_SCOPES = "api refresh_token offline_access";

/**
 * Operator-side Salesforce Connected App config. Read once from env in
 * `register.ts` and passed in. `loginUrl` defaults to the production
 * Salesforce login host; operators on a Sandbox should set
 * `SALESFORCE_LOGIN_URL=https://test.salesforce.com`.
 */
export interface SalesforceOAuthHandlerConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Public-facing OAuth callback URL — must match the "Callback URL"
   * field of the operator's Salesforce Connected App.
   */
  readonly redirectUri: string;
  /**
   * Salesforce login host. Defaults to `https://login.salesforce.com`.
   * Set to `https://test.salesforce.com` for Sandboxes.
   */
  readonly loginUrl?: string;
}

const DEFAULT_LOGIN_URL = "https://login.salesforce.com";

/**
 * Legacy-pillar converge (deliberate ADR-0014 divergence): pre-0096
 * Salesforce OAuth install rows carry `pillar='datasource'` — the
 * catalog row's ADR-0006 pillar at 0092-backfill time (migration
 * 0103's backstory; 0103 converged only the CATALOG row). The
 * `workspace_plugins_singleton` unique index covers chat/action only,
 * so without this converge the install upsert would INSERT a duplicate
 * (workspace_id, catalog_id) row beside the legacy one instead of
 * updating it — and LazyPluginLoader's un-ordered `LIMIT 1` read would
 * then serve an arbitrary row's config. NOT EXISTS guards the
 * singleton index (never converge beside an existing chat/action row);
 * no-op on fresh installs. Safe per ADR-0014: Salesforce is
 * handler-managed, never bridge-managed, so a datasource-pillar row
 * here can only be the legacy OAuth shape — and the pre-0096 unique
 * index guarantees at most one.
 *
 * Exported so the colocated real-Postgres suite executes this exact
 * string against the live schema — mocked handler tests can't see
 * plan-time SQL errors (the drift class that produced #3357).
 */
export const SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL = `UPDATE workspace_plugins
    SET pillar = 'action'
  WHERE workspace_id = $1 AND catalog_id = $2 AND pillar = 'datasource'
    AND NOT EXISTS (
      SELECT 1 FROM workspace_plugins
       WHERE workspace_id = $1 AND catalog_id = $2
         AND pillar IN ('chat', 'action')
    )`;

/**
 * Strip a trailing slash so URL concatenation stays clean. The login
 * host is operator-supplied env; defensive normalization avoids a
 * `//` in the authorize URL on a careless env value.
 */
function normalizeLoginUrl(value: string | undefined): string {
  const raw = value && value.length > 0 ? value : DEFAULT_LOGIN_URL;
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Internal failure tag (kept symmetrical with the Slack handler)
// ---------------------------------------------------------------------------

class IncompleteOAuthResponseError extends Data.TaggedError("IncompleteOAuthResponseError")<{
  readonly message: string;
  readonly hasAccessToken: boolean;
  readonly hasInstanceUrl: boolean;
}> {}

// ---------------------------------------------------------------------------
// Salesforce token-response shape (subset we consume)
// ---------------------------------------------------------------------------

interface SalesforceTokenSuccess {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly instance_url: string;
  readonly id?: string;
  readonly token_type?: string;
  readonly issued_at?: string;
  readonly scope?: string;
  readonly id_token?: string;
}

interface SalesforceTokenFailure {
  readonly error: string;
  readonly error_description?: string;
}

type SalesforceTokenResponse = SalesforceTokenSuccess | SalesforceTokenFailure;

function isTokenSuccess(response: SalesforceTokenResponse): response is SalesforceTokenSuccess {
  return "access_token" in response && typeof response.access_token === "string";
}

/**
 * Parse a Salesforce `id` URL into `{ orgId, userId }`. The `id` field
 * is a URL of the shape `https://login.salesforce.com/id/<org>/<user>`;
 * we extract both segments for operator-visible storage in the install
 * config. Returns `null` on parse failure — fields are best-effort and
 * not required for the credential exchange to succeed.
 */
function parseSalesforceIdUrl(idUrl: string | undefined): { orgId: string; userId: string } | null {
  if (!idUrl) return null;
  try {
    const { pathname } = new URL(idUrl);
    const parts = pathname.split("/").filter((s) => s.length > 0);
    const idx = parts.indexOf("id");
    if (idx === -1 || idx + 2 >= parts.length) return null;
    return { orgId: parts[idx + 1], userId: parts[idx + 2] };
  } catch {
    return null;
  }
}

/**
 * Compute an absolute `expires_at` (ms since epoch) from Salesforce's
 * `issued_at` (string ms-epoch) + an assumed default lifetime. Salesforce
 * does NOT return `expires_in` in the token response — the operator
 * configures session timeout per Connected App. We use 2 hours as a
 * conservative default; the refresh flow re-checks against the upstream
 * if the cached value drifts.
 *
 * Returns `null` when `issued_at` is missing — callers treat that as
 * "non-expiring, refresh only on 401."
 */
function computeExpiresAt(issuedAt: string | undefined): number | null {
  if (!issuedAt) return null;
  const issuedMs = Number.parseInt(issuedAt, 10);
  if (!Number.isFinite(issuedMs)) return null;
  return issuedMs + DEFAULT_ACCESS_TOKEN_LIFETIME_MS;
}

// ---------------------------------------------------------------------------
// Token exchange — extracted so the refresh-token flow can reuse it
// ---------------------------------------------------------------------------

interface TokenExchangeArgs {
  readonly loginUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
}

/**
 * POST `<loginUrl>/services/oauth2/token` with the auth code. Returns
 * the parsed JSON shape on success; throws `PlatformOAuthExchangeError`
 * on any non-2xx, network failure, or structurally invalid response.
 *
 * Exported so the refresh-token flow in
 * {@link ./salesforce-token-refresh.ts} can share the same HTTP +
 * parsing surface — keeping the OAuth wire format in one place.
 */
export async function exchangeAuthCodeForTokens(
  args: TokenExchangeArgs,
): Promise<SalesforceTokenSuccess> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
  });

  let resp: Response;
  try {
    resp = await fetch(`${args.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    // `PlatformOAuthExchangeError` doesn't carry a `cause` field — log
    // the raw error (stack + message) before throwing so the operator
    // has enough to debug the network-level failure (DNS, TLS, etc.).
    // The tagged error's `upstreamError` keeps the short signal for
    // forensics; the warn log keeps the full context.
    log.warn(
      {
        loginUrl: args.loginUrl,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Salesforce token endpoint unreachable — surfacing PlatformOAuthExchangeError",
    );
    throw new PlatformOAuthExchangeError({
      message: "Failed to reach Salesforce token endpoint. Restart the install.",
      platform: SALESFORCE_SLUG,
      upstreamError: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: SalesforceTokenResponse;
  try {
    parsed = (await resp.json()) as SalesforceTokenResponse;
  } catch (err) {
    log.warn(
      {
        status: resp.status,
        err: err instanceof Error ? err.message : String(err),
      },
      "Salesforce token response body could not be parsed as JSON",
    );
    throw new PlatformOAuthExchangeError({
      message: "Salesforce returned an unparseable token response. Restart the install.",
      platform: SALESFORCE_SLUG,
      upstreamError: `non-json ${resp.status}`,
    });
  }

  if (!resp.ok || !isTokenSuccess(parsed)) {
    const failure = parsed as SalesforceTokenFailure;
    throw new PlatformOAuthExchangeError({
      message: "Salesforce rejected the OAuth code. Restart the install from your Salesforce admin.",
      platform: SALESFORCE_SLUG,
      upstreamError: failure.error ?? `http_${resp.status}`,
    });
  }

  if (!parsed.instance_url) {
    const incomplete = new IncompleteOAuthResponseError({
      message: "Salesforce OAuth response missing instance_url",
      hasAccessToken: true,
      hasInstanceUrl: false,
    });
    throw new PlatformOAuthExchangeError({
      message: "Salesforce returned an incomplete OAuth response. Restart the install.",
      platform: SALESFORCE_SLUG,
      upstreamError: incomplete._tag,
    });
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class SalesforceOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  private readonly loginUrl: string;

  constructor(private readonly config: SalesforceOAuthHandlerConfig) {
    this.loginUrl = normalizeLoginUrl(config.loginUrl);
  }

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, SALESFORCE_SLUG);
    const url = new URL(`${this.loginUrl}/services/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", SALESFORCE_SCOPES);
    url.searchParams.set("state", stateToken);
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
    if (verified.catalogId !== SALESFORCE_SLUG) {
      log.warn(
        { expected: SALESFORCE_SLUG, got: verified.catalogId },
        "Salesforce OAuth callback received state bound to a different catalog — rejecting",
      );
      return null;
    }

    // ── 2. Exchange code for tokens ───────────────────────────────
    const tokens = await exchangeAuthCodeForTokens({
      loginUrl: this.loginUrl,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      code,
    });

    const idParts = parseSalesforceIdUrl(tokens.id);
    const scopes = tokens.scope ?? SALESFORCE_SCOPES;
    const tokenType = tokens.token_type ?? "Bearer";
    const expiresAt = computeExpiresAt(tokens.issued_at);

    // ── 3. Install record — workspace_plugins INSERT (first store) ──
    // `status: "ok"` is the default; the refresh-token flow flips it to
    // `"reconnect_needed"` on refresh_token revocation. The admin UI
    // reads this field to render the Reconnect affordance.
    const installConfig: Record<string, unknown> = {
      instance_url: tokens.instance_url,
      scopes,
      status: "ok",
      ...(idParts ? { org_id: idParts.orgId, org_user_id: idParts.userId } : {}),
    };

    // Heal any pre-0096 pillar='datasource' row so the singleton-index
    // upsert below can dedupe against it — see
    // {@link SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL} for the full story.
    await internalQuery(SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL, [
      workspaceId,
      SALESFORCE_CATALOG_ID,
    ]);

    const persistedId = await persistInstallRecord({
      workspaceId,
      catalogId: SALESFORCE_CATALOG_ID,
      displayName: "Salesforce",
      log,
      config: installConfig,
      persistFailureMessage:
        "Failed to write workspace_plugins install record — aborting Salesforce install",
      failureLogFields: { instanceUrl: tokens.instance_url },
    });

    const installRecord: InstallRecord = {
      // On a re-install the upsert RETURNING yields the existing row's
      // id, not a freshly-generated candidate — persistInstallRecord
      // returns the persisted one.
      id: persistedId,
      workspaceId,
      catalogId: SALESFORCE_SLUG,
    };

    // ── 4. Credential — integration_credentials INSERT (second store) ──
    // ADR-0003 atomicity: a failure here leaves the install row in
    // place; admin sees "Reconnect needed" and retries.
    const bundle: CredentialBundle = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      tokenType,
      scope: scopes,
      instanceUrl: tokens.instance_url,
      ...(tokens.id_token ? { extra: { id_token: tokens.id_token } } : {}),
    };

    try {
      await saveCredentialBundle(workspaceId, SALESFORCE_CATALOG_ID, bundle);
      log.info(
        { workspaceId, instanceUrl: tokens.instance_url },
        "Salesforce install completed (both stores written)",
      );
      return {
        workspaceId,
        catalogId: SALESFORCE_SLUG,
        installRecord,
        credentialResult: { written: true },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, instanceUrl: tokens.instance_url, err: errMessage },
        "Salesforce install record written but integration_credentials write failed — Reconnect required",
      );
      // Codex P1 — flip status to `reconnect_needed` so the admin card
      // surfaces a persistent Reconnect CTA. Without this, the OAuth
      // callback's `?reconnect=salesforce` query param shows once and
      // then disappears on the next admin-page reload, leaving the card
      // in the "Installed" state with no credentials behind it.
      // Best-effort UPDATE — if it fails the install record is still
      // present and the user lands on `?reconnect=` via the callback's
      // partial-failure redirect; the warn log captures the divergence.
      try {
        await internalQuery(
          `UPDATE workspace_plugins
              SET config = config || jsonb_build_object('status', 'reconnect_needed')
            WHERE workspace_id = $1 AND catalog_id = $2`,
          [workspaceId, SALESFORCE_CATALOG_ID],
        );
      } catch (statusErr) {
        log.warn(
          {
            workspaceId,
            err: statusErr instanceof Error ? statusErr.message : String(statusErr),
          },
          "Failed to mark Salesforce install as reconnect_needed after credential write failure",
        );
      }
      return {
        workspaceId,
        catalogId: SALESFORCE_SLUG,
        installRecord,
        credentialResult: {
          written: false,
          reason: "Credential persist failed — admin should retry via Reconnect",
        },
      };
    }
  }
}
