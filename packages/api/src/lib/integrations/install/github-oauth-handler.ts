/**
 * `GitHubOAuthInstallHandler` — multi-tenant GitHub App install (#2751,
 * Phase D App-OAuth mode).
 *
 * Wire shape differs from every other OAuth handler in three structural
 * ways:
 *
 *   1. **No standard OAuth 2.0 code → access-token exchange yields the
 *      credential we persist.** GitHub App installs use the App's
 *      *install* URL (`https://github.com/apps/<slug>/installations/new`),
 *      which redirects back to the App's configured callback URL with
 *      `?code=<user_oauth_code>&installation_id=<id>&setup_action=install&state=<token>`.
 *      The `installation_id` IS the credential identifier — there is no
 *      access-token swap to persist. The actual API tokens are
 *      *installation tokens*, minted on demand by the lazy builder
 *      (ships in a follow-up PR) signing a short-lived JWT with the
 *      App's private key (`GITHUB_APP_PRIVATE_KEY`, operator env) and
 *      POSTing it to `/app/installations/<installation_id>/access_tokens`.
 *
 *   2. **The `code` is used for user-ownership verification, not for
 *      the persisted credential.** The App MUST be configured with
 *      "Request user authorization (OAuth) during installation" so
 *      GitHub issues a user OAuth code on the same callback. We
 *      exchange that code for a user access token and call `GET
 *      /user/installations` to verify the supplied `installation_id`
 *      is in the user's accessible installations list. Without this
 *      check a workspace admin could tamper the callback URL to bind
 *      their workspace to a different installation_id they
 *      know/guessed — the state token alone gates only the workspace
 *      binding, not the installation binding.
 *
 *   3. **Per ADR-0007 the credential persists inline in
 *      `workspace_plugins.config` JSONB** via {@link encryptSecretFields},
 *      not in the legacy `integration_credentials` table. The new shape
 *      is the post-#2744 unified install pipeline pattern — Salesforce
 *      / Jira / Linear still ride `integration_credentials` because
 *      their refresh-token lifecycle predates the cutover, but GitHub
 *      Apps don't have a rotating refresh token (the App private key is
 *      operator-owned and never reaches the DB), so the inline JSONB
 *      shape is the right fit.
 *
 * Catalog row metadata (`saas_eligible: true`, `install_model: 'oauth'`)
 * lives in `deploy/api/atlas.config.ts`. The integrations-catalog route
 * (`packages/api/src/api/routes/integrations-catalog.ts`) filters by
 * `saas_eligible` on SaaS deploys — multi-tenant `github` is the only
 * GitHub mode SaaS customers see.
 *
 * @see ../oauth-state-token.ts — state mint/verify primitives
 * @see ./github-oauth-secret-schema.ts — shared encryption schema
 * @see ./github-single-tenant-oauth-handler.ts — sibling single-tenant
 *   handler (operator-baked installation_id, no GitHub-side dance)
 * @see ./github-pat-form-handler.ts — third install mode (PAT,
 *   self-host only), same workspace_plugins.config inline-encryption
 *   shape
 * @see docs/adr/0007-unified-install-pipeline.md
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { encryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import type { WorkspaceId } from "@useatlas/types";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "./oauth-state-token";
import {
  GITHUB_APP_SECRET_FIELDS_SCHEMA,
  GITHUB_CATALOG_ID,
  GitHubInstallationConfigSchema,
} from "./github-oauth-secret-schema";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthCallbackExtras,
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.github");

/** Catalog slug — the dispatch key, value bound into the state token. */
export const GITHUB_SLUG: CatalogId = "github";

/** Re-export so callers don't need a second import for the catalog id. */
export { GITHUB_CATALOG_ID };

const APP_INSTALL_URL_BASE = "https://github.com/apps";
const USER_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_INSTALLATIONS_URL = "https://api.github.com/user/installations";

/** Hard timeout on install-time GitHub round-trips — see Jira sibling. */
const INSTALL_FETCH_TIMEOUT_MS = 15_000;

/** Cap on `/user/installations` pages we'll walk before giving up. */
const MAX_INSTALLATIONS_PAGES = 10;

/**
 * Operator-side GitHub App config. Read once from env in `register.ts`
 * and passed in.
 *
 * `appId` is NOT consumed by the install handler itself — it's needed
 * at install-token mint time by the lazy builder (follow-up PR) when
 * signing the App JWT. We carry it on the install handler's config so
 * the env-gate seam in `register.ts` validates both halves of the pair
 * at once: a deploy missing `GITHUB_APP_ID` would otherwise install
 * cleanly and fail at first tool call.
 *
 * `clientId` / `clientSecret` are the App's user-OAuth credentials,
 * surfaced on the App settings page when "Request user authorization
 * (OAuth) during installation" is enabled. These ARE consumed by this
 * handler — for the install-ownership verification call.
 */
export interface GitHubOAuthHandlerConfig {
  /**
   * App ID — read by the lazy builder, NOT this install handler. See
   * type JSDoc for the rationale.
   */
  readonly appId: string;
  /** App slug from the public URL `https://github.com/apps/<slug>`. */
  readonly appSlug: string;
  /**
   * GitHub App OAuth "Client ID" — surfaced on the App settings page
   * after "Request user authorization (OAuth) during installation" is
   * enabled. Distinct from the App ID.
   */
  readonly clientId: string;
  /** GitHub App OAuth "Client secret". */
  readonly clientSecret: string;
  /**
   * Public-facing OAuth callback URL — must match the App's "Setup URL"
   * AND "Callback URL" (since user-OAuth-during-install is required).
   */
  readonly redirectUri: string;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (narrow subsets we consume)
// ---------------------------------------------------------------------------

interface UserTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface UserInstallationsResponse {
  readonly total_count?: number;
  readonly installations?: ReadonlyArray<{
    readonly id?: number;
    readonly account?: {
      readonly login?: string;
      readonly type?: string;
    };
  }>;
}

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

/**
 * Exchange the user OAuth `code` for a user access token. GitHub's
 * OAuth-during-install flow uses the standard
 * `https://github.com/login/oauth/access_token` endpoint with
 * `client_id` + `client_secret` + `code`. Returns the parsed
 * `access_token`; throws `PlatformOAuthExchangeError` on any
 * non-success path.
 */
async function exchangeUserCodeForToken(args: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<string> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      USER_OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: args.clientId,
          client_secret: args.clientSecret,
          code: args.code,
          redirect_uri: args.redirectUri,
        }).toString(),
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
        ? "GitHub user-OAuth token endpoint timed out"
        : "GitHub user-OAuth token endpoint unreachable",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "GitHub token endpoint timed out. Restart the install."
        : "Failed to reach GitHub token endpoint. Restart the install.",
      platform: GITHUB_SLUG,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: UserTokenResponse;
  try {
    parsed = (await resp.json()) as UserTokenResponse;
  } catch {
    throw new PlatformOAuthExchangeError({
      message: "GitHub returned an unparseable token response. Restart the install.",
      platform: GITHUB_SLUG,
      upstreamError: `non-json ${resp.status}`,
    });
  }

  if (!resp.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new PlatformOAuthExchangeError({
      message: "GitHub rejected the OAuth code. Restart the install.",
      platform: GITHUB_SLUG,
      upstreamError: parsed.error ?? `http_${resp.status}`,
    });
  }
  return parsed.access_token;
}

/**
 * Walk `/user/installations` looking for `targetInstallationId`. Returns
 * the matching installation's account info when found, or `null` when
 * the user does NOT have access to that installation — the signal that
 * the callback was tampered.
 *
 * GitHub paginates this endpoint; we follow the `Link: <…>; rel="next"`
 * header up to `MAX_INSTALLATIONS_PAGES` (covers users who belong to
 * hundreds of orgs without unbounded looping). A user with more
 * installations than that limit and the target in a later page will
 * fail closed — acceptable trade-off; the operator can raise the cap
 * if needed.
 */
async function findUserInstallation(
  userAccessToken: string,
  targetInstallationId: string,
): Promise<{ login: string | null; type: string | null } | null> {
  let url: string | null = `${USER_INSTALLATIONS_URL}?per_page=100`;
  let page = 0;
  while (url !== null && page < MAX_INSTALLATIONS_PAGES) {
    page++;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${userAccessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        INSTALL_FETCH_TIMEOUT_MS,
      );
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      throw new PlatformOAuthExchangeError({
        message: isAbort
          ? "GitHub API timed out while verifying installation ownership. Restart the install."
          : "Failed to reach GitHub API while verifying installation ownership. Restart the install.",
        platform: GITHUB_SLUG,
        upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
      });
    }

    if (!resp.ok) {
      throw new PlatformOAuthExchangeError({
        message: "GitHub rejected the user-installations lookup. Restart the install.",
        platform: GITHUB_SLUG,
        upstreamError: `user_installations_http_${resp.status}`,
      });
    }

    let parsed: UserInstallationsResponse;
    try {
      parsed = (await resp.json()) as UserInstallationsResponse;
    } catch (err) {
      throw new PlatformOAuthExchangeError({
        message: "GitHub returned an unparseable user-installations response. Restart the install.",
        platform: GITHUB_SLUG,
        upstreamError: err instanceof Error ? err.message : String(err),
      });
    }

    const match = parsed.installations?.find(
      (i) => typeof i.id === "number" && String(i.id) === targetInstallationId,
    );
    if (match) {
      return {
        login: typeof match.account?.login === "string" ? match.account.login : null,
        type: typeof match.account?.type === "string" ? match.account.type : null,
      };
    }
    url = parseNextLinkHeader(resp.headers.get("link"));
  }
  return null;
}

/**
 * Parse the `Link` header per RFC 5988 / GitHub pagination — extracts
 * the `rel="next"` URL or returns null when absent. Permissive parser:
 * any malformed segment is silently skipped, since GitHub's emitter is
 * standardized but downstream proxies sometimes mangle whitespace.
 */
function parseNextLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const segment of header.split(",")) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match && typeof match[1] === "string") return match[1];
  }
  return null;
}

export class GitHubOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  constructor(private readonly config: GitHubOAuthHandlerConfig) {}

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, GITHUB_SLUG);
    // GitHub App install URL shape:
    //   https://github.com/apps/<slug>/installations/new?state=<token>
    // GitHub redirects back to the App's Setup/Callback URL with
    //   ?code=<user_oauth_code>&installation_id=<id>&setup_action=install&state=<token>
    // The `code` is the user-OAuth artifact required for our
    // installation-ownership check below (operator MUST have "Request
    // user authorization (OAuth) during installation" enabled on the
    // App for the install to succeed).
    const url = new URL(`${APP_INSTALL_URL_BASE}/${this.config.appSlug}/installations/new`);
    url.searchParams.set("state", stateToken);
    return { redirectUrl: url.toString(), stateToken };
  }

  async handleCallback(
    code: string,
    stateToken: string,
    extras?: OAuthCallbackExtras,
  ): Promise<{
    readonly workspaceId: WorkspaceId;
    readonly catalogId: CatalogId;
    readonly installRecord: InstallRecord;
    readonly credentialResult: CredentialResult;
  } | null> {
    // ── 1. Verify state — null on every failure mode ─────────────
    const verified = verifyOAuthStateToken(stateToken);
    if (!verified) return null;
    if (verified.catalogId !== GITHUB_SLUG) {
      log.warn(
        { expected: GITHUB_SLUG, got: verified.catalogId },
        "GitHub OAuth callback received state bound to a different catalog — rejecting",
      );
      return null;
    }
    const workspaceId = verified.workspaceId as WorkspaceId;

    // ── 2. Require both code and installation_id ─────────────────
    // The App's user-OAuth-during-install option MUST be enabled — we
    // need the `code` to verify the installation_id is owned by the
    // user clicking install. Missing either is operator misconfig.
    const installationIdRaw = extras?.installationId;
    if (typeof installationIdRaw !== "string" || installationIdRaw.length === 0) {
      throw new PlatformOAuthExchangeError({
        message:
          "GitHub install callback was missing installation_id. Ensure your GitHub App's Setup URL matches the Atlas callback and the App has been installed.",
        platform: GITHUB_SLUG,
        upstreamError: "missing_installation_id",
      });
    }
    if (typeof code !== "string" || code.length === 0) {
      throw new PlatformOAuthExchangeError({
        message:
          "GitHub install callback was missing the OAuth code. Enable \"Request user authorization (OAuth) during installation\" on your GitHub App and restart.",
        platform: GITHUB_SLUG,
        upstreamError: "missing_code",
      });
    }

    // ── 3. Validate installation_id shape ────────────────────────
    const parsedConfig = GitHubInstallationConfigSchema.safeParse({
      installation_id: installationIdRaw,
    });
    if (!parsedConfig.success) {
      throw new PlatformOAuthExchangeError({
        message:
          "GitHub returned an unexpected installation_id. Restart the install from your Atlas admin.",
        platform: GITHUB_SLUG,
        upstreamError: "invalid_installation_id",
      });
    }
    const installationId = parsedConfig.data.installation_id;

    // ── 4. Verify the installing user OWNS this installation ─────
    // Critical defense against cross-tenant binding: a tampered
    // callback URL could substitute an installation_id the attacker
    // doesn't actually have access to. We exchange the user OAuth
    // code for a user access token and verify the installation_id is
    // in the user's accessible installations.
    const userToken = await exchangeUserCodeForToken({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      code,
      redirectUri: this.config.redirectUri,
    });
    const ownership = await findUserInstallation(userToken, installationId);
    if (!ownership) {
      log.warn(
        { workspaceId, installationIdTail: installationId.slice(-4) },
        "GitHub install ownership check FAILED — user does not have access to the supplied installation_id (possible tampered callback)",
      );
      throw new PlatformOAuthExchangeError({
        message:
          "The GitHub user authorizing this install does not have access to the supplied installation. Restart the install and grant access to your target organization.",
        platform: GITHUB_SLUG,
        upstreamError: "installation_not_owned",
      });
    }

    // ── 5. SaaS keyset gate — defense in depth ───────────────────
    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      log.error(
        { workspaceId },
        "Refusing GitHub App install: SaaS mode + no encryption keyset (would persist plaintext installation_id)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    // ── 6. Encrypt secret fields + persist install record ─────────
    const installConfig: Record<string, unknown> = {
      installation_id: installationId,
      status: "ok",
      ...(ownership.login ? { account_login: ownership.login } : {}),
      ...(ownership.type ? { account_type: ownership.type } : {}),
    };
    const encryptedConfig = encryptSecretFields(installConfig, GITHUB_APP_SECRET_FIELDS_SCHEMA);

    const candidateId = crypto.randomUUID();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'action', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, GITHUB_CATALOG_ID, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.error(
          { workspaceId, candidateId },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist GitHub App install record — aborting install",
      );
      throw err;
    }

    try {
      await lazyPluginLoader.evict(workspaceId, GITHUB_CATALOG_ID);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "LazyPluginLoader.evict threw after GitHub App install upsert — DB row is persisted anyway",
      );
    }

    log.info(
      {
        workspaceId,
        installId: persistedId,
        accountLogin: ownership.login,
        accountType: ownership.type,
      },
      "GitHub App install completed (ownership verified)",
    );

    const installRecord: InstallRecord = {
      id: persistedId,
      workspaceId,
      catalogId: GITHUB_SLUG,
    };
    const credentialResult: CredentialResult = { written: true };
    return { workspaceId, catalogId: GITHUB_SLUG, installRecord, credentialResult };
  }
}
