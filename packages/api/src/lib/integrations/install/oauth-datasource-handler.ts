/**
 * `OAuthDatasourceInstallHandler` — admin install flow for an OAuth2 REST
 * datasource (v0.0.2 slice 6c, #3030; the OQ5 deliverable). GitHub-as-datasource
 * is the first (and today only) consumer.
 *
 * ## Why a NEW handler, not a reuse of `OAuthPlatformInstallHandler` (OQ5)
 * The existing {@link OAuthPlatformInstallHandler} is shaped for chat/action
 * platforms: single-instance per `(workspace_id, catalog_id)`, credential to
 * `chat_cache` / a per-plugin store. A *datasource* OAuth install is a different
 * persistence shape — multi-instance (`install_id` composite PK,
 * `pillar='datasource'`), credential inline in `workspace_plugins.config` via
 * selective-field encryption, and a **probe-on-install** that caches the
 * `openapi_snapshot` so the agent loop resolves the operation surface from the DB
 * row. So this handler borrows the OAuth *credential-acquisition* primitives
 * (state token + the GitHub App ownership verification in `github-app-oauth.ts`)
 * but owns the datasource persistence path — exactly the
 * {@link import("./openapi-generic-form-handler").persistOpenApiDatasourceInstall}
 * shape, with OAuth-shaped credential acquisition instead of a form.
 *
 * ## GitHub specifics (OQ6 — thin wrapper)
 * GitHub is a *thin* data wrapper: its only non-generic data dimension
 * (`Link`-header pagination) is already a generic strategy, so NO GitHub-specific
 * walker/paginator/validator exists. The GitHub-ness is confined to this install
 * handler (and the credential resolver), never the query path:
 *   - credential acquisition reuses GitHub's EXISTING App registration (same
 *     `GITHUB_APP_*` env as the `github` action row) — no new vendor app,
 *   - the persisted credential is the `installation_id`; the executable bearer
 *     token is minted on demand from the App JWT (`github/installation-token.ts`)
 *     and re-minted transparently on ~1hr expiry — NOT refresh-token rotation.
 *
 * ## Partial-failure → reconnect-needed
 * After persisting the snapshot + installation_id, the handler mints an
 * installation token once as a credential health-check. A mint failure does NOT
 * abort the install (the snapshot is good); it persists `config.status =
 * 'reconnect_needed'` and returns `credentialResult.written = false` so the route
 * surfaces "Reconnect needed". The query-time resolver re-mints regardless, so a
 * later-fixed App access recovers without a re-install.
 *
 * @see ./types.ts — {@link OAuthDatasourceInstallHandler} interface
 * @see ./github-app-oauth.ts — shared ownership-verification primitives
 * @see ../../github/installation-token.ts — App-JWT installation-token minting
 * @see ./openapi-generic-form-handler.ts — the sibling datasource persistence shape
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { encryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { isPlaintextCredentialRisk } from "@atlas/api/lib/db/secret-encryption";
import { buildSnapshot, OpenApiProbeError } from "@atlas/api/lib/openapi/probe";
import { probeShared } from "@atlas/api/lib/openapi/shared-spec-cache";
import { baselineSpecDiffRecord } from "@atlas/api/lib/openapi/diff";
import { DEFAULT_REPRESENTATION_MODE } from "@atlas/api/lib/openapi/catalog";
import { getGitHubInstallationToken } from "@atlas/api/lib/github/installation-token";
import type { WorkspaceId } from "@useatlas/types";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "./oauth-state-token";
import { exchangeUserCodeForToken, findUserInstallation } from "./github-app-oauth";
import {
  GITHUB_APP_SECRET_FIELDS_SCHEMA,
  GitHubInstallationConfigSchema,
} from "./github-oauth-secret-schema";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthCallbackExtras,
  OAuthDatasourceInstallHandler as OAuthDatasourceInstallHandlerShape,
} from "./types";

const log = createLogger("integrations.install.oauth-datasource");

const APP_INSTALL_URL_BASE = "https://github.com/apps";

/**
 * Operator + catalog config for an OAuth-datasource install. The GitHub App
 * fields mirror {@link import("./github-oauth-handler").GitHubOAuthHandlerConfig}
 * (the action sibling reuses the SAME App registration); the catalog fields
 * (`slug` / `catalogId` / `openapiUrl`) come from the data-candidate registry so
 * the pre-wired spec URL is locked — an install can never re-point it.
 */
export interface OAuthDatasourceHandlerConfig {
  /** Catalog slug — dispatch key + value bound into the state token (e.g. "github-data"). */
  readonly slug: CatalogId;
  /** Stable `plugin_catalog.id` FK written to the row (e.g. "catalog:github-data"). */
  readonly catalogId: string;
  /** Pre-wired OpenAPI 3.x spec URL probed on install — the admin never pastes it. */
  readonly openapiUrl: string;
  /** GitHub App slug from `github.com/apps/<slug>` — builds the install URL. */
  readonly appSlug: string;
  /** GitHub App id — the `iss` claim for installation-token minting. */
  readonly appId: string;
  /** GitHub App OAuth "Client ID" (user-OAuth-during-install). */
  readonly clientId: string;
  /** GitHub App OAuth "Client secret". */
  readonly clientSecret: string;
  /** GitHub App private key (PKCS8 PEM) — signs the App JWT for the mint. */
  readonly privateKey: string;
  /** Public-facing OAuth callback URL — must match the App's Setup/Callback URL. */
  readonly redirectUri: string;
}

/** Injected seams — deterministic id/clock/probe-fetch in tests. */
export interface OAuthDatasourceHandlerOptions {
  readonly idGenerator?: () => string;
  /** Returns the ISO-8601 `probedAt` stamp. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** `fetch` override threaded into ownership verification, the probe, and the mint. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class OAuthDatasourceInstallHandler implements OAuthDatasourceInstallHandlerShape {
  readonly kind = "oauth-datasource" as const;

  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(
    private readonly config: OAuthDatasourceHandlerConfig,
    options: OAuthDatasourceHandlerOptions = {},
  ) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.fetchImpl = options.fetchImpl;
  }

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    const stateToken = mintOAuthStateToken(workspaceId, this.config.slug);
    // Same GitHub App install URL as the action sibling — the dance is identical;
    // only the callback's persistence differs. The `code` GitHub returns is the
    // user-OAuth artifact required for the installation-ownership check.
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
    if (verified.catalogId !== this.config.slug) {
      log.warn(
        { expected: this.config.slug, got: verified.catalogId },
        "OAuth-datasource callback received state bound to a different catalog — rejecting",
      );
      return null;
    }
    const workspaceId = verified.workspaceId as WorkspaceId;

    // ── 2. Require both installation_id and the user-OAuth code ──
    const installationIdRaw = extras?.installationId;
    if (typeof installationIdRaw !== "string" || installationIdRaw.length === 0) {
      throw new PlatformOAuthExchangeError({
        message:
          "GitHub install callback was missing installation_id. Ensure your GitHub App's Setup URL matches the Atlas callback and the App has been installed.",
        platform: this.config.slug,
        upstreamError: "missing_installation_id",
      });
    }
    if (typeof code !== "string" || code.length === 0) {
      throw new PlatformOAuthExchangeError({
        message:
          'GitHub install callback was missing the OAuth code. Enable "Request user authorization (OAuth) during installation" on your GitHub App and restart.',
        platform: this.config.slug,
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
        platform: this.config.slug,
        upstreamError: "invalid_installation_id",
      });
    }
    const installationId = parsedConfig.data.installation_id;

    // ── 4. Verify the installing user OWNS this installation ─────
    // Cross-tenant binding guard (shared with the action sibling): the state
    // token gates the workspace binding, NOT the installation binding — a
    // tampered callback could substitute an installation_id the user doesn't own.
    const userToken = await exchangeUserCodeForToken({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      code,
      redirectUri: this.config.redirectUri,
      platform: this.config.slug,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    const ownership = await findUserInstallation(userToken, installationId, {
      platform: this.config.slug,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (!ownership) {
      log.warn(
        { workspaceId, installationIdTail: installationId.slice(-4) },
        "OAuth-datasource install ownership check FAILED — user does not have access to the supplied installation (possible tampered callback)",
      );
      throw new PlatformOAuthExchangeError({
        message:
          "The GitHub user authorizing this install does not have access to the supplied installation. Restart the install and grant access to your target organization.",
        platform: this.config.slug,
        upstreamError: "installation_not_owned",
      });
    }

    // ── 5. SaaS keyset gate — refuse to persist plaintext ────────
    if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
      log.error(
        { workspaceId, slug: this.config.slug },
        "Refusing OAuth-datasource install: SaaS mode + no encryption keyset (would persist plaintext installation_id)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }
    // Self-hosted prod-like deploy with no keyset is allowed (dev passthrough)
    // but must not be silent — mirror the boot-time P0 alarm.
    if (isPlaintextCredentialRisk()) {
      log.warn(
        { workspaceId, slug: this.config.slug },
        "Persisting a GitHub installation_id with no encryption keyset configured in a prod-like " +
          "environment — it will be stored in plaintext. Set ATLAS_ENCRYPTION_KEYS to encrypt at rest.",
      );
    }

    // ── 6. Probe the pre-wired spec → snapshot ───────────────────
    // The GitHub OpenAPI spec is public — the probe needs no credential (the
    // installation token is minted at query time, never sent to the spec host).
    // That makes an oauth-datasource spec UNCONDITIONALLY shareable (#2970): the
    // document + normalized graph are fetched ONCE across all workspaces, so a
    // second org connecting GitHub reuses the cached doc with no re-download (a
    // fresh shared entry skips the network; a stale one does a cheap conditional
    // GET). A probe failure is still a hard install failure (no snapshot ⇒ no
    // datasource).
    let snapshot;
    try {
      const { doc, graph } = await probeShared({
        catalogId: this.config.catalogId,
        specUrl: this.config.openapiUrl,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
      snapshot = buildSnapshot(doc, graph, this.now());
    } catch (err) {
      if (err instanceof OpenApiProbeError) {
        log.error(
          { workspaceId, slug: this.config.slug, reason: err.reason },
          "OAuth-datasource install spec probe failed — aborting install",
        );
        throw new PlatformOAuthExchangeError({
          message: `Could not read the ${this.config.slug} OpenAPI spec (${err.reason}). Try the install again; if it persists, the upstream spec may be temporarily unavailable.`,
          platform: this.config.slug,
          upstreamError: "spec_probe_failed",
        });
      }
      throw err;
    }

    // ── 7. Health-check mint (credential validity) ───────────────
    // Mint an installation token once to confirm the App can actually mint for
    // this installation. A failure does NOT abort — the snapshot is good — but
    // flips the install to "reconnect needed".
    let credentialStatus: "ok" | "reconnect_needed" = "ok";
    let credentialResult: CredentialResult = { written: true };
    try {
      await getGitHubInstallationToken(installationId, {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, slug: this.config.slug, installationIdTail: installationId.slice(-4) },
        "OAuth-datasource install health-check mint failed — persisting as reconnect-needed",
      );
      credentialStatus = "reconnect_needed";
      credentialResult = {
        written: false,
        reason: "Connected, but Atlas could not mint a GitHub access token yet — reconnect to retry.",
      };
      // `reason` is operator-facing; the raw error stays in logs only.
      log.debug({ workspaceId, slug: this.config.slug, mintError: reason }, "mint failure detail");
    }

    // ── 8. Assemble + encrypt config (installation_id is the secret) ──
    const rawConfig: Record<string, unknown> = {
      installation_id: installationId,
      auth_kind: "oauth2",
      openapi_url: this.config.openapiUrl,
      representation_mode: DEFAULT_REPRESENTATION_MODE,
      display_name: snapshot.title,
      status: credentialStatus,
      openapi_snapshot: snapshot,
      // First-ever discovery records a baseline (no diff); re-discovery overwrites
      // it with the computed drift against this snapshot (#2976).
      openapi_last_diff: baselineSpecDiffRecord(snapshot.probedAt),
      ...(ownership.login ? { account_login: ownership.login } : {}),
      ...(ownership.type ? { account_type: ownership.type } : {}),
    };
    const encryptedConfig = encryptSecretFields(rawConfig, GITHUB_APP_SECRET_FIELDS_SCHEMA);

    // ── 9. Insert a fresh multi-instance datasource row ──────────
    // Same UUID for `id` + `install_id`; fresh every submit (multi-instance).
    // `status='draft'` (content-mode) surfaces the pending-changes pill for the
    // atomic publish flow — distinct from `config.status` (credential health).
    const installId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $1, 'datasource', $4::jsonb, true, 'draft', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               updated_at = NOW()
         RETURNING id`,
        [installId, workspaceId, this.config.catalogId, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.error(
          { workspaceId, slug: this.config.slug, installId },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        { workspaceId, slug: this.config.slug, installId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist OAuth-datasource install record — aborting install",
      );
      throw err;
    }

    log.info(
      {
        workspaceId,
        slug: this.config.slug,
        installId: persistedId,
        operationCount: snapshot.operationCount,
        accountLogin: ownership.login,
        credentialStatus,
      },
      "OAuth-datasource install completed",
    );

    const installRecord: InstallRecord = {
      id: persistedId,
      workspaceId,
      catalogId: this.config.slug,
    };
    return { workspaceId, catalogId: this.config.slug, installRecord, credentialResult };
  }
}
