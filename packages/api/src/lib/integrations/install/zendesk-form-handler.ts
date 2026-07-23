/**
 * `ZendeskFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `zendesk` Knowledge Base catalog row (#4396, PRD #4395).
 *
 * Installing `zendesk` creates one synced collection PER help-center-enabled
 * BRAND (the PRD's "each brand maps to a collection"): the handler enumerates
 * the account's brands with the supplied credentials and upserts one
 * `pillar='knowledge'` `workspace_plugins` row per brand, each config pinned
 * to that brand's `*.zendesk.com` subdomain. A single INSTALLABLE brand (the
 * common case; installable = active + Help Center enabled + valid host label)
 * gets exactly the chosen collection slug; multiple installable brands fan
 * out to `<slug>-<brand-subdomain>`. The Scheduler dispatches the
 * registered Zendesk connector per collection on a cadence
 * (`lib/knowledge/connector-sync.ts`), and every synced article lands `draft`.
 *
 * Beyond the Confluence precedent it inherits (SSRF gate, loud credential
 * verification, token routed to `knowledge_sync_credentials` — never
 * `workspace_plugins.config`), two Zendesk-specific choices:
 *
 *   1. **Hosts are composed, never pasted.** The admin supplies a SUBDOMAIN
 *      (a bare label; a pasted `acme.zendesk.com` / full URL is reduced to
 *      its label), so every host is `https://<label>.zendesk.com` by
 *      construction — then still egress-guard-checked at install and fetch.
 *   2. **Fan-out is validated fully before any write.** Every per-brand slug
 *      is availability-checked first; writes then run per brand
 *      (credential → row). A mid-fan-out failure leaves earlier brands fully
 *      installed and working; the thrown error says retrying is safe (all
 *      writes are idempotent upserts converging on the same slugs). The one
 *      transition caveat: a single-brand install that later becomes
 *      multi-brand re-fans-out under suffixed slugs — the old base-slug
 *      collection stays behind and should be uninstalled by the admin.
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
  listZendeskBrands,
  ZendeskAuthError,
  ZendeskNotFoundError,
  type ZendeskBrand,
  type ZendeskClientDeps,
} from "@atlas/api/lib/knowledge/zendesk/client";
import {
  ZENDESK_SLUG,
  ZENDESK_CATALOG_ID,
  ZENDESK_SUBDOMAIN_PATTERN,
  zendeskHostFor,
  type ZendeskCollectionConfig,
} from "@atlas/api/lib/knowledge/zendesk/config";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionBatchInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import { isPlanDenial, retryableInstallError } from "./retryable-install-error";
import {
  COLLECTION_SLUG_MAX,
  KNOWLEDGE_INSTALL_ID_FIELD,
  resolveCollectionSlug,
} from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { ZENDESK_SLUG, ZENDESK_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const SUBDOMAIN_INPUT_MAX = 2048; // a pasted URL is allowed; the label is extracted
const SUBDOMAIN_LABEL_MAX = 63; // DNS label bound
const EMAIL_MAX = 320;
const API_TOKEN_MAX = 4096;

export interface ZendeskFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the brand-enumeration fetch (no real Zendesk call). */
  readonly clientDeps?: ZendeskClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to
 * `CONFLUENCE_INSTALL_UPSERT_SQL`: `status='published'` because the COLLECTION
 * container is live immediately — the review gate is on the DOCUMENTS, which
 * always sync in as `draft`. Exported so the real-Postgres test executes this
 * exact string against the live schema.
 */
export const ZENDESK_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class ZendeskFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: ZendeskClientDeps;
  private readonly log = createLogger("integrations.install.zendesk");

  constructor(options: ZendeskFormInstallHandlerOptions = {}) {
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

    const baseSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], ZENDESK_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const subdomain = validateSubdomain(rawForm.subdomain);
    const email = validateEmail(rawForm.email);
    const apiToken = validateApiToken(rawForm.api_token);
    const description = validateDescription(rawForm.description);

    // SSRF gate on the composed account host (defence in depth — `*.zendesk.com`
    // by construction; `guardedFetch` re-validates on every request).
    assertAccountHostAllowed(subdomain);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [ZENDESK_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "zendesk catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${ZENDESK_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // ── Enumerate brands = verify the connection loudly BEFORE persisting ────
    const brands = await this.enumerateBrands({ subdomain, email, apiToken });
    // Brand subdomains come from vendor JSON: same label validation as the
    // admin-supplied one (pattern + DNS-label bound) before a host is composed.
    const validLabel = (b: ZendeskBrand) =>
      b.subdomain.length <= SUBDOMAIN_LABEL_MAX && ZENDESK_SUBDOMAIN_PATTERN.test(b.subdomain);
    const installable = brands.filter((b) => b.active && b.hasHelpCenter && validLabel(b));
    const skippedBadSubdomain = brands.filter((b) => b.active && b.hasHelpCenter && !validLabel(b));
    if (skippedBadSubdomain.length > 0) {
      // Never silent: a brand whose subdomain fails the host-label pattern
      // cannot get a composed host, so it cannot be installed.
      this.log.warn(
        { workspaceId, skipped: skippedBadSubdomain.map((b) => b.id) },
        "Skipped Zendesk brands with non-label subdomains — cannot compose their help-center host",
      );
    }
    if (installable.length === 0) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [
          `The Zendesk account "${subdomain}" has no active brand with a Help Center enabled — activate a Guide help center, then re-install.`,
        ],
      });
    }

    // ── Compute + validate every per-brand slug BEFORE any write ─────────────
    const planned = installable.map((brand) => ({
      brand,
      slug: installable.length === 1 ? baseSlug : `${baseSlug}-${brand.subdomain}`,
    }));
    for (const { slug } of planned) {
      if (slug.length > COLLECTION_SLUG_MAX) {
        throw new FormInstallValidationError({
          fieldErrors: {
            [KNOWLEDGE_INSTALL_ID_FIELD]: [
              `Collection id "${slug}" (the per-brand fan-out of "${baseSlug}") exceeds ${COLLECTION_SLUG_MAX} characters — choose a shorter collection id.`,
            ],
          },
          formErrors: [],
        });
      }
    }
    // ONE cap check for the WHOLE fan-out, before any credential or row is
    // written: a per-slug loop would pass N times against the same pre-write
    // count and strand a partial install when the atomic gate refused the
    // (cap+1)-th mid-batch (#4235).
    await assertCollectionBatchInstallable(
      workspaceId,
      planned.map((p) => p.slug),
      catalogId,
      this.log,
    );

    // ── Per-brand writes: credential first, then the collection row ──────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "api_token");
    let firstRecord: InstallRecord | null = null;
    for (const { brand, slug } of planned) {
      const record = await this.installBrandCollection({
        workspaceId,
        catalogId,
        slug,
        brand,
        config: {
          subdomain,
          email,
          brand_id: brand.id,
          brand_subdomain: brand.subdomain,
          brand_name: brand.name,
          ...(description !== null ? { description } : {}),
        },
        apiToken,
      });
      firstRecord ??= record;
    }

    this.log.info(
      {
        workspaceId,
        accountHost: hostForLog(zendeskHostFor(subdomain)),
        collections: planned.map((p) => p.slug),
        brands: planned.length,
      },
      "Zendesk collection install completed",
    );
    // `firstRecord` is set on the first loop iteration (planned is non-empty).
    if (firstRecord === null) {
      throw new Error("Zendesk install produced no collection record — invariant violation");
    }
    return { installRecord: firstRecord, credentialWritten: true };
  }

  /** Write one brand's credential + collection row, Confluence rollback posture. */
  private async installBrandCollection(input: {
    workspaceId: WorkspaceId;
    catalogId: string;
    slug: string;
    brand: ZendeskBrand;
    config: ZendeskCollectionConfig;
    apiToken: string;
  }): Promise<InstallRecord> {
    const { workspaceId, catalogId, slug, brand, config, apiToken } = input;
    try {
      await saveSyncCredential(workspaceId, slug, apiToken);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install (retrying is safe; completed brand collections stay installed)",
      );
      throw retryableInstallError(slug, err, "brand");
    }

    const candidateId = this.newId();
    try {
      const returned = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: slug,
        sql: ZENDESK_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, slug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
      return { id: returned, workspaceId, catalogId: ZENDESK_SLUG };
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a
      // failed install (this brand's install row never landed, so uninstall
      // would never reach it). Best-effort — a re-install overwrites it either
      // way; a cleanup failure is logged, never masks the original error.
      this.log.error(
        {
          workspaceId,
          collectionSlug: slug,
          brandId: brand.id,
          err: err instanceof Error ? err.message : String(err),
        },
        isPlanDenial(err)
          ? "Failed to persist zendesk collection install — rolling back the orphaned credential (the workspace is at a plan limit — retrying will not help)"
          : "Failed to persist zendesk collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      throw retryableInstallError(slug, err, "brand");
    }
  }

  /**
   * Enumerate brands with the supplied creds; map every failure to a 400.
   * Classification is POSITIVE, by `instanceof` on the client's typed errors —
   * never by message text or `cause`-presence sniffing — so only a failure the
   * client KNOWS is credential-shaped blames the api_token field; a Zendesk
   * outage or transport error stays form-level (re-entering a fine token
   * would be the wrong guidance). All messages host-redacted by the client.
   */
  private async enumerateBrands(input: {
    subdomain: string;
    email: string;
    apiToken: string;
  }): Promise<ZendeskBrand[]> {
    try {
      return await listZendeskBrands(input, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new FormInstallValidationError({
          fieldErrors: { subdomain: [err.message] },
          formErrors: [],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ZendeskAuthError) {
        throw new FormInstallValidationError({
          fieldErrors: { api_token: [message] },
          formErrors: [],
        });
      }
      if (err instanceof ZendeskNotFoundError) {
        throw new FormInstallValidationError({
          fieldErrors: { subdomain: [message] },
          formErrors: [],
        });
      }
      // Everything else — 429 (ConnectorRateLimitError), vendor 5xx,
      // transport/DNS/non-JSON — is form-level.
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [message],
      });
    }
  }
}

/**
 * Validate the account subdomain: required, reduced to a bare label (a pasted
 * `acme.zendesk.com` or full URL is accepted and reduced), bounded, matching
 * the DNS-label pattern the host is composed from.
 */
function validateSubdomain(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "subdomain",
      'The Zendesk subdomain is required — the "acme" in acme.zendesk.com (you can paste the full URL).',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > SUBDOMAIN_INPUT_MAX) {
    throw fieldError("subdomain", `The subdomain must be ${SUBDOMAIN_INPUT_MAX} characters or fewer.`);
  }
  let label = trimmed.toLowerCase();
  // Accept a pasted URL or host and reduce it to the leading label.
  label = label.replace(/^https?:\/\//, "");
  const zendeskHost = /^([a-z0-9-]+)\.zendesk\.com(?:[/:?#].*)?$/.exec(label);
  if (zendeskHost) label = zendeskHost[1];
  else label = label.split(/[/:?#]/, 1)[0];
  if (label.length > SUBDOMAIN_LABEL_MAX || !ZENDESK_SUBDOMAIN_PATTERN.test(label)) {
    throw fieldError(
      "subdomain",
      'Enter the bare Zendesk subdomain — the "acme" in acme.zendesk.com (letters, digits, and dashes).',
    );
  }
  return label;
}

/** SSRF-gate the composed account host, mapping a block to a field-level 400. */
function assertAccountHostAllowed(subdomain: string): void {
  try {
    assertBaseUrlAllowed(zendeskHostFor(subdomain));
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

function validateEmail(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError("email", "The Zendesk account email is required.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > EMAIL_MAX) {
    throw fieldError("email", `The email must be ${EMAIL_MAX} characters or fewer.`);
  }
  if (!trimmed.includes("@")) {
    throw fieldError("email", "Enter a valid Zendesk account email.");
  }
  return trimmed;
}

function validateApiToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "api_token",
      "An API token is required. Create one in Admin Center → Apps and integrations → Zendesk API.",
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
