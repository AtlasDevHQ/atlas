/**
 * `FreshdeskFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `freshdesk` Knowledge Base catalog row (#4401, PRD #4395).
 *
 * Installing `freshdesk` creates one synced collection PER SOLUTIONS CATEGORY
 * (the PRD's "each product/portal maps to a collection" — a Freshdesk category
 * is the top-level Solutions grouping, portal-scoped in multi-product
 * accounts): the handler enumerates the account's categories with the supplied
 * API key and upserts one `pillar='knowledge'` `workspace_plugins` row per
 * category, each config pinned to that category's id + the account subdomain. A
 * single category (the common case) gets exactly the chosen collection slug;
 * multiple categories fan out to `<slug>-<category-slug>`. The Scheduler
 * dispatches the registered Freshdesk connector per collection on a cadence
 * (`lib/knowledge/connector-sync.ts`), and every synced article translation
 * lands `draft`.
 *
 * Beyond the Zendesk/Front precedent it inherits (loud credential verification,
 * key routed to `knowledge_sync_credentials` — never `workspace_plugins.config`),
 * two Freshdesk-specific choices:
 *
 *   1. **Hosts are composed, never pasted.** The admin supplies a SUBDOMAIN
 *      (a bare label; a pasted `acme.freshdesk.com` / full URL is reduced to
 *      its label), so every host is `https://<label>.freshdesk.com` by
 *      construction — then still egress-guard-checked at install and fetch.
 *   2. **Fan-out is validated fully before any write.** Every per-category slug
 *      is availability-checked first; writes then run per category
 *      (credential → row). A mid-fan-out failure leaves earlier categories
 *      fully installed and working; the thrown error says retrying is safe (all
 *      writes are idempotent upserts converging on the same slugs).
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
  listFreshdeskCategories,
  FreshdeskAuthError,
  FreshdeskNotFoundError,
  type FreshdeskCategory,
  type FreshdeskClientDeps,
} from "@atlas/api/lib/knowledge/freshdesk/client";
import {
  FRESHDESK_SLUG,
  FRESHDESK_CATALOG_ID,
  FRESHDESK_SUBDOMAIN_PATTERN,
  freshdeskHostFor,
  type FreshdeskCollectionConfig,
} from "@atlas/api/lib/knowledge/freshdesk/config";
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
export { FRESHDESK_SLUG, FRESHDESK_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const SUBDOMAIN_INPUT_MAX = 2048; // a pasted URL is allowed; the label is extracted
const SUBDOMAIN_LABEL_MAX = 63; // DNS label bound
const API_KEY_MAX = 4096;

export interface FreshdeskFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the category-enumeration fetch (no real Freshdesk call). */
  readonly clientDeps?: FreshdeskClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to
 * `ZENDESK_INSTALL_UPSERT_SQL`: `status='published'` because the COLLECTION
 * container is live immediately — the review gate is on the DOCUMENTS, which
 * always sync in as `draft`. Exported so the real-Postgres test executes this
 * exact string against the live schema.
 */
export const FRESHDESK_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class FreshdeskFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: FreshdeskClientDeps;
  private readonly log = createLogger("integrations.install.freshdesk");

  constructor(options: FreshdeskFormInstallHandlerOptions = {}) {
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

    const baseSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], FRESHDESK_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const subdomain = validateSubdomain(rawForm.subdomain);
    const apiKey = validateApiKey(rawForm.api_key);
    const description = validateDescription(rawForm.description);

    // SSRF gate on the composed account host (defence in depth — `*.freshdesk.com`
    // by construction; `guardedFetch` re-validates on every request).
    assertAccountHostAllowed(subdomain);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [FRESHDESK_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "freshdesk catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${FRESHDESK_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // ── Enumerate categories = verify the connection loudly BEFORE persisting ─
    const categories = await this.enumerateCategories({ subdomain, apiKey });
    if (categories.length === 0) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [
          `The Freshdesk account "${subdomain}" has no Solutions categories — create a category in Freshdesk, then re-install.`,
        ],
      });
    }

    // ── Compute + validate every per-category slug BEFORE any write ──────────
    const planned = categories.map((category) => ({
      category,
      slug: categories.length === 1 ? baseSlug : `${baseSlug}-${slugifyCategoryId(category.id)}`,
    }));
    for (const { slug } of planned) {
      if (slug.length > COLLECTION_SLUG_MAX) {
        throw new FormInstallValidationError({
          fieldErrors: {
            [KNOWLEDGE_INSTALL_ID_FIELD]: [
              `Collection id "${slug}" (the per-category fan-out of "${baseSlug}") exceeds ${COLLECTION_SLUG_MAX} characters — choose a shorter collection id.`,
            ],
          },
          formErrors: [],
        });
      }
      await assertCollectionSlugAvailable(workspaceId, slug, catalogId);
    }

    // ── Per-category writes: credential first, then the collection row ────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "api_key");
    let firstRecord: InstallRecord | null = null;
    for (const { category, slug } of planned) {
      const record = await this.installCategoryCollection({
        workspaceId,
        catalogId,
        slug,
        category,
        config: {
          subdomain,
          category_id: category.id,
          category_name: category.name,
          ...(description !== null ? { description } : {}),
        },
        apiKey,
      });
      firstRecord ??= record;
    }

    this.log.info(
      {
        workspaceId,
        accountHost: hostForLog(freshdeskHostFor(subdomain)),
        collections: planned.map((p) => p.slug),
        categories: planned.length,
      },
      "Freshdesk collection install completed",
    );
    // `firstRecord` is set on the first loop iteration (planned is non-empty).
    if (firstRecord === null) {
      throw new Error("Freshdesk install produced no collection record — invariant violation");
    }
    return { installRecord: firstRecord, credentialWritten: true };
  }

  /** Write one category's credential + collection row, Zendesk rollback posture. */
  private async installCategoryCollection(input: {
    workspaceId: WorkspaceId;
    catalogId: string;
    slug: string;
    category: FreshdeskCategory;
    config: FreshdeskCollectionConfig;
    apiKey: string;
  }): Promise<InstallRecord> {
    const { workspaceId, catalogId, slug, category, config, apiKey } = input;
    try {
      await saveSyncCredential(workspaceId, slug, apiKey);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install (retrying is safe; completed category collections stay installed)",
      );
      throw retryableInstallError(slug, err);
    }

    const candidateId = this.newId();
    try {
      const rows = await internalQuery<{ id: string }>(FRESHDESK_INSTALL_UPSERT_SQL, [
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
      return { id: returned, workspaceId, catalogId: FRESHDESK_SLUG };
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a
      // failed install. Best-effort — a re-install overwrites it either way; a
      // cleanup failure is logged, never masks the original error.
      //
      // Narrow re-install caveat (shared with the Zendesk/Front handlers): when
      // the row upsert is an ON-CONFLICT UPDATE of a PRE-EXISTING collection,
      // `saveSyncCredential` has already overwritten that live collection's
      // credential, so this rollback deletes a credential the still-existing row
      // depends on — leaving it credential-less until the admin retries (a rare
      // same-window DB error). Self-healing on retry, and kept identical across
      // the connector tier rather than diverging here.
      this.log.error(
        {
          workspaceId,
          collectionSlug: slug,
          categoryId: category.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to persist freshdesk collection install — rolling back the orphaned credential (retrying the install is safe)",
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
   * Enumerate categories with the supplied key; map every failure to a 400.
   * Classification is POSITIVE, by `instanceof` on the client's typed errors —
   * never by message text — so only a failure the client KNOWS is
   * credential-shaped blames the api_key field; a Freshdesk outage or transport
   * error stays form-level. All messages host-redacted by the client.
   */
  private async enumerateCategories(input: {
    subdomain: string;
    apiKey: string;
  }): Promise<FreshdeskCategory[]> {
    try {
      return await listFreshdeskCategories(input, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new FormInstallValidationError({
          fieldErrors: { subdomain: [err.message] },
          formErrors: [],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof FreshdeskAuthError) {
        throw new FormInstallValidationError({
          fieldErrors: { api_key: [message] },
          formErrors: [],
        });
      }
      if (err instanceof FreshdeskNotFoundError) {
        throw new FormInstallValidationError({
          fieldErrors: { subdomain: [message] },
          formErrors: [],
        });
      }
      // Everything else — 429 (ConnectorRateLimitError), vendor 5xx,
      // transport/DNS/non-JSON — is form-level (re-entering a fine key would be
      // the wrong guidance).
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [message],
      });
    }
  }
}

/**
 * Slugify a Freshdesk category id into a collection-slug-safe segment
 * (`[a-z0-9-]`). Freshdesk ids are numeric (`80000123` → `80000123`); the
 * slug-availability check catches any genuine collision before a write.
 */
function slugifyCategoryId(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "category" : slug;
}

/**
 * Validate the account subdomain: required, reduced to a bare label (a pasted
 * `acme.freshdesk.com` or full URL is accepted and reduced), bounded, matching
 * the DNS-label pattern the host is composed from.
 */
function validateSubdomain(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "subdomain",
      'The Freshdesk subdomain is required — the "acme" in acme.freshdesk.com (you can paste the full URL).',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > SUBDOMAIN_INPUT_MAX) {
    throw fieldError("subdomain", `The subdomain must be ${SUBDOMAIN_INPUT_MAX} characters or fewer.`);
  }
  let label = trimmed.toLowerCase();
  // Accept a pasted URL or host and reduce it to the leading label.
  label = label.replace(/^https?:\/\//, "");
  const freshdeskHost = /^([a-z0-9-]+)\.freshdesk\.com(?:[/:?#].*)?$/.exec(label);
  if (freshdeskHost) label = freshdeskHost[1];
  else label = label.split(/[/:?#]/, 1)[0];
  if (label.length > SUBDOMAIN_LABEL_MAX || !FRESHDESK_SUBDOMAIN_PATTERN.test(label)) {
    throw fieldError(
      "subdomain",
      'Enter the bare Freshdesk subdomain — the "acme" in acme.freshdesk.com (letters, digits, and dashes).',
    );
  }
  return label;
}

function validateApiKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "api_key",
      "An API key is required. Find it in Freshdesk → Profile settings → Your API Key.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > API_KEY_MAX) {
    throw fieldError("api_key", `The API key must be ${API_KEY_MAX} characters or fewer.`);
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

/** SSRF-gate the composed account host, mapping a block to a field-level 400. */
function assertAccountHostAllowed(subdomain: string): void {
  try {
    assertBaseUrlAllowed(freshdeskHostFor(subdomain));
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw new FormInstallValidationError({
        fieldErrors: { subdomain: [err.message] },
        formErrors: [],
      });
    }
    throw err;
  }
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
    `Failed to install the "${slug}" collection: ${err instanceof Error ? err.message : String(err)}. Retrying the install is safe — already-installed category collections are simply updated in place.`,
    { cause: err },
  );
}
