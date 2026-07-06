/**
 * `ConfluenceFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `confluence` Knowledge Base catalog row (#4377, PRD #4375).
 *
 * Installing `confluence` creates a **synced collection** mirroring ONE
 * Confluence Cloud space: a `pillar='knowledge'` `workspace_plugins` row
 * (multi-instance, `install_id` = collection slug) whose config carries the site
 * base URL + email + space key. The Scheduler dispatches the registered
 * Confluence connector on a cadence (`lib/knowledge/connector-sync.ts`), and
 * every synced page lands `draft` behind the review gate.
 *
 * Three things it does beyond the bundle-sync precedent:
 *   1. **SSRF gate at install time.** The base URL is admin-supplied and Atlas
 *      fetches it server-side on a schedule — so it is validated through
 *      `assertBaseUrlAllowed` here and re-validated by `guardedFetch` on every
 *      request. A blocked target is a field-level 400.
 *   2. **Loud credential verification.** Before persisting anything, it resolves
 *      the space with the supplied credentials (`verifyConfluenceAccess`) — a
 *      bad token / invalid space key fails the install with actionable guidance
 *      instead of silently creating a collection that never syncs.
 *   3. **The API token is a Knowledge Base credential.** It routes to the
 *      dedicated `knowledge_sync_credentials` table (encrypted), NEVER to
 *      `workspace_plugins.config`. Write order mirrors bundle-sync: verify →
 *      SaaS keyset gate → credential row → install row.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import {
  assertBaseUrlAllowed,
  EgressBlockedError,
  hostForLog,
} from "@atlas/api/lib/openapi/egress-guard";
import {
  saveSyncCredential,
  deleteSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  verifyConfluenceAccess,
  type ConfluenceClientDeps,
} from "@atlas/api/lib/knowledge/confluence/client";
import {
  CONFLUENCE_SLUG,
  CONFLUENCE_CATALOG_ID,
  type ConfluenceCollectionConfig,
} from "@atlas/api/lib/knowledge/confluence/config";
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
export { CONFLUENCE_SLUG, CONFLUENCE_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const BASE_URL_MAX = 2048;
const EMAIL_MAX = 320;
const SPACE_KEY_MAX = 255;
const API_TOKEN_MAX = 4096;

export interface ConfluenceFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the verification fetch (no real Atlassian call). */
  readonly clientDeps?: ConfluenceClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to
 * `KNOWLEDGE_INSTALL_UPSERT_SQL` (okf-upload) / `BUNDLE_SYNC_INSTALL_UPSERT_SQL`:
 * `status='published'` because the COLLECTION container is live immediately —
 * the review gate is on the DOCUMENTS, which always sync in as `draft`. Exported
 * so the real-Postgres test executes this exact string against the live schema.
 */
export const CONFLUENCE_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class ConfluenceFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: ConfluenceClientDeps;
  private readonly log = createLogger("integrations.install.confluence");

  constructor(options: ConfluenceFormInstallHandlerOptions = {}) {
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

    const collectionSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], CONFLUENCE_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const baseUrl = validateBaseUrl(rawForm.base_url);
    const email = validateEmail(rawForm.email);
    const spaceKey = validateSpaceKey(rawForm.space_key);
    const apiToken = validateApiToken(rawForm.api_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [CONFLUENCE_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "confluence catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${CONFLUENCE_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionSlugAvailable(workspaceId, collectionSlug, catalogId);

    // ── Verify the connection loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ baseUrl, email, apiToken, spaceKey, collectionSlug });

    // ── Credential first (mirrors the bundle-sync write order) ──────────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "api_token");
    try {
      await saveSyncCredential(workspaceId, collectionSlug, apiToken);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install",
      );
      throw err;
    }

    // ── Upsert the collection container (never carries the token) ────────────
    const config: ConfluenceCollectionConfig = {
      base_url: baseUrl,
      email,
      space_key: spaceKey,
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(CONFLUENCE_INSTALL_UPSERT_SQL, [
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
      // failure is logged, never masks the original error.
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist confluence collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      { workspaceId, collectionSlug, rowId: persistedId, siteHost: hostForLog(baseUrl), spaceKey },
      "Confluence collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: CONFLUENCE_SLUG },
      credentialWritten: true,
    };
  }

  /** Resolve the space with the supplied creds; map every failure to a 400. */
  private async verifyConnection(input: {
    baseUrl: string;
    email: string;
    apiToken: string;
    spaceKey: string;
    collectionSlug: string;
  }): Promise<void> {
    try {
      await verifyConfluenceAccess(input, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new FormInstallValidationError({
          fieldErrors: { base_url: [err.message] },
          formErrors: [],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      // Non-credential failures — a 429 (ConnectorRateLimitError) or a
      // transport error (DNS/timeout/non-JSON; the client marks those with
      // `cause`) — are form-level: blaming the api_token field would send the
      // admin re-entering a token that may be fine. All host-redacted.
      if (err instanceof ConnectorRateLimitError || (err instanceof Error && err.cause !== undefined)) {
        throw new FormInstallValidationError({
          fieldErrors: {},
          formErrors: [message],
        });
      }
      // Auth (401/403) / space-not-found — actionable, already host-redacted.
      throw new FormInstallValidationError({
        fieldErrors: { api_token: [message] },
        formErrors: [],
      });
    }
  }
}

/** Validate the site base URL: required, https, bounded, SSRF-allowed. */
function validateBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("base_url", "The Confluence site URL is required (e.g. https://your-team.atlassian.net/wiki).");
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length > BASE_URL_MAX) {
    throw fieldError("base_url", `The Confluence site URL must be ${BASE_URL_MAX} characters or fewer.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // intentionally ignored: the URL constructor throw is the negative signal.
    throw fieldError("base_url", "The Confluence site URL must be a well-formed URL (e.g. https://your-team.atlassian.net/wiki).");
  }
  if (parsed.protocol !== "https:") {
    throw fieldError("base_url", "The Confluence site URL must be https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw fieldError("base_url", "Remove the credentials from the URL — use the email + API token fields instead (the token is stored encrypted).");
  }
  try {
    assertBaseUrlAllowed(trimmed);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw fieldError("base_url", err.message);
    }
    throw err;
  }
  return trimmed;
}

function validateEmail(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("email", "The Atlassian account email is required.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > EMAIL_MAX) {
    throw fieldError("email", `The email must be ${EMAIL_MAX} characters or fewer.`);
  }
  if (!trimmed.includes("@")) {
    throw fieldError("email", "Enter a valid Atlassian account email.");
  }
  return trimmed;
}

function validateSpaceKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("space_key", "The Confluence space key is required (e.g. ENG).");
  }
  const trimmed = raw.trim();
  if (trimmed.length > SPACE_KEY_MAX) {
    throw fieldError("space_key", `The space key must be ${SPACE_KEY_MAX} characters or fewer.`);
  }
  return trimmed;
}

function validateApiToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("api_token", "An API token is required. Create one at id.atlassian.com → Security → API tokens.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > API_TOKEN_MAX) {
    throw fieldError("api_token", `The API token must be ${API_TOKEN_MAX} characters or fewer.`);
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
