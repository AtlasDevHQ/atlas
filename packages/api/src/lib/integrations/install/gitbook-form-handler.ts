/**
 * `GitbookFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `gitbook` Knowledge Base catalog row (#4393, ADR-0030).
 *
 * Installing `gitbook` creates a **synced collection** mirroring ONE GitBook
 * Cloud space: a `pillar='knowledge'` `workspace_plugins` row (multi-instance,
 * `install_id` = collection slug) whose config carries the space id. The
 * Scheduler dispatches the registered GitBook connector on a cadence
 * (`lib/knowledge/connector-sync.ts`), and every synced page lands `draft`
 * behind the review gate.
 *
 * GitBook's API host is a FIXED vendor constant (`api.gitbook.com`), not a
 * customer-supplied URL, so there is no install-time SSRF gate (the connector
 * still routes every request through the egress guard at fetch time). Field
 * validation accepts either a bare space id or an `app.gitbook.com/o/…/s/<id>/…`
 * URL (the id is extracted). Beyond that it mirrors the Notion/Confluence
 * handlers:
 *   1. **Loud credential verification.** Before persisting anything, it resolves
 *      the space with the supplied credentials (`verifyGitbookAccess`) — a bad
 *      token / invalid space id fails the install with actionable guidance
 *      instead of silently creating a collection that never syncs.
 *   2. **The API token is a Knowledge Base credential.** It routes to the
 *      dedicated `knowledge_sync_credentials` table (encrypted), NEVER to
 *      `workspace_plugins.config`. Write order mirrors Confluence/Notion: verify
 *      → SaaS keyset gate → credential row → install row (rollback on failure).
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
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  verifyGitbookAccess,
  type GitbookClientDeps,
} from "@atlas/api/lib/knowledge/gitbook/client";
import {
  GITBOOK_SLUG,
  GITBOOK_CATALOG_ID,
  type GitbookCollectionConfig,
} from "@atlas/api/lib/knowledge/gitbook/config";
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

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { GITBOOK_SLUG, GITBOOK_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const SPACE_ID_INPUT_MAX = 2048;
const SPACE_ID_MAX = 255;
const API_TOKEN_MAX = 4096;

/** GitBook space ids are opaque url-safe tokens. */
const SPACE_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface GitbookFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the verification fetch (no real GitBook call). */
  readonly clientDeps?: GitbookClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to the
 * okf-upload / bundle-sync / Confluence / Notion knowledge upserts:
 * `status='published'` because the COLLECTION container is live immediately —
 * the review gate is on the DOCUMENTS, which always sync in as `draft`. Exported
 * so the real-Postgres test executes this exact string against the live schema.
 */
export const GITBOOK_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class GitbookFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: GitbookClientDeps;
  private readonly log = createLogger("integrations.install.gitbook");

  constructor(options: GitbookFormInstallHandlerOptions = {}) {
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

    const collectionSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], GITBOOK_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const spaceId = validateSpaceId(rawForm.space_id);
    const apiToken = validateApiToken(rawForm.api_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [GITBOOK_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "gitbook catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${GITBOOK_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, collectionSlug, catalogId, this.log);

    // ── Verify the connection loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ spaceId, apiToken, collectionSlug });

    // ── Credential first (mirrors the Confluence/Notion write order) ────────
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
    const config: GitbookCollectionConfig = {
      space_id: spaceId,
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const returned = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: collectionSlug,
        sql: GITBOOK_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, collectionSlug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
      persistedId = returned;
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (its install row never landed, so uninstall would never reach
      // it). Best-effort — a re-install overwrites it either way; a cleanup
      // failure is logged, never masks the original error. Same block as the
      // Confluence/Notion handlers — keep them in step.
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        isPlanDenial(err)
          ? "Failed to persist gitbook collection install — rolling back the orphaned credential (the workspace is at a plan limit — retrying will not help)"
          : "Failed to persist gitbook collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      { workspaceId, collectionSlug, rowId: persistedId, spaceId },
      "GitBook collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: GITBOOK_SLUG },
      credentialWritten: true,
    };
  }

  /** Resolve the space with the supplied creds; map every failure to a 400. */
  private async verifyConnection(input: {
    spaceId: string;
    apiToken: string;
    collectionSlug: string;
  }): Promise<void> {
    try {
      await verifyGitbookAccess(input, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        // Defence-in-depth: the fixed GitBook host should never be blocked, but
        // if a deploy's egress policy blocks it, surface it as a form-level error.
        throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [err.message] });
      }
      const message = err instanceof Error ? err.message : String(err);
      // Non-credential failures — a 429 (ConnectorRateLimitError) or a transport
      // error (DNS/timeout/non-JSON; the client marks those with `cause`) — are
      // form-level: blaming a field would send the admin re-entering a value that
      // may be fine. All host-redacted.
      if (err instanceof ConnectorRateLimitError || (err instanceof Error && err.cause !== undefined)) {
        throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [message] });
      }
      // Auth (401/403) → the token; anything else actionable (a 404, or a space
      // object with no id — "not found or not visible") → the space id. Both are
      // already host-redacted + actionable.
      const field = /rejected the credentials|\b401\b|\b403\b/.test(message) ? "api_token" : "space_id";
      throw new FormInstallValidationError({ fieldErrors: { [field]: [message] }, formErrors: [] });
    }
  }
}

/**
 * Extract a GitBook space id from a raw input. Accepts a bare id, or an
 * `app.gitbook.com/o/<org>/s/<spaceId>/…` app URL (the `/s/<id>/` segment is the
 * space id). Exported for the unit test.
 */
export function extractSpaceId(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // intentionally ignored: fall through to the "unparseable" field error.
      return "";
    }
    const match = parsed.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
  }
  return trimmed;
}

/** Validate the space id: required, bounded, a bare id or extractable from a URL. */
function validateSpaceId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "space_id",
      "The GitBook space id is required. Copy it from your space URL (app.gitbook.com/o/…/s/<space-id>/…), or paste the space URL.",
    );
  }
  if (raw.length > SPACE_ID_INPUT_MAX) {
    throw fieldError("space_id", `The space id must be ${SPACE_ID_INPUT_MAX} characters or fewer.`);
  }
  const spaceId = extractSpaceId(raw);
  if (spaceId === "" || spaceId.length > SPACE_ID_MAX || !SPACE_ID_RE.test(spaceId)) {
    throw fieldError(
      "space_id",
      "Enter a valid GitBook space id, or the space URL it appears in (app.gitbook.com/o/…/s/<space-id>/…).",
    );
  }
  return spaceId;
}

function validateApiToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("api_token", "An API token is required. Create one at app.gitbook.com → Settings → Developer → API tokens.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > API_TOKEN_MAX) {
    throw fieldError("api_token", `The API token must be ${API_TOKEN_MAX} characters or fewer.`);
  }
  if (/\s/.test(trimmed)) {
    throw fieldError("api_token", "Token must not contain spaces — paste it exactly as GitBook shows it.");
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
