/**
 * `NotionKnowledgeFormInstallHandler` — the {@link FormBasedInstallHandler} for
 * the built-in `notion-knowledge` catalog row (#4378, PRD #4375). Installing it
 * creates a **synced knowledge collection** whose content comes from Notion via
 * an internal-integration token.
 *
 * ONE COLLECTION PER AUTHORIZATION: the pages a customer shares with the
 * integration ARE the scope — there is no space/endpoint field to configure
 * (unlike bundle-sync). Install is therefore just a token + optional
 * description. The token is the load-bearing artefact: it routes to the shared
 * `knowledge_sync_credentials` table (encrypted via `db/secret-encryption.ts`,
 * an `INTEGRATION_TABLES` participant), NEVER to `workspace_plugins.config`.
 * Write order mirrors the bundle-sync handler: SaaS keyset gate → credential
 * row → install row (re-running the install heals a half-completed pair).
 *
 * There is no SSRF surface here (the API host is a fixed Notion constant, not a
 * customer-supplied URL), so no egress guard — the only field validation is a
 * non-empty, bounded, whitespace-free token. Re-installing an existing slug
 * edits the description in place and re-stores the token (secrets are never
 * echoed back, so a token is required on every save — same posture as
 * bundle-sync's required secret).
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import { saveSyncCredential } from "@atlas/api/lib/knowledge/sync-credentials";
import { NOTION_KNOWLEDGE_SLUG } from "@atlas/api/lib/knowledge/notion/connector";
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

/** Defensive upper bound — a Notion token is ~50 chars; guard against a paste. */
const TOKEN_MAX = 512;

/** The non-secret config persisted on the `workspace_plugins` row (no token). */
export interface NotionKnowledgeCollectionConfig {
  readonly description?: string;
}

/**
 * The multi-instance synced-collection upsert (identical shape to the
 * okf-upload / bundle-sync knowledge upserts): `status='published'` because the
 * COLLECTION container is live immediately — the review gate is on the
 * DOCUMENTS, which always sync in as `draft`. Exported so the real-Postgres
 * test executes this exact string against the live schema.
 */
export const NOTION_KNOWLEDGE_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface NotionKnowledgeFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
}

export class NotionKnowledgeFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly log = createLogger("integrations.install.notion-knowledge");

  constructor(options: NotionKnowledgeFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
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
      NOTION_KNOWLEDGE_SLUG,
    );

    const token = validateToken(rawForm.integration_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled so a seed misconfig surfaces
    // as a clear 500 rather than an opaque FK error on the INSERT below.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [NOTION_KNOWLEDGE_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "notion-knowledge catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${NOTION_KNOWLEDGE_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // A slug taken by another knowledge catalog (okf-upload / bundle-sync) would
    // merge document trees — reject before any write.
    await assertCollectionSlugAvailable(workspaceId, collectionSlug, catalogId);

    // ── Credential first (mirrors the bundle-sync / Twenty write order) ────────
    // SaaS keyset gate BEFORE any credential byte is persisted — a misconfigured
    // SaaS deploy must fail closed, never store plaintext.
    assertSaasEncryptionKeyset(this.log, workspaceId, "integration_token");
    try {
      await saveSyncCredential(workspaceId, collectionSlug, token);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install",
      );
      throw err;
    }

    // ── Upsert the collection container (never carries the token) ──────────────
    const config: NotionKnowledgeCollectionConfig = {
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(NOTION_KNOWLEDGE_INSTALL_UPSERT_SQL, [
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
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist notion-knowledge collection install — aborting install (the credential write is idempotent; retrying the install is safe)",
      );
      throw err;
    }

    this.log.info(
      { workspaceId, collectionSlug, rowId: persistedId },
      "Notion knowledge collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: NOTION_KNOWLEDGE_SLUG },
      credentialWritten: true,
    };
  }
}

/**
 * Validate the internal-integration token: required, bounded, no internal
 * whitespace (a Notion token is a single opaque string — an embedded space is a
 * paste error). The token is never echoed, so it is required on every save.
 */
function validateToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FormInstallValidationError({
      fieldErrors: {
        integration_token: [
          "A Notion internal-integration token is required. Create one at notion.so/my-integrations and share your pages with it.",
        ],
      },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > TOKEN_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: { integration_token: [`Token must be ${TOKEN_MAX} characters or fewer.`] },
      formErrors: [],
    });
  }
  if (/\s/.test(trimmed)) {
    throw new FormInstallValidationError({
      fieldErrors: {
        integration_token: ["Token must not contain spaces — paste the token exactly as Notion shows it."],
      },
      formErrors: [],
    });
  }
  return trimmed;
}

/** Optional human description — same rule as the bundle-sync handler. */
function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new FormInstallValidationError({
      fieldErrors: { description: ["Description must be a string."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
