/**
 * `OkfUploadFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `okf-upload` Knowledge Base catalog row (#4207, ADR-0028 §5).
 *
 * Installing `okf-upload` creates a **collection**: a `pillar='knowledge'`
 * `workspace_plugins` row whose `install_id` is the collection slug. It is the
 * ADR's "explicit, degenerate form install" — no credentials, a single optional
 * `description` config field. Knowledge is on the MULTI-INSTANCE side of
 * `workspace_plugins` (excluded from the singleton partial unique, like
 * datasource), so a workspace holds many collections, one per corpus — the slug
 * names each one. Ingest (bundle upload) is a separate admin act on
 * `/api/v1/admin/knowledge`; this handler only creates/edits the container.
 *
 * The persistence mirrors {@link DatasourceFormInstallHandler}'s multi-instance
 * upsert (`ON CONFLICT (workspace_id, catalog_id, install_id)`), but:
 *   - `pillar='knowledge'` and there is NO credential / secret walker (the row
 *     carries none — connectors with credentials are a follow-up);
 *   - the row lands `status='published'`, not `draft`. The COLLECTION container
 *     is live immediately; the review gate lives on the DOCUMENTS
 *     (`knowledge_documents.status`), which always ingest as `draft`. (Knowledge
 *     installs are excluded from the content-mode `connections` promote path,
 *     which filters `pillar='datasource'`, so the container never needs
 *     publishing.)
 *
 * Re-installing an existing slug edits the container in place (and re-enables a
 * previously-uninstalled one) WITHOUT touching its documents — the install
 * itself never writes documents. An uninstall-archived collection's docs stay
 * `archived` until an ingest sees their paths again: an explicit re-upload
 * here, or (for `bundle-sync` collections) the next scheduled/manual sync
 * after re-install. Either way resurrection lands at `draft`, so ADR-0028 §5's
 * archive-over-hard-delete posture and the §4 review gate both hold.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import { FormInstallValidationError } from "./email-form-handler";
import {
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import { KNOWLEDGE_INSTALL_ID_FIELD, resolveCollectionSlug } from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

/** The built-in Knowledge Base (Upload) catalog slug + row id. */
export const OKF_UPLOAD_SLUG = "okf-upload";
export const OKF_UPLOAD_CATALOG_ID = "catalog:okf-upload";

/**
 * The multi-instance collection upsert (post-0092 shape). `install_id = $4` (the
 * collection slug, distinct from the row `id = $1`), `pillar='knowledge'`,
 * `status='published'` (the container is live; the review gate is on documents),
 * conflict target the composite PK. Exported so the real-Postgres test executes
 * this exact string against the live schema — the drift class mock tests miss.
 */
export const KNOWLEDGE_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface OkfUploadFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
}

export class OkfUploadFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly log = createLogger("integrations.install.okf-upload");

  constructor(options: OkfUploadFormInstallHandlerOptions = {}) {
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
      OKF_UPLOAD_SLUG,
    );
    const { [KNOWLEDGE_INSTALL_ID_FIELD]: _dropped, ...rest } = rawForm;

    // The only config field is an optional human description of the collection.
    // Reject a non-string description with a field-level 400 rather than
    // coercing it — it's the sole content of the container's config.
    const config: Record<string, unknown> = {};
    if (rest.description !== undefined && rest.description !== null) {
      if (typeof rest.description !== "string") {
        throw new FormInstallValidationError({
          fieldErrors: { description: ["Description must be a string."] },
          formErrors: [],
        });
      }
      const description = rest.description.trim();
      if (description !== "") config.description = description;
    }

    // Confirm the catalog row exists + is enabled so a seed misconfig surfaces as
    // a clear 500 (via the route's error mapper) rather than an opaque FK error
    // on the INSERT below.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [OKF_UPLOAD_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "okf-upload catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${OKF_UPLOAD_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // Slug not taken by another knowledge catalog (#4211), and the workspace's
    // plan tier has room for another collection (#4235) — both before the write.
    await assertCollectionInstallable(workspaceId, collectionSlug, catalogId, this.log);

    const candidateId = this.newId();
    let persistedId: string;
    try {
      persistedId = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug,
        sql: KNOWLEDGE_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, collectionSlug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge collection install — aborting install",
      );
      throw err;
    }

    this.log.info(
      { workspaceId, collectionSlug, rowId: persistedId },
      "Knowledge collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: OKF_UPLOAD_SLUG },
      credentialWritten: false,
    };
  }
}
