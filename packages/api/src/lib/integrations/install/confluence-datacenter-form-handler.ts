/**
 * `ConfluenceDatacenterFormInstallHandler` — the {@link FormBasedInstallHandler}
 * for the built-in `confluence-datacenter` Knowledge Base catalog row (#4394,
 * PRD #4375). The self-managed sibling of the Cloud handler
 * (`confluence-form-handler.ts`).
 *
 * Installing `confluence-datacenter` creates a **synced collection** mirroring
 * ONE Confluence Server/DC space: a `pillar='knowledge'` `workspace_plugins` row
 * (multi-instance, `install_id` = collection slug) whose config carries the base
 * URL + space key. The Scheduler dispatches the registered Confluence DC
 * connector on a cadence (`lib/knowledge/connector-sync.ts`), and every synced
 * page lands `draft` behind the review gate.
 *
 * It mirrors the Cloud handler's three properties, differing only in the
 * credential shape — a Personal Access Token (Bearer), with no paired email:
 *   1. **SSRF gate at install time.** The base URL is admin-supplied and Atlas
 *      fetches it server-side on a schedule — so it is validated through
 *      `assertBaseUrlAllowed` here and re-validated by `guardedFetch` on every
 *      request. A blocked target is a field-level 400.
 *   2. **Loud credential verification.** Before persisting anything, it resolves
 *      the space with the supplied PAT (`verifyConfluenceDatacenterAccess`) — a
 *      bad token / invalid space key fails the install with actionable guidance
 *      instead of silently creating a collection that never syncs.
 *   3. **The PAT is a Knowledge Base credential.** It routes to the dedicated
 *      `knowledge_sync_credentials` table (encrypted), NEVER to
 *      `workspace_plugins.config`. Write order mirrors the Cloud handler: verify
 *      → SaaS keyset gate → credential row → install row (rollback on failure).
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
  verifyConfluenceDatacenterAccess,
  type ConfluenceDcClientDeps,
} from "@atlas/api/lib/knowledge/confluence/client-datacenter";
import {
  CONFLUENCE_DC_SLUG,
  CONFLUENCE_DC_CATALOG_ID,
  type ConfluenceDcCollectionConfig,
} from "@atlas/api/lib/knowledge/confluence/config-datacenter";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import { isPlanDenial } from "./retryable-install-error";
import {
  KNOWLEDGE_INSTALL_ID_FIELD,
  resolveCollectionSlug,
} from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config-datacenter.ts.
export { CONFLUENCE_DC_SLUG, CONFLUENCE_DC_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const BASE_URL_MAX = 2048;
const SPACE_KEY_MAX = 255;
const API_TOKEN_MAX = 4096;

export interface ConfluenceDatacenterFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the verification fetch (no real Confluence call). */
  readonly clientDeps?: ConfluenceDcClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to the Cloud
 * handler's `CONFLUENCE_INSTALL_UPSERT_SQL`: `status='published'` because the
 * COLLECTION container is live immediately — the review gate is on the
 * DOCUMENTS, which always sync in as `draft`. Exported so the real-Postgres test
 * executes this exact string against the live schema.
 */
export const CONFLUENCE_DC_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class ConfluenceDatacenterFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: ConfluenceDcClientDeps;
  private readonly log = createLogger("integrations.install.confluence-datacenter");

  constructor(options: ConfluenceDatacenterFormInstallHandlerOptions = {}) {
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

    const collectionSlug = resolveCollectionSlug(
      rawForm[KNOWLEDGE_INSTALL_ID_FIELD],
      CONFLUENCE_DC_SLUG,
    );

    // ── Validate fields ────────────────────────────────────────────────────
    const baseUrl = validateBaseUrl(rawForm.base_url);
    const spaceKey = validateSpaceKey(rawForm.space_key);
    const apiToken = validateApiToken(rawForm.api_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [CONFLUENCE_DC_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "confluence-datacenter catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${CONFLUENCE_DC_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, collectionSlug, catalogId, this.log);

    // ── Verify the connection loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ baseUrl, apiToken, spaceKey, collectionSlug });

    // ── Credential first (mirrors the Cloud handler's write order) ──────────
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
    const config: ConfluenceDcCollectionConfig = {
      base_url: baseUrl,
      space_key: spaceKey,
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const returned = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: collectionSlug,
        sql: CONFLUENCE_DC_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, collectionSlug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
      persistedId = returned;
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (its install row never landed, so uninstall would never reach
      // it). Best-effort — a re-install overwrites it either way; a cleanup
      // failure is logged, never masks the original error.
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        isPlanDenial(err)
          ? "Failed to persist confluence-datacenter collection install — rolling back the orphaned credential (the workspace is at a plan limit — retrying will not help)"
          : "Failed to persist confluence-datacenter collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      "Confluence Data Center collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: CONFLUENCE_DC_SLUG },
      credentialWritten: true,
    };
  }

  /** Resolve the space with the supplied PAT; map every failure to a 400. */
  private async verifyConnection(input: {
    baseUrl: string;
    apiToken: string;
    spaceKey: string;
    collectionSlug: string;
  }): Promise<void> {
    try {
      await verifyConfluenceDatacenterAccess(input, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new FormInstallValidationError({
          fieldErrors: { base_url: [err.message] },
          formErrors: [],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      // Non-credential failures — a 429 (ConnectorRateLimitError) or a transport
      // error (DNS/timeout/non-JSON; the client marks those with `cause`) — are
      // form-level: blaming the api_token field would send the admin re-entering
      // a token that may be fine. All host-redacted.
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
    throw fieldError("base_url", "The Confluence base URL is required (e.g. https://confluence.your-company.com).");
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length > BASE_URL_MAX) {
    throw fieldError("base_url", `The Confluence base URL must be ${BASE_URL_MAX} characters or fewer.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // intentionally ignored: the URL constructor throw is the negative signal.
    throw fieldError("base_url", "The Confluence base URL must be a well-formed URL (e.g. https://confluence.your-company.com).");
  }
  if (parsed.protocol !== "https:") {
    throw fieldError("base_url", "The Confluence base URL must be https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw fieldError("base_url", "Remove the credentials from the URL — use the Personal Access Token field instead (the token is stored encrypted).");
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
    throw fieldError("api_token", "A Personal Access Token is required. Create one in Confluence → Profile → Personal Access Tokens.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > API_TOKEN_MAX) {
    throw fieldError("api_token", `The Personal Access Token must be ${API_TOKEN_MAX} characters or fewer.`);
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
