/**
 * `GitHubSingleTenantOAuthInstallHandler` — operator-baked GitHub App
 * installation (#2751, Phase D single-tenant mode).
 *
 * Wire shape is the same {@link OAuthPlatformInstallHandler} interface
 * as the multi-tenant sibling, but the install dance has no GitHub-side
 * round trip: the operator installed the App into their one GitHub org
 * once at deploy time, baked the resulting `installation_id` into
 * `GITHUB_APP_INSTALLATION_ID` env, and every workspace shares that
 * installation. The customer admin's "install" click is therefore a
 * pure acknowledgement — Atlas self-redirects through its own callback
 * URL with the env-baked installation_id pre-attached, the callback
 * verifies state + persists the install record, done.
 *
 * Self-host only: the catalog row carries `saas_eligible: false`. One
 * GitHub org's App installation cannot serve multiple Atlas workspaces
 * in any meaningful multi-tenant sense (every workspace would write to
 * the same repos), so this row is hidden from the SaaS catalog by the
 * integrations-catalog route's `saas_eligible` filter.
 *
 * Persistence shape mirrors {@link GitHubOAuthInstallHandler} — same
 * `workspace_plugins.config` JSONB encrypted via
 * {@link encryptSecretFields}, same catalog id, same lazy-builder
 * read path. The two handlers diverge only on the install side: one
 * redirects through GitHub, the other shortcuts to its own callback.
 *
 * @see ./github-oauth-handler.ts — multi-tenant sibling
 * @see ./github-oauth-secret-schema.ts — shared encryption schema
 * @see docs/adr/0007-unified-install-pipeline.md
 */

import { createLogger } from "@atlas/api/lib/logger";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { encryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { persistInstallRecord } from "./persist-form-install";
import type { WorkspaceId } from "@useatlas/types";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "./oauth-state-token";
import {
  GITHUB_APP_SECRET_FIELDS_SCHEMA,
  GITHUB_SINGLE_TENANT_CATALOG_ID,
  GitHubInstallationConfigSchema,
} from "./github-oauth-secret-schema";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthCallbackExtras,
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.github-single-tenant");

/** Catalog slug — the dispatch key, value bound into the state token. */
export const GITHUB_SINGLE_TENANT_SLUG: CatalogId = "github-single-tenant";

export { GITHUB_SINGLE_TENANT_CATALOG_ID };

export interface GitHubSingleTenantHandlerConfig {
  /**
   * App ID + slug — read by the lazy builder (follow-up PR) at
   * install-token mint time. Neither is consumed by this install
   * handler directly: single-tenant's `startInstall` self-redirects
   * through the callback URL (no `github.com/apps/<slug>` hop), and
   * `handleCallback` reads only `installationId` from the config. We
   * still gate registration on both env vars in `register.ts` so a
   * half-wired deploy can't install cleanly then fail at first tool
   * call.
   */
  readonly appId: string;
  readonly appSlug: string;
  /**
   * Operator-baked installation_id. The operator installed the App into
   * their one GitHub org once and pasted the resulting id into env.
   */
  readonly installationId: string;
  /**
   * Public-facing callback URL — same shape as the multi-tenant handler.
   * `startInstall` self-redirects to this URL with the baked
   * installation_id and state token; the route forwards into
   * `handleCallback`.
   */
  readonly redirectUri: string;
}

export class GitHubSingleTenantOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  constructor(private readonly config: GitHubSingleTenantHandlerConfig) {}

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, GITHUB_SINGLE_TENANT_SLUG);
    // No GitHub-side dance — operator already installed the App into
    // their one org. Self-redirect to our own callback URL with the
    // env-baked installation_id pre-attached; the same callback handler
    // verifies the state and persists the install. The customer admin
    // sees a near-instant "Installed" toast.
    //
    // Using the standard callback URL (vs short-circuiting in
    // startInstall) keeps the state-verification + persistence flow on
    // one code path that the integrations route already exercises, so
    // future hardening (rate limits, audit logging) lands in one place
    // and covers every install mode.
    const url = new URL(this.config.redirectUri);
    url.searchParams.set("installation_id", this.config.installationId);
    url.searchParams.set("state", stateToken);
    url.searchParams.set("setup_action", "install");
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
    const verified = verifyOAuthStateToken(stateToken);
    if (!verified) return null;
    if (verified.catalogId !== GITHUB_SINGLE_TENANT_SLUG) {
      log.warn(
        { expected: GITHUB_SINGLE_TENANT_SLUG, got: verified.catalogId },
        "GitHub single-tenant callback received state bound to a different catalog — rejecting",
      );
      return null;
    }
    const workspaceId = verified.workspaceId as WorkspaceId;

    // Single-tenant accepts the supplied identifier from EITHER:
    //   - `extras.installationId` (route passes the query-param branch
    //     for github-single-tenant)
    //   - `code` (legacy positional — backward compat for any direct
    //     caller that hasn't migrated to the extras shape)
    // Either way we IGNORE the supplied value and use the operator-
    // baked env installation_id. See `targetInstallationId` rationale
    // below.
    const suppliedInstallationId = extras?.installationId ?? code;

    // Defense-in-depth: ignore whatever installation_id arrived on the
    // callback if it disagrees with the operator-baked env value. The
    // env is the source of truth in single-tenant mode — a callback
    // carrying a different installation_id is either a tampered redirect
    // URL or an operator that changed env mid-install. Either way,
    // persisting anything other than the baked value would silently
    // mis-route subsequent installation-token mint calls.
    const targetInstallationId = this.config.installationId;
    if (typeof suppliedInstallationId === "string" && suppliedInstallationId !== targetInstallationId) {
      log.warn(
        { workspaceId, suppliedFingerprint: fingerprintInstallationId(suppliedInstallationId) },
        "GitHub single-tenant callback installation_id differs from operator-baked env — falling back to env value",
      );
    }

    const parsed = GitHubInstallationConfigSchema.safeParse({
      installation_id: targetInstallationId,
    });
    if (!parsed.success) {
      throw new PlatformOAuthExchangeError({
        message:
          "GITHUB_APP_INSTALLATION_ID is malformed. Set it to a positive integer from your GitHub App's installation page.",
        platform: GITHUB_SINGLE_TENANT_SLUG,
        upstreamError: "invalid_installation_id_env",
      });
    }

    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      // The catalog row is `saas_eligible: false`, so the integrations-
      // catalog filter already hides this row on SaaS. Keyset gate stays
      // as defense in depth — if a SaaS deploy ever bypasses the
      // filter, refuse to persist plaintext.
      log.error(
        { workspaceId },
        "Refusing GitHub single-tenant install: SaaS mode + no encryption keyset",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    const installConfig: Record<string, unknown> = {
      installation_id: parsed.data.installation_id,
      status: "ok",
    };
    const encryptedConfig = encryptSecretFields(installConfig, GITHUB_APP_SECRET_FIELDS_SCHEMA);

    // Upsert + returned-id invariant + lazy-loader evict — shared with
    // the form spine and the other OAuth handlers (#3362 review).
    const persistedId = await persistInstallRecord({
      workspaceId,
      catalogId: GITHUB_SINGLE_TENANT_CATALOG_ID,
      displayName: "GitHub single-tenant",
      log,
      config: encryptedConfig,
    });

    log.info(
      { workspaceId, installId: persistedId },
      "GitHub single-tenant install completed",
    );

    const installRecord: InstallRecord = {
      id: persistedId,
      workspaceId,
      catalogId: GITHUB_SINGLE_TENANT_SLUG,
    };
    const credentialResult: CredentialResult = { written: true };
    return {
      workspaceId,
      catalogId: GITHUB_SINGLE_TENANT_SLUG,
      installRecord,
      credentialResult,
    };
  }
}

/**
 * Log-safe fingerprint — last 4 chars of the supplied installation_id.
 * The id is a positive integer; logging the full value would leak the
 * operator-baked env across log streams. Mirrors the same trick used
 * for bot-token fingerprints in `register.ts`.
 */
function fingerprintInstallationId(value: string): string {
  return value.length <= 4 ? "****" : `…${value.slice(-4)}`;
}
