/**
 * `GitHubPatFormInstallHandler` — GitHub Personal Access Token install
 * (#2751, Phase D PAT mode).
 *
 * Form-based install mirroring {@link LinearApiKeyFormInstallHandler}.
 * The admin pastes a PAT from https://github.com/settings/tokens; the
 * token encrypts inline via {@link encryptSecretFields} into
 * `workspace_plugins.config.pat`.
 *
 * Self-host only: the matching catalog row carries `saas_eligible:
 * false`. Failure mode is too sharp for SaaS — a PAT is tied to one
 * GitHub user and dies if that user leaves the org or rotates the
 * token. The integrations-catalog route filters this row out on SaaS
 * deploys.
 *
 * Connection liveness: NOT probed at install time. A failed GitHub API
 * round-trip at install would surface as a misleading "couldn't reach
 * GitHub" error even when the user's token is correct; the first
 * agent-issued GitHub call surfaces real auth errors with the full
 * path intact (HTTP 401 vs API rate-limit vs network).
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./github-pat-secret-schema.ts — shared form + secret schema
 * @see ./linear-apikey-form-handler.ts — sibling form-handler reference
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
  GITHUB_PAT_CATALOG_ID,
  GITHUB_PAT_SECRET_FIELDS_SCHEMA,
  GitHubPatFormDataSchema,
} from "./github-pat-secret-schema";
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

const log = createLogger("integrations.install.github-pat");

const GITHUB_PAT_SLUG: CatalogId = "github-pat";

export interface GitHubPatFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class GitHubPatFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: GitHubPatFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Validate the form against the PAT schema ────────────────
    const parsed = GitHubPatFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const config = parsed.data;

    // ── 2. SaaS keyset gate ─────────────────────────────────────────
    // The matching catalog row is `saas_eligible: false`, so the
    // integrations-catalog route already hides this install path on
    // SaaS — a caller would have to bypass that filter to reach here.
    // The keyset gate stays as defense-in-depth: if a SaaS deploy
    // somehow surfaces the install path, refuse to persist plaintext.
    // Mirrors LinearApiKeyFormInstallHandler's posture.
    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext pat)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    // ── 3. Encrypt secret fields (pat) at rest ──────────────────────
    const encryptedConfig = encryptSecretFields(config, GITHUB_PAT_SECRET_FIELDS_SCHEMA);

    // ── 4. Upsert workspace_plugins ─────────────────────────────────
    // Pillar='action' + install_id named explicitly per migration 0092
    // (#2739). The partial unique index keys re-installs to the same
    // row; `RETURNING id` lets us pick up the existing id rather than a
    // phantom freshly-generated one on conflict.
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
        [candidateId, workspaceId, GITHUB_PAT_CATALOG_ID, JSON.stringify(encryptedConfig)],
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
        "Failed to persist GitHub PAT install record — aborting install",
      );
      throw err;
    }

    // Evict any cached PluginLike for this (workspace, catalog) so a
    // future agent-tool dispatch rebuilds against the freshly-persisted
    // config. The GitHub action tool ships in a follow-up PR; the evict
    // call stays here so re-installs that rotate the PAT don't leave a
    // stale in-memory instance behind once the tool lands.
    try {
      await lazyPluginLoader.evict(workspaceId, GITHUB_PAT_CATALOG_ID);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "LazyPluginLoader.evict threw after GitHub PAT install upsert — DB row is persisted anyway",
      );
    }

    log.info(
      {
        workspaceId,
        installId: persistedId,
        defaultOwner: config.default_owner ?? null,
      },
      "GitHub PAT install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: GITHUB_PAT_SLUG },
      credentialWritten: true,
    };
  }
}
