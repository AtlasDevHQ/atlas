/**
 * `IntercomFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `intercom` Knowledge Base catalog row (#4399, PRD #4395).
 *
 * Installing `intercom` creates a **synced collection** mirroring the
 * workspace's Intercom Articles: a `pillar='knowledge'` `workspace_plugins` row
 * (multi-instance, `install_id` = collection slug) whose config carries only an
 * optional description. Intercom has no multi-brand concept — ONE workspace maps
 * to ONE collection — so, unlike Zendesk, there is no fan-out. The Scheduler
 * dispatches the registered Intercom connector on a cadence
 * (`lib/knowledge/connector-sync.ts`), and every synced article translation
 * lands `draft` behind the review gate.
 *
 * Intercom's API host is a FIXED vendor constant (`api.intercom.io`), not a
 * customer-supplied URL, so there is no install-time SSRF gate (the connector
 * still routes every request through the egress guard at fetch time). Beyond
 * that it mirrors the GitBook/Notion handlers:
 *   1. **Loud credential verification.** Before persisting anything, it resolves
 *      the authenticated admin with the supplied token (`verifyIntercomAccess`)
 *      — a bad token fails the install with actionable guidance instead of
 *      silently creating a collection that never syncs.
 *   2. **The access token is a Knowledge Base credential.** It routes to the
 *      dedicated `knowledge_sync_credentials` table (encrypted), NEVER to
 *      `workspace_plugins.config`. Write order mirrors GitBook/Notion: verify →
 *      SaaS keyset gate → credential row → install row (rollback on failure).
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import { EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import {
  saveSyncCredential,
  deleteSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import {
  verifyIntercomAccess,
  IntercomAuthError,
  type IntercomClientDeps,
} from "@atlas/api/lib/knowledge/intercom/client";
import {
  INTERCOM_SLUG,
  INTERCOM_CATALOG_ID,
  type IntercomCollectionConfig,
} from "@atlas/api/lib/knowledge/intercom/config";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionSlugAvailable,
  resolveCollectionSlug,
  KNOWLEDGE_INSTALL_ID_FIELD,
} from "./okf-upload-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { INTERCOM_SLUG, INTERCOM_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const ACCESS_TOKEN_MAX = 4096;

export interface IntercomFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the verification fetch (no real Intercom call). */
  readonly clientDeps?: IntercomClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to the
 * okf-upload / GitBook / Zendesk knowledge upserts: `status='published'` because
 * the COLLECTION container is live immediately — the review gate is on the
 * DOCUMENTS, which always sync in as `draft`. Exported so the real-Postgres test
 * executes this exact string against the live schema.
 */
export const INTERCOM_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class IntercomFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: IntercomClientDeps;
  private readonly log = createLogger("integrations.install.intercom");

  constructor(options: IntercomFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.clientDeps = options.clientDeps ?? {};
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{ readonly installRecord: InstallRecord; readonly credentialWritten: boolean }> {
    if (formData === null || typeof formData !== "object" || Array.isArray(formData)) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: ["Request body must be a JSON object of config fields."],
      });
    }
    const rawForm = formData as Record<string, unknown>;

    const collectionSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], INTERCOM_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const accessToken = validateAccessToken(rawForm.access_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [INTERCOM_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "intercom catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${INTERCOM_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionSlugAvailable(workspaceId, collectionSlug, catalogId);

    // ── Verify the connection loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ accessToken, collectionSlug });

    // ── Credential first (mirrors the GitBook/Notion write order) ───────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "access_token");
    try {
      await saveSyncCredential(workspaceId, collectionSlug, accessToken);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install",
      );
      throw err;
    }

    // ── Upsert the collection container (never carries the token) ────────────
    const config: IntercomCollectionConfig = {
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(INTERCOM_INSTALL_UPSERT_SQL, [
        candidateId,
        workspaceId,
        catalogId,
        collectionSlug,
        JSON.stringify(config),
      ]);
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        this.log.error(
          { workspaceId, candidateId, collectionSlug },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (its install row never landed, so uninstall would never reach
      // it). Best-effort — a re-install overwrites it either way; a cleanup
      // failure is logged, never masks the original error. Same block as the
      // GitBook/Notion handlers — keep them in step.
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist intercom collection install — rolling back the orphaned credential (retrying the install is safe)",
      );
      try {
        await deleteSyncCredential(workspaceId, collectionSlug);
      } catch (cleanupErr) {
        this.log.error(
          { workspaceId, collectionSlug, err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
          "Failed to roll back the orphaned credential after an install-row failure — a re-install overwrites it",
        );
      }
      throw err;
    }

    this.log.info(
      { workspaceId, collectionSlug, rowId: persistedId },
      "Intercom collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: INTERCOM_SLUG },
      credentialWritten: true,
    };
  }

  /**
   * Resolve the admin with the supplied token; map every failure to a 400.
   * Classification is POSITIVE, by `instanceof` on the client's typed errors —
   * never by message text or `cause`-presence sniffing — so only a failure the
   * client KNOWS is credential-shaped blames the access_token field; an Intercom
   * outage or transport error stays form-level. All messages host-redacted.
   */
  private async verifyConnection(input: {
    accessToken: string;
    collectionSlug: string;
  }): Promise<void> {
    try {
      await verifyIntercomAccess(
        { apiToken: input.accessToken, collectionSlug: input.collectionSlug },
        this.clientDeps,
      );
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        // Defence-in-depth: the fixed Intercom host should never be blocked, but
        // if a deploy's egress policy blocks it, surface it as a form-level error.
        throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [err.message] });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof IntercomAuthError) {
        throw new FormInstallValidationError({
          fieldErrors: { access_token: [message] },
          formErrors: [],
        });
      }
      // Everything else — a 429 (ConnectorRateLimitError), vendor 5xx,
      // transport/DNS/non-JSON, or a hollow /me — is form-level: blaming a field
      // would send the admin re-entering a value that may be fine.
      throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [message] });
    }
  }
}

function validateAccessToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "access_token",
      "An access token is required. Create one in Intercom → Settings → Developers → your app → Authentication (or use your app's Access Token).",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > ACCESS_TOKEN_MAX) {
    throw fieldError("access_token", `The access token must be ${ACCESS_TOKEN_MAX} characters or fewer.`);
  }
  if (/\s/.test(trimmed)) {
    throw fieldError("access_token", "Token must not contain spaces — paste it exactly as Intercom shows it.");
  }
  return trimmed;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw fieldError("description", "Description must be a string.");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function fieldError(field: string, message: string): FormInstallValidationError {
  return new FormInstallValidationError({ fieldErrors: { [field]: [message] }, formErrors: [] });
}
