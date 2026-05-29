/**
 * `LinearApiKeyFormInstallHandler` — Linear API-key install (#2750).
 *
 * Second {@link FormBasedInstallHandler} implementation after Email
 * (#2697). The admin pastes a Linear Personal API Key from their
 * Linear settings page; the key encrypts inline via
 * {@link encryptSecretFields} into `workspace_plugins.config.api_key`.
 *
 * Trade-off vs the OAuth mode (`linear` slug — see
 * {@link LinearOAuthInstallHandler}):
 *
 *   - **API-key mode** is the simplest install: no OAuth App
 *     registration, no callback URL plumbing, no refresh-token
 *     lifecycle. Drawback: the key is tied to one Linear user — if
 *     that user is deactivated, Atlas's access dies and the workspace
 *     admin has to issue a new key. Also, API keys don't carry per-
 *     workspace scoping, so a deactivated user's key is useless for
 *     any of their workspaces.
 *   - **OAuth mode** rotates access tokens automatically and survives
 *     the granting user being deactivated (the refresh-token flow re-
 *     issues an access token tied to the OAuth grant, not the user
 *     session).
 *
 * SaaS-eligible at the entry plan tier per the catalog declaration —
 * API-key mode is mostly a self-host convenience but acceptable on SaaS
 * for entry-tier workspaces where the OAuth dance feels like overkill.
 *
 * Connection liveness: NOT probed at install time. A failed Linear API
 * round-trip at install would surface as a misleading "couldn't reach
 * Linear" error even when the user's key is correct; the first
 * agent-issued `createLinearIssue` call surfaces real auth errors with
 * the full path intact (HTTP 401 vs API rate-limit vs network).
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./linear-apikey-secret-schema.ts — shared form + secret schema
 * @see ./email-form-handler.ts — first form-based handler reference
 * @see ../../plugins/secrets.ts — {@link encryptSecretFields}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { WorkspaceId } from "@useatlas/types";
import {
  LINEAR_APIKEY_CATALOG_ID,
  LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
  LinearApiKeyFormDataSchema,
} from "./linear-apikey-secret-schema";
import { FormInstallValidationError } from "./email-form-handler";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

// Re-export the validation error class for callers that catch with
// `instanceof`. {@link FormInstallValidationError} is the canonical
// throw type for every form-based install handler — declared in the
// Email module first per #2697.
export { FormInstallValidationError };

const log = createLogger("integrations.install.linear-apikey");

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
const LINEAR_APIKEY_SLUG: CatalogId = "linear-apikey";

/** Test-only injection of the install id generator. */
export interface LinearApiKeyFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class LinearApiKeyFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: LinearApiKeyFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Validate the form against the API-key schema ─────────────
    const parsed = LinearApiKeyFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const config = parsed.data;

    // ── 2. SaaS keyset gate ─────────────────────────────────────────
    // `encryptSecret` falls back to plaintext when no key is configured
    // (dev convenience). Boot logs a one-shot warning, but a missed log
    // in SaaS would leak the API key plaintext. Refuse the install per-
    // call so a misconfigured deploy fails closed at the credential
    // boundary. Mirrors EmailFormInstallHandler's posture.
    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext api_key)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    // ── 3. Encrypt secret fields (api_key) at rest ──────────────────
    const encryptedConfig = encryptSecretFields(config, LINEAR_APIKEY_SECRET_FIELDS_SCHEMA);

    // ── 4. Upsert workspace_plugins ─────────────────────────────────
    // Pillar='action' + install_id named explicitly per migration 0092
    // (#2739). The partial unique index keys re-installs to the same
    // row; `RETURNING id` lets us pick up the existing id rather than a
    // phantom freshly-generated one on conflict (per EmailFormInstallHandler
    // commentary).
    const candidateId = this.newId();
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
        [candidateId, workspaceId, LINEAR_APIKEY_CATALOG_ID, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // INSERT ... ON CONFLICT ... DO UPDATE RETURNING is guaranteed
        // by Postgres to emit exactly one row on both paths. Reaching
        // here means a structural anomaly (driver rewrite, RLS hiding
        // the result, partial-index miss). Falling back to candidateId
        // would silently return a WRONG id on the DO UPDATE path
        // (persisted row keeps its existing id, not the candidate),
        // and downstream lookups would create phantom updates. Fail
        // loud so the operator sees the invariant break with a 500.
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
        "Failed to persist Linear API-key install record — aborting install",
      );
      throw err;
    }

    // Evict any cached PluginLike for this (workspace, catalog) so the
    // next tool dispatch rebuilds against the freshly-persisted config.
    // Without this, a re-install that rotates the API key keeps the
    // stale in-memory instance from before the upsert. Fire-and-forget
    // — `evict` swallows teardown errors internally.
    try {
      await lazyPluginLoader.evict(workspaceId, LINEAR_APIKEY_CATALOG_ID);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "LazyPluginLoader.evict threw after Linear API-key install upsert — DB row is persisted anyway",
      );
    }

    log.info(
      {
        workspaceId,
        installId: persistedId,
        workspaceName: config.workspace_name ?? null,
      },
      "Linear API-key install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: LINEAR_APIKEY_SLUG },
      credentialWritten: true,
    };
  }
}
