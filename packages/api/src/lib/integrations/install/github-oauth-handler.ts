/**
 * `GitHubOAuthInstallHandler` — multi-tenant GitHub App install (#2751,
 * Phase D App-OAuth mode).
 *
 * Wire shape differs from every other OAuth handler in two structural
 * ways:
 *
 *   1. **No standard OAuth 2.0 code → token exchange.** GitHub App
 *      installs use the App's *install* URL
 *      (`https://github.com/apps/<slug>/installations/new`), which
 *      redirects back to the App's configured callback URL with
 *      `?installation_id=<id>&setup_action=install&state=<token>`.
 *      The `installation_id` IS the credential identifier — there is no
 *      code-for-token swap to perform here. The actual API tokens are
 *      *installation tokens*, minted on demand by the lazy builder
 *      (ships in a follow-up PR) signing a short-lived JWT with the
 *      App's private key (`GITHUB_APP_PRIVATE_KEY`, operator env) and
 *      POSTing it to `/app/installations/<installation_id>/access_tokens`.
 *
 *   2. **Per ADR-0007 the credential persists inline in
 *      `workspace_plugins.config` JSONB** via {@link encryptSecretFields},
 *      not in the legacy `integration_credentials` table. The new shape
 *      is the post-#2744 unified install pipeline pattern — Salesforce
 *      / Jira / Linear still ride `integration_credentials` because
 *      their refresh-token lifecycle predates the cutover, but GitHub
 *      Apps don't have a rotating refresh token (the App private key is
 *      operator-owned and never reaches the DB), so the inline JSONB
 *      shape is the right fit.
 *
 * The route's callback query schema accepts `installation_id` as an
 * alternative to `code`. {@link handleCallback}'s first arg is therefore
 * the installation_id string, not an auth code. The interface kept the
 * `code` parameter name for cross-handler uniformity (changing the
 * signature would ripple through every handler + test) — the JSDoc on
 * the route handler explains the substitution.
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
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.github");

/** Catalog slug — the dispatch key, value bound into the state token. */
export const GITHUB_SLUG: CatalogId = "github";

/** Re-export so callers don't need a second import for the catalog id. */
export { GITHUB_CATALOG_ID };

const APP_INSTALL_URL_BASE = "https://github.com/apps";

/**
 * Operator-side GitHub App config. Read once from env in `register.ts`
 * and passed in. `appId` is informational here — the actual install URL
 * uses `appSlug` (the human-readable handle in
 * `https://github.com/apps/<slug>`); `appId` is needed at install-token
 * mint time by the lazy builder.
 */
export interface GitHubOAuthHandlerConfig {
  /** App ID from the App settings page — numeric, but kept as a string. */
  readonly appId: string;
  /** App slug from the public URL `https://github.com/apps/<slug>`. */
  readonly appSlug: string;
  /**
   * Public-facing OAuth callback URL — must match the App's "Setup URL"
   * (and "Callback URL" if user-OAuth-during-install is enabled).
   */
  readonly redirectUri: string;
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
    // GitHub redirects back to the App's "Setup URL" (configured to be
    // our callback) with `?installation_id=<id>&setup_action=install&state=<token>`.
    // Setting "Request user authorization (OAuth) during installation"
    // on the App registration would add `&code=<oauth_code>` too — we
    // ignore that field; the installation alone grants Atlas its
    // repo-scoped permissions.
    const url = new URL(`${APP_INSTALL_URL_BASE}/${this.config.appSlug}/installations/new`);
    url.searchParams.set("state", stateToken);
    return { redirectUrl: url.toString(), stateToken };
  }

  async handleCallback(
    installationId: string,
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
    if (verified.catalogId !== GITHUB_SLUG) {
      log.warn(
        { expected: GITHUB_SLUG, got: verified.catalogId },
        "GitHub OAuth callback received state bound to a different catalog — rejecting",
      );
      return null;
    }
    const workspaceId = verified.workspaceId as WorkspaceId;

    // ── 2. Validate installation_id shape ────────────────────────
    // GitHub always returns a positive-integer installation_id on a
    // successful App install. A malformed value is operator-side
    // tampering or a GitHub-side regression — reject early rather than
    // persist garbage and fail at first JWT mint inside the lazy
    // builder, where the error surface is harder to diagnose. The
    // `PlatformOAuthExchangeError` lets the route translate this into a
    // browser-friendly toast just like Jira / Linear's upstream errors.
    const parsed = GitHubInstallationConfigSchema.safeParse({
      installation_id: installationId,
    });
    if (!parsed.success) {
      throw new PlatformOAuthExchangeError({
        message:
          "GitHub returned an unexpected installation_id. Restart the install from your Atlas admin.",
        platform: GITHUB_SLUG,
        upstreamError: "invalid_installation_id",
      });
    }

    // ── 3. SaaS keyset gate — defense in depth ───────────────────
    // The catalog row is `saas_eligible: true`, so this row IS reachable
    // on SaaS. Without a configured keyset the encryption walker would
    // silently passthrough plaintext — refuse to write rather than leak
    // the installation_id in cleartext. Mirrors github-pat's posture.
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

    // ── 4. Encrypt secret fields + persist install record ─────────
    const installConfig: Record<string, unknown> = {
      installation_id: parsed.data.installation_id,
      status: "ok",
    };
    const encryptedConfig = encryptSecretFields(installConfig, GITHUB_APP_SECRET_FIELDS_SCHEMA);

    // Per migration 0092 the INSERT names `pillar='action'` (Atlas
    // writes to GitHub, not chat) and `install_id` explicitly because
    // action-pillar installs are singletons per (workspace, catalog)
    // under the partial unique index `workspace_plugins_singleton`. Same
    // shape as github-pat / linear-apikey.
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

    // Evict any cached PluginLike for this (workspace, catalog) so a
    // future agent-tool dispatch rebuilds against the freshly-persisted
    // config. The GitHub action tool / lazy builder ships in a follow-up
    // PR; the evict call stays here so re-installs that change the
    // installation_id don't leave a stale in-memory instance behind.
    try {
      await lazyPluginLoader.evict(workspaceId, GITHUB_CATALOG_ID);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "LazyPluginLoader.evict threw after GitHub App install upsert — DB row is persisted anyway",
      );
    }

    log.info(
      { workspaceId, installId: persistedId },
      "GitHub App install completed",
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
