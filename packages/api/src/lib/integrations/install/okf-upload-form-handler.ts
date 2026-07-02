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
 * previously-uninstalled one) WITHOUT touching its documents — an
 * uninstall-archived collection's docs stay `archived` until an explicit
 * re-ingest, never silently resurrected (ADR-0028 §5).
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import { FormInstallValidationError } from "./email-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

/** The built-in Knowledge Base (Upload) catalog slug + row id. */
export const OKF_UPLOAD_SLUG = "okf-upload";
export const OKF_UPLOAD_CATALOG_ID = "catalog:okf-upload";

/**
 * Reserved form key carrying the collection slug (= `install_id`). Same wire key
 * the datasource install modal uses (`__install_id__`), so the shared web
 * install form drives collection creation with no new field. Stripped from the
 * persisted config. When omitted, the first collection defaults to the catalog
 * slug (`okf-upload`), matching the datasource single-instance default.
 */
export const KNOWLEDGE_INSTALL_ID_FIELD = "__install_id__";

/** Max collection-slug length — generous, bounded so a paste can't bloat the row key. */
export const COLLECTION_SLUG_MAX = 128;

/**
 * A collection slug becomes the `install_id` (row key), the `collection_id` on
 * every document, and the URL path segment of the ingest endpoint — so restrict
 * it to the same URL-safe id alphabet a connection id uses (letters, digits,
 * `.`, `-`, `_`), rejecting slashes/whitespace/delimiters.
 */
const COLLECTION_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

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

    // A slug taken by another knowledge catalog (bundle-sync) would merge
    // document trees — reject before the upsert (#4211).
    await assertCollectionSlugAvailable(workspaceId, collectionSlug, catalogId);

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(KNOWLEDGE_INSTALL_UPSERT_SQL, [
        candidateId,
        workspaceId,
        catalogId,
        collectionSlug,
        JSON.stringify(config),
      ]);
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // INSERT ... ON CONFLICT ... DO UPDATE RETURNING emits exactly one row on
        // both paths; an empty result is a driver/RLS/query-rewrite anomaly.
        // Returning candidateId would be WRONG on the conflict path (the row keeps
        // its existing id). Fail loud.
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

/**
 * Reject a collection slug already used by a DIFFERENT knowledge catalog in
 * this workspace (#4211 — the guard became necessary the moment a second
 * knowledge catalog row, `bundle-sync`, existed). `knowledge_documents` keys
 * on `(workspace_id, collection_id, path)` with NO catalog dimension, so two
 * catalogs sharing an `install_id` would silently merge their document trees
 * — and a bundle-sync's archive-absent pass would archive the other
 * collection's docs. Archived installs count too: their documents still live
 * under the slug and an explicit re-ingest may resurrect them (ADR-0028 §5).
 *
 * Shared by both knowledge form handlers ({@link OkfUploadFormInstallHandler}
 * and `BundleSyncFormInstallHandler`); each passes its own catalog id.
 */
export async function assertCollectionSlugAvailable(
  workspaceId: WorkspaceId,
  collectionSlug: string,
  ownCatalogId: string,
): Promise<void> {
  const rows = await internalQuery<{ catalog_id: string }>(
    `SELECT catalog_id
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'
        AND catalog_id <> $3
      LIMIT 1`,
    [workspaceId, collectionSlug, ownCatalogId],
  );
  if (rows.length > 0) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [
          `Collection id "${collectionSlug}" is already used by another Knowledge Base integration in this workspace.`,
        ],
      },
      formErrors: [],
    });
  }
}

/**
 * Resolve the collection slug from the reserved form value, defaulting to
 * `defaultSlug` when omitted/blank. A supplied slug is trimmed and validated
 * against {@link COLLECTION_SLUG_PATTERN} — an invalid one is a field-level 400
 * (it becomes the row key, document `collection_id`, and URL segment), never
 * silently coerced.
 */
export function resolveCollectionSlug(raw: unknown, defaultSlug: string): string {
  if (raw === undefined || raw === null) return defaultSlug;
  if (typeof raw !== "string") {
    throw new FormInstallValidationError({
      fieldErrors: { [KNOWLEDGE_INSTALL_ID_FIELD]: ["Collection id must be a string."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return defaultSlug;
  if (trimmed.length > COLLECTION_SLUG_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [`Collection id must be ${COLLECTION_SLUG_MAX} characters or fewer.`],
      },
      formErrors: [],
    });
  }
  if (!COLLECTION_SLUG_PATTERN.test(trimmed)) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [
          "Collection id may contain only letters, digits, dots, dashes, and underscores.",
        ],
      },
      formErrors: [],
    });
  }
  return trimmed;
}
