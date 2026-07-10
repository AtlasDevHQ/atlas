/**
 * `FrontFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `front` Knowledge Base catalog row (#4400, PRD #4395).
 *
 * Installing `front` creates one synced collection PER KNOWLEDGE BASE (the
 * PRD's "each KB maps to a collection"): the handler enumerates the company's
 * knowledge bases with the supplied Bearer token and upserts one
 * `pillar='knowledge'` `workspace_plugins` row per KB, each config pinned to
 * that KB's id. A single knowledge base (the common case) gets exactly the
 * chosen collection slug; multiple KBs fan out to `<slug>-<kb-slug>`. The
 * Scheduler dispatches the registered Front connector per collection on a
 * cadence (`lib/knowledge/connector-sync.ts`), and every synced article
 * translation lands `draft`.
 *
 * Beyond the Confluence/Zendesk precedent it inherits (loud credential
 * verification, token routed to `knowledge_sync_credentials` — never
 * `workspace_plugins.config`), two Front-specific choices:
 *
 *   1. **Fixed host, single Bearer token.** Front's Core API is a fixed vendor
 *      host, so there is no customer-supplied URL to SSRF-gate — every request
 *      still routes through `guardedFetch` at fetch time, and the host is
 *      re-asserted here as defence in depth.
 *   2. **Fan-out is validated fully before any write.** Every per-KB slug is
 *      availability-checked first; writes then run per KB (credential → row). A
 *      mid-fan-out failure leaves earlier KBs fully installed and working; the
 *      thrown error says retrying is safe (all writes are idempotent upserts
 *      converging on the same slugs).
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
import {
  listFrontKnowledgeBases,
  FrontAuthError,
  type FrontKnowledgeBase,
  type FrontClientDeps,
} from "@atlas/api/lib/knowledge/front/client";
import {
  FRONT_SLUG,
  FRONT_CATALOG_ID,
  FRONT_API_BASE,
  type FrontCollectionConfig,
} from "@atlas/api/lib/knowledge/front/config";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionSlugAvailable,
  resolveCollectionSlug,
  COLLECTION_SLUG_MAX,
  KNOWLEDGE_INSTALL_ID_FIELD,
} from "./okf-upload-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { FRONT_SLUG, FRONT_CATALOG_ID };

/** Defensive upper bound — guard against a pathological token paste. */
const API_TOKEN_MAX = 8192;

export interface FrontFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the KB-enumeration fetch (no real Front call). */
  readonly clientDeps?: FrontClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to
 * `ZENDESK_INSTALL_UPSERT_SQL`: `status='published'` because the COLLECTION
 * container is live immediately — the review gate is on the DOCUMENTS, which
 * always sync in as `draft`. Exported so the real-Postgres test executes this
 * exact string against the live schema.
 */
export const FRONT_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class FrontFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: FrontClientDeps;
  private readonly log = createLogger("integrations.install.front");

  constructor(options: FrontFormInstallHandlerOptions = {}) {
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

    const baseSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], FRONT_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const apiToken = validateApiToken(rawForm.api_token);
    const description = validateDescription(rawForm.description);

    // SSRF gate on the fixed Front host (defence in depth — `guardedFetch`
    // re-validates on every request).
    assertHostAllowed();

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [FRONT_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "front catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${FRONT_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // ── Enumerate KBs = verify the connection loudly BEFORE persisting ───────
    const bases = await this.enumerateKnowledgeBases(apiToken);
    if (bases.length === 0) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [
          "This Front account has no knowledge bases — create one in Front, then re-install.",
        ],
      });
    }

    // ── Compute + validate every per-KB slug BEFORE any write ────────────────
    const planned = bases.map((kb) => ({
      kb,
      slug: bases.length === 1 ? baseSlug : `${baseSlug}-${slugifyKnowledgeBaseId(kb.id)}`,
    }));
    for (const { slug } of planned) {
      if (slug.length > COLLECTION_SLUG_MAX) {
        throw new FormInstallValidationError({
          fieldErrors: {
            [KNOWLEDGE_INSTALL_ID_FIELD]: [
              `Collection id "${slug}" (the per-KB fan-out of "${baseSlug}") exceeds ${COLLECTION_SLUG_MAX} characters — choose a shorter collection id.`,
            ],
          },
          formErrors: [],
        });
      }
      await assertCollectionSlugAvailable(workspaceId, slug, catalogId);
    }

    // ── Per-KB writes: credential first, then the collection row ─────────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "api_token");
    let firstRecord: InstallRecord | null = null;
    for (const { kb, slug } of planned) {
      const record = await this.installKnowledgeBaseCollection({
        workspaceId,
        catalogId,
        slug,
        kb,
        config: {
          knowledge_base_id: kb.id,
          knowledge_base_name: kb.name,
          ...(description !== null ? { description } : {}),
        },
        apiToken,
      });
      firstRecord ??= record;
    }

    this.log.info(
      {
        workspaceId,
        host: hostForLog(FRONT_API_BASE),
        collections: planned.map((p) => p.slug),
        knowledgeBases: planned.length,
      },
      "Front collection install completed",
    );
    // `firstRecord` is set on the first loop iteration (planned is non-empty).
    if (firstRecord === null) {
      throw new Error("Front install produced no collection record — invariant violation");
    }
    return { installRecord: firstRecord, credentialWritten: true };
  }

  /** Write one KB's credential + collection row, Zendesk rollback posture. */
  private async installKnowledgeBaseCollection(input: {
    workspaceId: WorkspaceId;
    catalogId: string;
    slug: string;
    kb: FrontKnowledgeBase;
    config: FrontCollectionConfig;
    apiToken: string;
  }): Promise<InstallRecord> {
    const { workspaceId, catalogId, slug, kb, config, apiToken } = input;
    try {
      await saveSyncCredential(workspaceId, slug, apiToken);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install (retrying is safe; completed KB collections stay installed)",
      );
      throw retryableInstallError(slug, err);
    }

    const candidateId = this.newId();
    try {
      const rows = await internalQuery<{ id: string }>(FRONT_INSTALL_UPSERT_SQL, [
        candidateId,
        workspaceId,
        catalogId,
        slug,
        JSON.stringify(config),
      ]);
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        this.log.error(
          { workspaceId, candidateId, collectionSlug: slug },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      return { id: returned, workspaceId, catalogId: FRONT_SLUG };
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a
      // failed install. Best-effort — a re-install overwrites it either way; a
      // cleanup failure is logged, never masks the original error.
      //
      // Narrow re-install caveat (shared with the Zendesk/Confluence handlers):
      // when the row upsert is an ON-CONFLICT UPDATE of a PRE-EXISTING
      // collection, `saveSyncCredential` has already overwritten that live
      // collection's credential, so this rollback deletes a credential the
      // still-existing row depends on — leaving it credential-less until the
      // admin retries (the row upsert failing after the credential write is a
      // rare same-transaction-window DB error). Self-healing on retry, and kept
      // identical across the connector tier rather than diverging here.
      this.log.error(
        {
          workspaceId,
          collectionSlug: slug,
          knowledgeBaseId: kb.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to persist front collection install — rolling back the orphaned credential (retrying the install is safe)",
      );
      try {
        await deleteSyncCredential(workspaceId, slug);
      } catch (cleanupErr) {
        this.log.error(
          {
            workspaceId,
            collectionSlug: slug,
            err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          },
          "Failed to roll back the orphaned credential after an install-row failure — a re-install overwrites it",
        );
      }
      throw retryableInstallError(slug, err);
    }
  }

  /**
   * Enumerate knowledge bases with the supplied token; map every failure to a
   * 400. Classification is POSITIVE, by `instanceof` on the client's typed
   * errors — never by message text — so only a failure the client KNOWS is
   * credential-shaped blames the api_token field; a Front outage or transport
   * error stays form-level. All messages host-redacted by the client.
   */
  private async enumerateKnowledgeBases(apiToken: string): Promise<FrontKnowledgeBase[]> {
    try {
      return await listFrontKnowledgeBases({ apiToken }, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new FormInstallValidationError({
          fieldErrors: {},
          formErrors: [err.message],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof FrontAuthError) {
        throw new FormInstallValidationError({
          fieldErrors: { api_token: [message] },
          formErrors: [],
        });
      }
      // Everything else — 404 (FrontNotFoundError), 429 (ConnectorRateLimitError),
      // vendor 5xx, transport/DNS/non-JSON — is form-level (re-entering a fine
      // token would be the wrong guidance).
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [message],
      });
    }
  }
}

/**
 * Slugify a Front knowledge base id into a collection-slug-safe segment
 * (`[a-z0-9-]`). Front ids like `kb_abc123` map to `kb-abc123`; the
 * slug-availability check catches any genuine collision before a write.
 */
function slugifyKnowledgeBaseId(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "kb" : slug;
}

/** SSRF-gate the fixed Front host, mapping a block to a form-level 400. */
function assertHostAllowed(): void {
  try {
    assertBaseUrlAllowed(FRONT_API_BASE);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [err.message],
      });
    }
    throw err;
  }
}

function validateApiToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "api_token",
      "An API token is required. Create one in Front → Settings → Developers → API tokens with the knowledge_bases:read scope.",
    );
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

/**
 * Wrap a mid-fan-out persistence failure with the retry guidance the admin
 * needs: all writes are idempotent upserts converging on the same slugs, so
 * re-running the install is always safe. The original failure rides as cause.
 */
function retryableInstallError(slug: string, err: unknown): Error {
  return new Error(
    `Failed to install the "${slug}" collection: ${err instanceof Error ? err.message : String(err)}. Retrying the install is safe — already-installed KB collections are simply updated in place.`,
    { cause: err },
  );
}
